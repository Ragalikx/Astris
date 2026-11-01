// The launcher's preferences, one JSON file in OPFS (apart from the game's own files, so
// "delete local data" keeps them). The launcher writes them; the game page reads them at
// boot and writes back the worker count changed in game.
const FILE = 'astris-settings.json';

export const DEFAULTS = Object.freeze({
  lang: 'en',          // en | ru | uk
  workers: 0,          // 0 = the game picks for this machine, else 1-8
  memoryGiB: 0,        // 0 = auto; a preference the game does not apply yet
  wasm64: false,       // the experimental memory64 build
  touch: false,        // on-screen touch controls (touch.js), experimental
  nickname: '',        // shown in the launcher only; the game uses the Minecraft profile name
  motion: true,        // animated background
  engine: 'astris',    // the engine build picked in the version list
  bootMs: 0,           // the last launch's time to the first frame: paces the loading screen
  logKeep: 10,         // logs kept, the game's and the launcher's together (launch-logs.js), 1-100
  frameCap: true,      // frames at the monitor's refresh rate only (game/browser.rs)
  netUrl: '',          // the server sharing a prepared Horizon folder
  netConsent: false,   // the player said they understand the risks of a network source
});

const file = async create => (await navigator.storage.getDirectory()).getFileHandle(FILE, {create});

function sanitize(raw) {
  const out = {...DEFAULTS};
  if (['en', 'ru', 'uk'].includes(raw?.lang)) out.lang = raw.lang;
  const workers = Number(raw?.workers);
  if (Number.isInteger(workers) && workers >= 0 && workers <= 8) out.workers = workers;
  const memory = Number(raw?.memoryGiB);
  if ([0, 1, 2, 3, 4, 6, 8].includes(memory)) out.memoryGiB = memory;
  out.wasm64 = raw?.wasm64 === true;
  out.touch = raw?.touch === true;
  if (typeof raw?.nickname === 'string') out.nickname = raw.nickname.trim().slice(0, 16);
  out.motion = raw?.motion !== false;
  out.frameCap = raw?.frameCap !== false;
  if (typeof raw?.netUrl === 'string') out.netUrl = raw.netUrl.slice(0, 500);
  out.netConsent = raw?.netConsent === true;
  if (typeof raw?.engine === 'string') out.engine = raw.engine;
  const keep = Number(raw?.logKeep);
  if (Number.isInteger(keep) && keep >= 1 && keep <= 100) out.logKeep = keep;
  const boot = Number(raw?.bootMs);
  if (Number.isFinite(boot) && boot > 0 && boot < 600000) out.bootMs = Math.round(boot);
  return out;
}

function browserLang() {
  const lang = (navigator.language || '').toLowerCase();
  return lang.startsWith('ru') ? 'ru' : lang.startsWith('uk') ? 'uk' : 'en';
}

export async function load() {
  try {
    const text = await (await (await file(false)).getFile()).text();
    return sanitize(JSON.parse(text));
  } catch (_) {
    // First run: English unless the browser asks for Russian or Ukrainian.
    return sanitize({lang: browserLang()});
  }
}

let writing = Promise.resolve();
/** Writes the settings; writes run one after another, the last one wins. */
export function save(settings) {
  const text = JSON.stringify(sanitize(settings), null, 2);
  writing = writing.then(async () => {
    const writable = await (await file(true)).createWritable();
    await writable.write(text);
    await writable.close();
  }).catch(error => console.warn('settings not saved:', error));
  return writing;
}
