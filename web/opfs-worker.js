// Owns the game's files in the Origin Private File System (OPFS).
//
// The game keeps its session files in wasm memory and journals every change
// (horizon_core::session_io::drain). The page hands each journal batch here and this
// Worker writes only the changed byte ranges with synchronous access handles, which
// only a dedicated Worker may open. Requests run one at a time in arrival order.
const ROOT = 'horizon-session';
const MAX_OPEN = 48;
const decoder = new TextDecoder();

let rootDir = null;
const root = async () => rootDir ??= await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, {create: true});

function checked(path) {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  if (!parts.length || parts.some(p => p === '..' || p === '.')) throw new Error(`invalid session path: ${path}`);
  return parts;
}

async function dirFor(parts, create) {
  let dir = await root();
  for (const part of parts) dir = await dir.getDirectoryHandle(part, {create});
  return dir;
}

// Open sync handles, least recently used first (Map keeps insertion order).
const open = new Map();
async function handleFor(path) {
  let handle = open.get(path);
  if (handle) {
    open.delete(path);
    open.set(path, handle);
    return handle;
  }
  const parts = checked(path);
  const dir = await dirFor(parts.slice(0, -1), true);
  const file = await dir.getFileHandle(parts.at(-1), {create: true});
  handle = await file.createSyncAccessHandle();
  open.set(path, handle);
  while (open.size > MAX_OPEN) {
    const [oldest, old] = open.entries().next().value;
    open.delete(oldest);
    old.close();
  }
  return handle;
}
function closeUnder(path, tree) {
  for (const [name, handle] of open) {
    if (name === path || (tree && name.startsWith(path + '/'))) {
      handle.close();
      open.delete(name);
    }
  }
}
async function remove(path, tree) {
  closeUnder(path, tree);
  const parts = checked(path);
  try {
    const dir = await dirFor(parts.slice(0, -1), false);
    await dir.removeEntry(parts.at(-1), {recursive: tree});
  } catch (error) {
    if (error.name !== 'NotFoundError' && error.name !== 'TypeMismatchError') throw error;
  }
}

// The game's derived caches (`.horizon-cache/`, unpacked resource packs): the game rebuilds
// them when missing, so they are not kept.
const NOT_KEPT = /^\.horizon-cache(\/|$)/;

/** Applies one journal batch; the layout is documented on session_io::drain. */
async function apply(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let at = 0;
  const u8 = () => bytes[at++];
  const u32 = () => { const v = view.getUint32(at, true); at += 4; return v; };
  const u64 = () => { const v = Number(view.getBigUint64(at, true)); at += 8; return v; };
  const name = () => { const n = u32(); const s = decoder.decode(bytes.subarray(at, at + n)); at += n; return s; };
  if (decoder.decode(bytes.subarray(0, 8)) !== 'HZJRNL01') throw new Error('bad journal batch');
  at = 9;
  let written = 0;
  for (let i = u32(); i > 0; i--) {
    const tree = u8() === 1;
    const path = name();
    if (!NOT_KEPT.test(path)) await remove(path, tree);
  }
  for (let i = u32(); i > 0; i--) {
    const path = name();
    if (!NOT_KEPT.test(path)) await dirFor(checked(path), true);
  }
  for (let i = u32(); i > 0; i--) {
    const path = name();
    const length = u64();
    u8(); // full rewrite: its single range covers the file
    if (NOT_KEPT.test(path)) {
      for (let r = u32(); r > 0; r--) { u64(); at += u32(); }
      continue;
    }
    const handle = await handleFor(path);
    if (handle.getSize() !== length) handle.truncate(length);
    for (let r = u32(); r > 0; r--) {
      const offset = u64();
      const size = u32();
      handle.write(bytes.subarray(at, at + size), {at: offset});
      at += size;
      written += size;
    }
    handle.flush();
  }
  // Flushed as written: a handle opened later (another file, or a read-back) may close
  // an earlier one to stay under MAX_OPEN.
  return written;
}

// Files read at once by `load`: one at a time, a world's thousands of region and
// data files took seconds; the store answers many reads in parallel.
const LOAD_PARALLEL = 32;

// A world's region files: the bulk of it, and only those near the player are in use.
const READ_WHEN_USED = /\.mca$/;

/** Every stored file and folder, as [path, ArrayBuffer | size | null] pairs. */
async function load() {
  for (const [, handle] of open) handle.close();
  open.clear();
  // The tree first (listing is cheap), folders before what they hold; then the reads.
  const entries = [];
  const files = [];
  async function walk(dir, prefix) {
    for await (const [entryName, entry] of dir.entries()) {
      const path = prefix ? `${prefix}/${entryName}` : entryName;
      // Caches kept by builds before NOT_KEPT: dropped instead of read.
      if (NOT_KEPT.test(path)) {
        await dir.removeEntry(entryName, {recursive: true}).catch(() => {});
        continue;
      }
      if (entry.kind === 'directory') {
        entries.push([path, null]);
        await walk(entry, path);
      } else if (READ_WHEN_USED.test(path)) {
        // Only the size: the game reads it back when it uses it (`attach`).
        entries.push([path, (await entry.getFile()).size]);
      } else {
        files.push([entries.length, entry]);
        entries.push([path, null]);
      }
    }
  }
  await walk(await root(), '');
  const transfer = [];
  let next = 0;
  async function reader() {
    while (next < files.length) {
      const [at, entry] = files[next++];
      const data = await (await entry.getFile()).arrayBuffer();
      entries[at][1] = data;
      transfer.push(data);
    }
  }
  await Promise.all(Array.from({length: Math.min(LOAD_PARALLEL, files.length)}, reader));
  return {result: entries, transfer};
}


async function put(path, buffer) {
  const handle = await handleFor(path);
  handle.truncate(0);
  handle.write(new Uint8Array(buffer), {at: 0});
  handle.flush();
  return buffer.byteLength;
}

/** A file's bytes, or null when there is none. */
async function get(path) {
  if (!open.has(path)) {
    const parts = checked(path);
    try {
      const dir = await dirFor(parts.slice(0, -1), false);
      await dir.getFileHandle(parts.at(-1));
    } catch (_) { return null; }
  }
  const handle = await handleFor(path);
  const buffer = new ArrayBuffer(handle.getSize());
  handle.read(new Uint8Array(buffer), {at: 0});
  // Wrapped: a bare ArrayBuffer has a `transfer` method, which the reply below would
  // take for this wrapper.
  return {result: buffer, transfer: [buffer]};
}

async function clear() {
  for (const [, handle] of open) handle.close();
  open.clear();
  rootDir = null;
  try { await (await navigator.storage.getDirectory()).removeEntry(ROOT, {recursive: true}); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
}

// ---- Read-back: the game asks for a file it let go (horizon_core::session_io::host) ----
// A request in the game's shared memory at `address`: an i32 state (1 asked, 2 done,
// 3 failed), then the name's address and length, the destination and the length (u64).
// Polled (Rust has no stable way to wake this Worker): every millisecond while reads come
// in, as a world loads, else every 16 ms.
const nameDecoder = new TextDecoder();
let channel = null, lastRead = 0;
async function serve() {
  const {memory, address} = channel;
  for (;;) {
    // The buffer is taken again each time: the memory may have grown.
    const state = new Int32Array(memory.buffer, address, 1);
    if (Atomics.load(state, 0) !== 1) {
      const pause = performance.now() - lastRead < 2000 ? 1 : 16;
      const wait = Atomics.waitAsync(state, 0, Atomics.load(state, 0), pause);
      if (wait.async) await wait.value;
      else await new Promise(resolve => setTimeout(resolve, pause));
      continue;
    }
    lastRead = performance.now();
    const view = new DataView(memory.buffer);
    const field = at => Number(view.getBigUint64(address + at, true));
    const path = nameDecoder.decode(new Uint8Array(memory.buffer, field(8), field(16)).slice());
    const dst = field(24), length = field(32);
    let result = 2;
    try {
      const handle = await handleFor(path);
      if (handle.getSize() !== length) throw new Error(`${path}: ${handle.getSize()} bytes stored, ${length} expected`);
      const bytes = new Uint8Array(length);
      handle.read(bytes, {at: 0});
      new Uint8Array(memory.buffer, dst, length).set(bytes);
    } catch (error) {
      console.warn('OPFS read-back failed:', error);
      result = 3;
    }
    Atomics.store(new Int32Array(memory.buffer, address, 1), 0, result);
  }
}
function attach({memory, address}) {
  const start = !channel;
  channel = {memory, address};
  if (start) serve();
}

const ops = {
  attach,
  load,
  apply: ({buffer}) => apply(buffer),
  put: ({path, buffer}) => put(path, buffer),
  get: ({path}) => get(path),
  remove: ({path, tree}) => remove(path, !!tree),
  clear,
};

let queue = Promise.resolve();
self.onmessage = ({data}) => {
  const {id, op} = data;
  queue = queue.then(async () => {
    try {
      const out = await ops[op](data);
      if (out && typeof out === 'object' && 'transfer' in out) postMessage({id, ok: true, result: out.result}, out.transfer);
      else postMessage({id, ok: true, result: out});
    } catch (error) {
      postMessage({id, ok: false, error: `${error?.name || 'Error'}: ${error?.message || error}`});
    }
  });
};
