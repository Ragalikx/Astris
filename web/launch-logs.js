// The last few launch logs, gzip-compressed in OPFS (apart from the game's own files).
const DIR = 'astris-logs';
// Logs kept, the game's and the launcher's together, unless the settings say otherwise.
const KEEP = 10;

const dir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, {create: true});

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
async function gunzip(blob) {
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

// The launcher's own logs end in -launcher: they are kept apart from the game's.
const kindOf = name => name.endsWith('-launcher.log.gz') ? 'launcher' : 'game';

/** Newest first: [{name, kind ('game' or 'launcher'), started: Date, bytes}]. */
export async function list() {
  const out = [];
  for await (const [name, entry] of (await dir()).entries()) {
    if (entry.kind !== 'file' || !name.endsWith('.log.gz')) continue;
    const file = await entry.getFile();
    out.push({name, kind: kindOf(name), started: new Date(Number(name.split('-')[0])), bytes: file.size});
  }
  return out.sort((a, b) => b.started - a.started);
}

export async function read(name) {
  return gunzip(await (await (await dir()).getFileHandle(name)).getFile());
}

export async function remove(name) {
  await (await dir()).removeEntry(name);
}

/** Keeps the newest `keep` logs of either kind (and `current`, always); the rest go. */
export async function prune(keep, current = null) {
  const older = (await list()).filter(entry => entry.name !== current);
  for (const old of older.slice(Math.max(0, keep - (current ? 1 : 0)))) await remove(old.name).catch(() => {});
}

/**
 * One launch's log. save() rewrites its file with everything logged so far, so a crash
 * or a closed tab still leaves the log up to the last save. Only the newest `keep` logs
 * stay, and when the storage is full the oldest go first.
 */
export function createLaunchLog(startedAt = Date.now(), kind = 'game') {
  const name = `${startedAt}-${Math.random().toString(36).slice(2, 8)}${kind === 'launcher' ? '-launcher' : ''}.log.gz`;
  let pruned = false;
  let saving = null;
  let keep = KEEP;
  return {
    name,
    setKeep(n) { keep = n; },
    save(text) {
      const write = async () => {
        const handle = await (await dir()).getFileHandle(name, {create: true});
        const writable = await handle.createWritable();
        try {
          await writable.write(await gzip(text));
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => {});
          throw error;
        }
      };
      return saving ??= (async () => {
        try {
          await write();
        } catch (error) {
          if (error?.name !== 'QuotaExceededError') throw error;
          // No room: the oldest log goes, and the write is tried once more.
          const oldest = (await list()).filter(entry => entry.name !== name).at(-1);
          if (!oldest) throw error;
          await remove(oldest.name);
          await write();
        }
        if (!pruned) {
          pruned = true;
          await prune(keep, name);
        }
      })().catch(() => {}).finally(() => { saving = null; });
    },
  };
}
