// The game's sounds, as the Horizon import stores them (horizon-import.js): one bundle
// in OPFS and its index, apart from the game's session files. The game page lists them
// for Rust at start.
const DIR = 'astris-sounds';

/**
 * Lists the stored sounds for the game: `globalThis.horizonSoundList()` answers
 * `path\turl` lines; each URL is a slice of the bundle, read only when the game decodes it.
 */
export async function exposeToGame(log) {
  const lines = [];
  // The page's own reads (sounds.json, at start): a Window may not read synchronously
  // into bytes, so those files are held here; Workers read the rest by URL.
  const held = new Map();
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR).catch(() => null);
  const index = await root?.getFileHandle('sounds-index.json').then(h => h.getFile()).catch(() => null);
  if (index) {
    const bundle = await (await root.getFileHandle('sounds.bin')).getFile();
    for (const [path, offset, size] of JSON.parse(await index.text())) {
      const slice = bundle.slice(offset, offset + size);
      const url = URL.createObjectURL(slice);
      if (path.endsWith('.json')) held.set(url, new Uint8Array(await slice.arrayBuffer()));
      lines.push(`${path}\t${url}`);
    }
    log('HOST', `sounds: ${lines.length} files from the OPFS bundle`);
  }
  const list = lines.join('\n');
  globalThis.horizonSoundList = () => list || undefined;
  globalThis.horizonReadUrl = url => held.get(url);
}
