// The page side of the game's file store (opfs-worker.js), shared by the launcher and
// the game page.
let worker = null;
let nextId = 1;
const waiting = new Map();

function call(op, payload = {}, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL('./opfs-worker.js', import.meta.url), {type: 'module', name: 'opfs'});
    worker.onmessage = ({data}) => {
      const pending = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.ok) pending?.resolve(data.result);
      else pending?.reject(new Error(data.error));
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, {resolve, reject});
    worker.postMessage({id, op, ...payload}, transfer);
  });
}

export const opfsSupported = () => typeof navigator.storage?.getDirectory === 'function';

/** Stores a picked file where the game scans for packs (`resourcepacks/`, `shaderpacks/`). */
export async function importPack(kind, file) {
  const folder = {resourcepack: 'resourcepacks', shaderpack: 'shaderpacks'}[kind];
  const name = file.name.split(/[\\/]/).pop().trim();
  if (!folder || !name || name === '.' || name === '..') throw new Error('invalid pack');
  const buffer = await file.arrayBuffer();
  return call('put', {path: `${folder}/${name}`, buffer}, [buffer]);
}

/** Text of a stored file, or null. */
async function readText(path) {
  const buffer = await call('get', {path});
  return buffer ? new TextDecoder().decode(buffer) : null;
}
function writeText(path, text) {
  const buffer = new TextEncoder().encode(text).buffer;
  return call('put', {path, buffer}, [buffer]);
}

/** Deletes an imported pack from `resourcepacks/` or `shaderpacks/`. */
export function removePack(folder, name) {
  if (!['resourcepacks', 'shaderpacks'].includes(folder) || !name || name.includes('/') || name === '.' || name === '..') throw new Error('invalid pack');
  return call('remove', {path: `${folder}/${name}`, tree: true});
}

/** Deletes a world folder from `saves/`. */
export function removeWorld(name) {
  if (!name || name.includes('/') || name === '.' || name === '..') throw new Error('invalid world');
  return call('remove', {path: `saves/${name}`, tree: true});
}

/**
 * Turns an imported pack on for the next launch, as the game's pack screens would:
 * a resource pack goes on top of `resourcePacks` in options.txt, a shader pack becomes
 * `pickedShaderPack` in horizon-graphics.txt.
 */
export async function enablePack(kind, fileName) {
  const name = fileName.split(/[\\/]/).pop().trim();
  if (kind === 'resourcepack') {
    const text = await readText('options.txt') ?? '';
    const lines = text.split('\n').filter(line => line !== '');
    const at = lines.findIndex(line => line.startsWith('resourcePacks:'));
    let packs = ['vanilla'];
    if (at >= 0) { try { packs = JSON.parse(lines[at].slice('resourcePacks:'.length)); } catch (_) {} }
    const id = `file/${name}`;
    packs = [...packs.filter(p => p !== id), id];
    const line = `resourcePacks:${JSON.stringify(packs)}`;
    if (at >= 0) lines[at] = line; else lines.push(line);
    return writeText('options.txt', lines.join('\n') + '\n');
  }
  if (kind === 'shaderpack') {
    const text = await readText('horizon-graphics.txt') ?? '';
    const lines = text.split('\n').filter(line => line !== '' && !line.startsWith('pickedShaderPack:'));
    lines.push(`pickedShaderPack:${name}`);
    return writeText('horizon-graphics.txt', lines.join('\n') + '\n');
  }
}

/** Deletes every stored world, option and pack. */
export const clearAll = () => call('clear');

export async function usage() {
  try {
    const {usage = 0, quota = 0, usageDetails = {}} = await navigator.storage.estimate();
    return {usage, quota, details: usageDetails};
  } catch (_) { return {usage: 0, quota: 0, details: {}}; }
}

/**
 * Reads the stored files and exposes them to Rust, which takes them one at a time at
 * start-up (game/browser.rs restore_session_files).
 */
export async function restoreForGame(log) {
  navigator.storage?.persist?.().then(ok => log('HOST', `persistent storage=${ok}`));
  const entries = await call('load');
  let bytes = 0;
  let stored = 0, storedBytes = 0;
  for (const [, data] of entries) {
    if (typeof data === 'number') { stored++; storedBytes += data; } else bytes += data?.byteLength ?? 0;
  }
  log('HOST', `OPFS: ${entries.length} entries, ${(bytes / 1048576).toFixed(1)} MiB read; ${stored} region files (${(storedBytes / 1048576).toFixed(1)} MiB) read when used`);
  // Where the files are, by their first three path parts: the start-up time follows the
  // file count, not the bytes.
  const folders = new Map();
  for (const [path, data] of entries) {
    if (!data) continue;
    const key = path.split('/').slice(0, 3).join('/');
    const [count = 0, size = 0] = folders.get(key) ?? [];
    folders.set(key, [count + 1, size + (typeof data === 'number' ? data : data.byteLength)]);
  }
  const top = [...folders].sort((a, b) => b[1][0] - a[1][0]).slice(0, 12);
  log('HOST', `OPFS files by folder: ${top.map(([key, [count, size]]) => `${key} ${count} (${(size / 1048576).toFixed(1)} MiB)`).join(', ')}`);
  globalThis.horizonSessionFileCount = () => entries.length;
  globalThis.horizonSessionFileName = i => entries[i]?.[0];
  globalThis.horizonSessionFileTake = i => {
    const data = entries[i]?.[1];
    if (entries[i]) entries[i][1] = undefined;
    return data && typeof data === 'object' ? new Uint8Array(data) : undefined;
  };
  // Region files are not read at the start: only their size (the game reads them back
  // through opfs-worker.js when it uses them).
  globalThis.horizonSessionFileStored = i => (typeof entries[i]?.[1] === 'number' ? entries[i][1] : -1);
  // The engine also asks for an older store's snapshot: there is none.
  globalThis.horizonTakeSession = () => undefined;
  globalThis.horizonTakeSessionSettings = () => undefined;
}

/**
 * Moves the game's journaled changes to OPFS: small batches while playing, everything
 * when the page hides. Returns flush(), which resolves once all changes are written.
 */
export function startPersistence(wasm, log, {intervalMs = 1000, batchBytes = 8 << 20, memory = null} = {}) {
  let busy = null;
  // The file Worker answers the game's requests to read a region file back.
  if (memory && wasm.horizon_session_read_channel) {
    call('attach', {memory, address: wasm.horizon_session_read_channel()})
      .catch(error => log('WARN', `OPFS read-back unavailable: ${error.message}`));
  }
  const drainAll = async () => {
    let total = 0;
    for (;;) {
      if (!wasm.horizon_session_pending()) break;
      const batch = wasm.horizon_session_drain(batchBytes);
      const seq = wasm.horizon_session_drained?.();
      try {
        total += await call('apply', {buffer: batch.buffer}, [batch.buffer]);
      } catch (error) {
        // Whatever it held may be missing from OPFS: nothing leaves memory any more.
        wasm.horizon_session_store_failed?.();
        throw error;
      }
      // Stored: the files it held may leave the game's memory.
      if (seq !== undefined) wasm.horizon_session_applied(seq);
      if (batch[8] !== 1 && !wasm.horizon_session_pending()) break;
      await new Promise(r => setTimeout(r, 0));
    }
    if (total >= 1 << 20) log('HOST', `OPFS: wrote ${(total / 1048576).toFixed(1)} MiB`);
  };
  const flush = () => busy ??= drainAll()
    .catch(error => log('WARN', `OPFS write failed: ${error.message}`))
    .finally(() => { busy = null; });
  setInterval(flush, intervalMs);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  addEventListener('pagehide', flush);
  return flush;
}
