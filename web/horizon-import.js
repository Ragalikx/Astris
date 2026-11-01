// The game's resources come from the player's own Horizon install: the folder its launcher
// prepared (`<version>/.local/horizon-client/26.3`, with `horizon-resources.json`). It is
// read once and kept in OPFS as the two bundles the engine mounts (`menu` = assets/
// without sounds, `world` = everything else) and, if wanted, the sounds as the bundle
// sounds.js lists. The folder can be deleted after.
const DIR = 'astris-resources';
const SOUNDS_DIR = 'astris-sounds';
const DONE = '.complete';
export const SCHEMA = 7;
export const MINECRAFT = '26.3';
const MANIFEST = 'horizon-resources.json';

const top = () => navigator.storage.getDirectory();

/** What was imported ({minecraft, schema, dataVersion, files, bytes, sounds, importedAt}), or null. */
export async function installed() {
  try {
    const file = await (await (await top()).getDirectoryHandle(DIR)).getFileHandle(DONE);
    return JSON.parse(await (await file.getFile()).text());
  } catch (_) { return null; }
}

/** The stored `menu` or `world` bundle, as a File (read lazily), or null. */
export async function bundle(kind) {
  if (!await installed()) return null;
  try {
    const dir = await (await top()).getDirectoryHandle(DIR);
    return await (await dir.getFileHandle(`${kind}-resources.bin`)).getFile();
  } catch (_) { return null; }
}

export async function remove() {
  const root = await top();
  for (const name of [DIR, SOUNDS_DIR]) {
    // A file still open for writing (a failed import in this or another tab) locks the folder
    // for a moment after it is let go, so a locked folder is tried again before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        await root.removeEntry(name, {recursive: true});
        break;
      } catch (error) {
        if (error.name === 'NotFoundError') break;
        if (error.name !== 'NoModificationAllowedError' || attempt === 6) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
  }
}

// What the browser says it keeps for this site, for the import log.
async function storageLine() {
  try {
    const {usage = 0, quota = 0, usageDetails = {}} = await navigator.storage.estimate();
    const mib = n => `${(n / 1048576).toFixed(0)} MiB`;
    const details = Object.entries(usageDetails).map(([kind, n]) => `${kind} ${mib(n)}`).join(', ');
    return `browser storage: ${mib(usage)} used of ${mib(quota)}${details ? ` (${details})` : ''}`;
  } catch (_) { return 'browser storage: unknown'; }
}

export const pickSupported = () => typeof window.showDirectoryPicker === 'function';

/**
 * A prepared folder shared over the network by tools/astris-share.py: its file list
 * (/__astris.json, [path, size] pairs) as the same tree `fromFileList` makes, with files
 * that are downloaded only when copied (in `writeBundle`, a batch at a time).
 */
export async function fromNetwork(address, log) {
  const given = new URL(address.trim());
  if (!/^https?:$/.test(given.protocol)) throw new Error(`${given.protocol} is not http or https`);
  // A link to a ZIP of the prepared folder: downloaded whole, then read like a picked one.
  if (/\.zip$/i.test(given.pathname)) {
    log?.(`downloading ${given.href}…`);
    const answer = await fetch(given, {cache: 'no-store'});
    if (!answer.ok) throw new Error(`${given.href}: HTTP ${answer.status}`);
    const announced = Number(answer.headers.get('Content-Length'));
    if (announced > MAX_TOTAL) throw new Error(`${given.href}: ${(announced / 1048576).toFixed(0)} MiB, at most ${MAX_TOTAL / 1048576} MiB`);
    const zip = announced > 0 ? await answer.blob() : await limitedBlob(answer.body, MAX_TOTAL, given.href);
    if (zip.size > MAX_TOTAL) throw new Error(`${given.href}: larger than ${MAX_TOTAL / 1048576} MiB`);
    log?.(`downloaded ${(zip.size / 1048576).toFixed(1)} MiB`);
    return fromZip(zip, given.pathname.split('/').pop());
  }
  const base = new URL(given.href.replace(/\/*$/, '/'));
  const answer = await fetch(new URL('__astris.json', base), {cache: 'no-store'});
  if (!answer.ok) throw new Error(`${new URL('__astris.json', base)}: HTTP ${answer.status}`);
  const raw = await answer.json();
  if (!Array.isArray(raw)) throw new Error('__astris.json is not a list');
  const list = raw.filter(item => Array.isArray(item)
    && typeof item[0] === 'string' && Number.isSafeInteger(item[1]) && item[1] >= 0 && safePath(item[0]));
  checkedList(list.map(([path, size]) => ({path, size})), base.href);
  const files = list.map(([path, size]) => remoteFile(new URL(path.split('/').map(hidden).join('/'), base), path, size));
  return treeOf(files, base.host);
}

// Ad blockers match words in URLs: Brave drops blockstates/beacon.json as a tracking
// beacon. Each name's first letter goes percent-encoded, which servers decode as usual
// but filter lists don't see through.
const hidden = name => !name || name.charCodeAt(0) > 0x7e ? encodeURIComponent(name) : `%${name.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}${encodeURIComponent(name.slice(1))}`;

// A file on the network: its size is known from the list, its bytes are fetched on use.
function remoteFile(url, path, size) {
  const once = async () => {
    const answer = await fetch(url, {cache: 'no-store'});
    if (!answer.ok) throw Object.assign(new Error(`${path}: HTTP ${answer.status}`), {retry: answer.status >= 500 || answer.status === 429});
    // An announced length the list agrees with bounds the body already (the browser takes
    // no more than it); without one the bytes are counted as they come.
    const announced = answer.headers.get('Content-Length');
    const data = announced !== null && Number(announced) === size ? await answer.blob() : await limitedBlob(answer.body, size, path);
    if (data.size !== size) throw new Error(`${path}: ${data.size} bytes received, ${size} listed`);
    return data;
  };
  // Tunnels and home connections drop a request now and then; one lost file
  // should not end an import of tens of thousands.
  const blob = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once();
      } catch (error) {
        const network = error instanceof TypeError || error?.retry;
        if (!network) throw error;
        if (attempt === 5) throw new Error(`${path}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  };
  return {
    lazy: true, size, webkitRelativePath: `remote/${path}`, blob,
    text: async () => (await blob()).text(),
    arrayBuffer: async () => (await blob()).arrayBuffer(),
    slice: (start, end) => ({arrayBuffer: async () => (await blob()).slice(start, end).arrayBuffer()}),
  };
}

const safePath = path => !path.split('/').some(part => part === '..' || part === '.' || part === '');

// What a source may hand over in all: the prepared folder is about 600 MiB, so this leaves
// room for later versions while a broken source cannot fill the disk.
const MAX_TOTAL = 4 * 1024 ** 3;

/** A stream read into a Blob, stopped as soon as it passes `limit` bytes. */
async function limitedBlob(stream, limit, label) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw new Error(`${label}: more than the ${limit} bytes expected`);
    }
    chunks.push(value);
  }
  return new Blob(chunks);
}

function checkedList(entries, label) {
  let total = 0;
  for (const {size} of entries) total += size;
  if (total > MAX_TOTAL) throw new Error(`${label}: ${(total / 1048576).toFixed(0)} MiB, at most ${MAX_TOTAL / 1048576} MiB`);
}

/**
 * A ZIP of the prepared folder (picked, or downloaded), as the same tree: its directory is
 * read at once, each file only when copied (stored, or deflated through the browser's own
 * DecompressionStream). ZIP64 archives work too.
 */
export async function fromZip(zip, name = 'archive.zip') {
  const entries = (await zipEntries(zip)).filter(e => safePath(e.name));
  checkedList(entries.map(e => ({path: e.name, size: e.length})), name);
  const files = entries.map(entry => zipFile(zip, entry));
  return treeOf(files, name);
}

async function zipEntries(zip) {
  const tailLength = Math.min(zip.size, 65557);
  const tail = new DataView(await zip.slice(zip.size - tailLength).arrayBuffer());
  let end = -1;
  for (let i = tailLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a ZIP file');
  let count = tail.getUint16(end + 10, true), size = tail.getUint32(end + 12, true), offset = tail.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || tail.getUint32(locator, true) !== 0x07064b50) throw new Error('ZIP64 archive without its locator');
    const at = Number(tail.getBigUint64(locator + 8, true));
    const zip64 = new DataView(await zip.slice(at, at + 56).arrayBuffer());
    count = Number(zip64.getBigUint64(32, true));
    size = Number(zip64.getBigUint64(40, true));
    offset = Number(zip64.getBigUint64(48, true));
  }
  if (offset + size > zip.size) throw new Error('ZIP directory out of bounds');
  const dir = new DataView(await zip.slice(offset, offset + size).arrayBuffer());
  const names = new TextDecoder();
  const out = [];
  for (let i = 0, p = 0; i < count; i++) {
    if (dir.getUint32(p, true) !== 0x02014b50) throw new Error('damaged ZIP directory');
    const method = dir.getUint16(p + 10, true);
    let packed = dir.getUint32(p + 20, true), length = dir.getUint32(p + 24, true), local = dir.getUint32(p + 42, true);
    const nameLength = dir.getUint16(p + 28, true), extraLength = dir.getUint16(p + 30, true), commentLength = dir.getUint16(p + 32, true);
    const name = names.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength)).replaceAll('\\', '/');
    // ZIP64 sizes and offset, in the order the fields overflowed.
    for (let x = p + 46 + nameLength, stop = x + extraLength; x + 4 <= stop;) {
      const id = dir.getUint16(x, true), fieldLength = dir.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (length === 0xffffffff) { length = Number(dir.getBigUint64(q, true)); q += 8; }
        if (packed === 0xffffffff) { packed = Number(dir.getBigUint64(q, true)); q += 8; }
        if (local === 0xffffffff) { local = Number(dir.getBigUint64(q, true)); }
      }
      x += 4 + fieldLength;
    }
    p += 46 + nameLength + extraLength + commentLength;
    if (local + packed > zip.size) throw new Error(`${name}: outside the archive`);
    if (!name.endsWith('/')) out.push({name, method, packed, length, local});
  }
  return out;
}

function zipFile(zip, entry) {
  const blob = async () => {
    const header = new DataView(await zip.slice(entry.local, entry.local + 30).arrayBuffer());
    if (header.getUint32(0, true) !== 0x04034b50) throw new Error(`${entry.name}: damaged ZIP entry`);
    const start = entry.local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const raw = zip.slice(start, start + entry.packed);
    let data;
    if (entry.method === 0) data = raw;
    // Inflated only up to the size the directory declares: a ZIP bomb stops there.
    else if (entry.method === 8) data = await limitedBlob(raw.stream().pipeThrough(new DecompressionStream('deflate-raw')), entry.length, entry.name);
    else throw new Error(`${entry.name}: ZIP method ${entry.method} is not supported (stored or deflate only)`);
    if (data.size !== entry.length) throw new Error(`${entry.name}: ${data.size} bytes unpacked, ${entry.length} expected`);
    return data;
  };
  return {
    lazy: true, size: entry.length, webkitRelativePath: `zip/${entry.name}`, blob,
    text: async () => (await blob()).text(),
    arrayBuffer: async () => (await blob()).arrayBuffer(),
    slice: (start, end) => ({arrayBuffer: async () => (await blob()).slice(start, end).arrayBuffer()}),
  };
}

/**
 * A folder picked with `<input webkitdirectory>` (Brave and Firefox have no
 * showDirectoryPicker), as a tree with the directory-handle calls `locate` and
 * `importFrom` use. The Files read lazily, so nothing is loaded until copied.
 */
export function fromFileList(fileList) {
  return treeOf(fileList, fileList[0]?.webkitRelativePath.split('/')[0] ?? '');
}

function treeOf(fileList, rootName) {
  const node = name => ({
    kind: 'directory', name, children: new Map(),
    async *entries() { yield* this.children; },
    async *values() { yield* this.children.values(); },
    async getFileHandle(n) {
      const c = this.children.get(n);
      if (c?.kind !== 'file') throw new DOMException(n, 'NotFoundError');
      return c;
    },
  });
  const root = node('');
  for (const file of fileList) {
    const parts = file.webkitRelativePath.split('/').filter(Boolean);
    let dir = root;
    // The first part is the picked folder itself: it becomes the root.
    for (const part of parts.slice(1, -1)) {
      if (!dir.children.has(part)) dir.children.set(part, node(part));
      dir = dir.children.get(part);
    }
    const name = parts.at(-1);
    dir.children.set(name, {kind: 'file', name, getFile: async () => file});
  }
  root.name = rootName;
  return root;
}

/**
 * Finds the prepared folder in what the player picked: the folder itself, or one above it
 * (the version folder, `.local`, `horizon-client`), up to a few levels down. Also notes
 * `mods` folders with jars: a prepared install is vanilla data, mods are not carried over.
 */
export async function locate(picked, log) {
  let found = null, unprepared = false;
  const mods = [];
  async function walk(dir, path, depth) {
    let hasManifest = false;
    const subdirs = [];
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === 'file' && name === MANIFEST) hasManifest = true;
      // A Horizon build folder (its pinned versions file) that was never prepared.
      else if (entry.kind === 'file' && name === 'research-lock.json') unprepared = true;
      else if (entry.kind === 'directory') subdirs.push([name, entry]);
    }
    if (hasManifest && !found) found = {dir, path};
    for (const [name, entry] of subdirs) {
      const child = path ? `${path}/${name}` : name;
      if (name.toLowerCase() === 'mods') {
        for await (const [file] of entry.entries()) if (/\.jar$/i.test(file)) { mods.push(child); break; }
        continue;
      }
      // Below the prepared folder there is no other manifest to find.
      if (hasManifest || depth >= 5 || name === 'assets' || name === 'saves') continue;
      await walk(entry, child, depth + 1);
    }
  }
  await walk(picked, '', 0);
  if (found) log?.(`found ${MANIFEST} in ${found.path || '(the picked folder)'}`);
  if (mods.length) log?.(`mods folders: ${mods.join(', ')}`);
  if (!found && unprepared) log?.('a Horizon build without .local/horizon-client: not prepared yet');
  return {...(found ?? {}), mods, unprepared: !found && unprepared};
}

/** The manifest, checked for this engine: throws a readable Error when it does not fit. */
export async function readManifest(dir) {
  const manifest = JSON.parse(await (await (await dir.getFileHandle(MANIFEST)).getFile()).text());
  if (manifest.minecraft !== MINECRAFT) {
    throw Object.assign(new Error(`Minecraft ${manifest.minecraft}`), {code: 'version', found: manifest.minecraft});
  }
  if (manifest.schema !== SCHEMA) {
    throw Object.assign(new Error(`schema ${manifest.schema}`), {code: 'schema', found: manifest.schema});
  }
  return manifest;
}

async function listFiles(dir, log) {
  const files = [];
  let folders = 0;
  const unreadable = [];
  async function walk(handle, parts) {
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === 'directory') {
        folders++;
        await walk(entry, [...parts, name]);
      } else {
        // On Windows a file whose full path is over 260 characters can not be opened:
        // Chrome and Edge say it is not found (Brave hands it over empty, see importFrom).
        let file;
        try { file = await entry.getFile(); }
        catch (error) { unreadable.push([...parts, name].join('/')); continue; }
        files.push({parts: [...parts, name], file});
        if (files.length % 2000 === 0) log?.(`listed ${files.length} files…`);
      }
    }
  }
  await walk(dir, []);
  if (unreadable.length) {
    for (const path of unreadable.slice(0, 5)) log?.(`error: the browser could not open: ${path}`);
    if (unreadable.length > 5) log?.(`error: …and ${unreadable.length - 5} more`);
    throw Object.assign(new Error(`${unreadable.length} files`), {code: 'unreadable', count: unreadable.length});
  }
  // A sort key made once per file; "\0" sorts below every name character, so the order
  // is the same as comparing the lowercased parts one by one.
  for (const item of files) item.key = item.parts.map(part => part.toLowerCase()).join('\0');
  files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {files, folders};
}

// Records are gathered into one Blob of about this size per write; the Files in it are
// read only as the Blob is written.
const BATCH_BYTES = 8 << 20;

// The page's memory as Chromium reports it, for the log: a tab that runs out of it is
// killed without a word, so the last line shows how close it came.
function memoryLine() {
  const m = performance.memory;
  return m ? `memory: JS heap ${(m.usedJSHeapSize / 1048576).toFixed(0)} of ${(m.jsHeapSizeLimit / 1048576).toFixed(0)} MiB` : 'memory: not reported';
}

// A batch that failed to write: which of its files can not be read, for the log.
async function explain(error, items) {
  for (const item of items) {
    try { await item.file.slice(0, 1).arrayBuffer(); }
    catch (cause) { return Object.assign(new Error(`${item.parts.join('/')}: ${cause.name}: ${cause.message}`), {name: cause.name}); }
  }
  return error;
}

/**
 * Writes `files` as one bundle file: per file, u32 name length, u32 size (little endian),
 * the name, the bytes (the layout resource_io/browser.rs mounts). Returns its index:
 * [path, offset of the bytes, size] per file.
 */
async function writeBundle(dir, fileName, files, log, progress, label) {
  const writable = await (await dir.getFileHandle(fileName, {create: true})).createWritable();
  const encoder = new TextEncoder();
  const index = [];
  let offset = 0, parts = [], batch = [], pending = 0;
  const flush = async () => {
    if (!parts.length) return;
    // Files read on use (on the network, in a ZIP) are read now, several at a time.
    const remote = parts.map((part, i) => [part, i]).filter(([part]) => part?.lazy);
    let next = 0;
    const download = async () => {
      while (next < remote.length) {
        const [part, i] = remote[next++];
        parts[i] = await part.blob();
      }
    };
    await Promise.all(Array.from({length: Math.min(16, remote.length)}, download));
    try { await writable.write(new Blob(parts)); }
    catch (error) { throw await explain(error, batch); }
    progress(pending);
    // Each batch's Blob is let go before the next is made.
    await new Promise(resolve => setTimeout(resolve, 0));
    parts = [];
    batch = [];
    pending = 0;
  };
  try {
    for (const item of files) {
      const path = item.parts.join('/');
      const name = encoder.encode(path);
      const header = new DataView(new ArrayBuffer(8));
      header.setUint32(0, name.length, true);
      header.setUint32(4, item.file.size, true);
      parts.push(header.buffer, name, item.file);
      batch.push(item);
      offset += 8 + name.length;
      index.push([path, offset, item.file.size]);
      offset += item.file.size;
      pending += item.file.size;
      if (pending >= BATCH_BYTES) await flush();
    }
    await flush();
  } catch (error) {
    // Aborted, not closed: the half-written file is dropped, and its folder can be removed
    // (a folder with an open writable refuses to go).
    await writable.abort().catch(() => {});
    throw error;
  }
  await writable.close();
  log(`${label}: ${files.length} files, ${(offset / 1048576).toFixed(1)} MiB`);
  return {index, bytes: offset};
}

// The sounds, in sounds.js's place: one bundle and its index (sounds.js slices it),
// instead of thousands of small files that were slow to write and to list.
async function writeSounds(files, log, progress) {
  const root = await (await top()).getDirectoryHandle(SOUNDS_DIR, {create: true});
  // assets/minecraft/sounds/... -> minecraft/sounds/... (the paths sounds.js lists)
  const renamed = files.map(item => ({...item, parts: item.parts.slice(1)}));
  const {index, bytes} = await writeBundle(root, 'sounds.bin', renamed, log, progress, 'sounds');
  const list = await (await root.getFileHandle('sounds-index.json', {create: true})).createWritable();
  await list.write(JSON.stringify(index));
  await list.close();
  const done = await (await root.getFileHandle(DONE, {create: true})).createWritable();
  await done.write(JSON.stringify({version: MINECRAFT, files: files.length, bytes, source: 'horizon', bundle: true}));
  await done.close();
  return bytes;
}

/**
 * Imports the prepared folder `dir` (from `locate`). `log(line)` gets a detailed log,
 * `onProgress(doneBytes, totalBytes)` the progress. With `sounds` false the sounds are
 * skipped (and any stored before are removed).
 */
export async function importFrom(dir, {sounds = true, log = () => {}, onProgress = () => {}} = {}) {
  const started = performance.now();
  const manifest = await readManifest(dir);
  log(`Minecraft ${manifest.minecraft}, schema ${manifest.schema}, data version ${manifest.data_version}`);
  log(`client.jar sha256 ${String(manifest.client_sha256).slice(0, 16)}…`);
  log('listing files…');
  const {files, folders} = await listFiles(dir, log);
  log(`${files.length} files in ${folders} folders`);

  const isSound = f => f.parts[0] === 'assets' && f.parts.includes('sounds');
  const soundFile = f => f.parts[0] === 'assets' && f.parts[1] === 'minecraft'
    && (f.parts[2] === 'sounds' || (f.parts.length === 3 && f.parts[2] === 'sounds.json'));
  const menu = files.filter(f => f.parts[0] === 'assets' && !isSound(f));
  const world = files.filter(f => f.parts[0] !== 'assets');
  const soundFiles = sounds ? files.filter(soundFile) : [];

  // Files the browser could not read come as empty ones (on Windows, a full path over 260
  // characters). No resource is empty, so they stop the import.
  const unreadable = [...menu, ...world, ...soundFiles].filter(item =>
    item.file.size === 0 && !item.parts.at(-1).startsWith('.') && !/\.(log|txt)$/i.test(item.parts.at(-1)));
  if (unreadable.length) {
    for (const item of unreadable.slice(0, 5)) log(`error: empty as the browser read it: ${item.parts.join('/')}`);
    if (unreadable.length > 5) log(`error: …and ${unreadable.length - 5} more`);
    throw Object.assign(new Error(`${unreadable.length} files`), {code: 'unreadable', count: unreadable.length});
  }
  let total = 0;
  for (const item of [...menu, ...world, ...soundFiles]) total += item.file.size;
  log(`to store: ${(total / 1048576).toFixed(0)} MiB (menu ${menu.length}, world ${world.length}, sounds ${soundFiles.length} files)`);
  // Brave and others report a made-up quota, so there is no estimate to trust here: the
  // origin asks to be kept, and a full disk shows up as QuotaExceededError while writing.
  const kept = await navigator.storage.persist?.().catch(() => false);
  log(`persistent storage: ${kept ? 'granted' : 'not granted'}`);
  log(await storageLine());

  // A fresh import: the old one goes first, and `.complete` is written last, so an
  // interrupted import is never taken for a finished one.
  await remove();
  const target = await (await top()).getDirectoryHandle(DIR, {create: true});
  let done = 0;
  const progress = n => { done += n; onProgress(done, total); };
  let summary;
  try {
    // One bundle at a time: written side by side they were hardly faster in Brave (the
    // files are read from disk at its pace) and held three times the memory.
    const menuBytes = (await writeBundle(target, 'menu-resources.bin', menu, log, progress, 'menu bundle')).bytes;
    log(memoryLine());
    const worldBytes = (await writeBundle(target, 'world-resources.bin', world, log, progress, 'world bundle')).bytes;
    log(memoryLine());
    const soundBytes = soundFiles.length ? await writeSounds(soundFiles, log, progress) : 0;
    log(memoryLine());
    summary = {
      minecraft: manifest.minecraft, schema: manifest.schema, dataVersion: manifest.data_version,
      clientSha256: manifest.client_sha256, files: menu.length + world.length, sounds: soundFiles.length,
      bytes: menuBytes + worldBytes + soundBytes, importedAt: Date.now(),
    };
    // The marker too: without it the copy is not taken as finished, and Play asks again.
    const marker = await (await target.getFileHandle(DONE, {create: true})).createWritable();
    await marker.write(JSON.stringify(summary));
    await marker.close();
  } catch (error) {
    log(await storageLine());
    await remove().catch(cause => log(`error: the unfinished copy was not removed: ${cause.name}`));
    if (error?.name === 'QuotaExceededError') {
      throw Object.assign(new Error(`${(total / 1048576).toFixed(0)} MiB`), {code: 'space'});
    }
    throw error;
  }
  log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  return summary;
}
