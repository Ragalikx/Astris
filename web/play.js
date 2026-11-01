// The Astris game page: the Rust client owns the whole viewport; this script only boots it,
// keeps its files in OPFS and shows failures. All game UI stays in Rust.
import * as store from './session-store.js';
import {createLaunchLog} from './launch-logs.js';
import * as prefs from './settings.js';
import {t, setLang, apply} from './i18n.js';
import {startSky} from './sky.js';
import {analyze} from './log-view.js';
import * as sounds from './sounds.js';
import * as resources from './horizon-import.js';
import * as peer from './peer.js';

Error.stackTraceLimit = 80;
const $ = s => document.querySelector(s);
const started = performance.now();
const params = new URLSearchParams(location.search);
// A dev server is reached by localhost or by an IP address; a real host has a name.
const local = location.hostname === 'localhost' || /^[\d.]+$|^\[[\da-f:]+\]$/i.test(location.hostname) || location.hostname.endsWith('.ts.net');
// The dev server collects logs; a deployed site sends them only when asked to.
const remoteLog = params.get('debug') === '1' || local;
const session = crypto.randomUUID();
const launchLog = createLaunchLog();
const settingsReady = prefs.load();
// Read by the engine as it starts (game/browser.rs): frames only at the monitor's rate.
window.horizonFrameCap = () => frameCap;
let frameCap = true;
settingsReady.then(settings => { frameCap = settings.frameCap; });

// ---- Loading screen: the sky, a block wave, the stages so far, tips ----
const sky = startSky($('#sky'));
$('.bar').append(...Array.from({length: 24}, (_, i) => Object.assign(document.createElement('span'), {style: `--i:${i}`})));
const TIPS = ['tip1', 'tip2', 'tip3', 'tip4', 'tip5'];
let tipIndex = Math.floor(Math.random() * TIPS.length), stageName = '', stageAt = 0;
function showTip() {
  const tip = $('#tip');
  tip.classList.add('out');
  setTimeout(() => { tip.textContent = t(TIPS[tipIndex++ % TIPS.length]); tip.classList.remove('out'); }, 300);
}
const seconds = ms => (ms / 1000).toFixed(1);
const loadingTimers = [
  setInterval(() => { $('#elapsed').textContent = t('elapsed', {s: seconds(performance.now() - started)}); }, 100),
  setInterval(showTip, 6000),
];
function setStage(message) {
  const now = performance.now();
  if (stageName) {
    const done = document.createElement('li');
    done.append(stageName, Object.assign(document.createElement('span'), {textContent: t('elapsed', {s: seconds(now - stageAt)})}));
    const list = $('#stages');
    list.append(done);
    while (list.children.length > 4) list.firstChild.remove();
  }
  stageName = message;
  stageAt = now;
  stagesDone++;
  $('#stage').textContent = message;
}
// The night turns to a Minecraft morning as the game loads, and the bar from Astris
// lavender to the game's green, so the title screen does not arrive as a colour jump.
// The screen follows the game and never holds it: progress is the larger of the stages
// passed and the time against the last launch's, and the first frame ends it at once.
const EXPECTED_STAGES = 8;
let dawn = 0, dawnTarget = 0, stagesDone = 0, expectedMs = 0;
const lerp = (a, b, k) => Math.round(a + (b - a) * k);
loadingTimers.push(setInterval(() => {
  const byTime = expectedMs ? (performance.now() - started) / expectedMs : 0;
  dawnTarget = Math.max(dawnTarget, Math.min(0.9, Math.max(stagesDone / EXPECTED_STAGES, byTime * 0.9)));
  dawn += (dawnTarget - dawn) * 0.18;
  sky.setDawn(dawn);
  const k = Math.min(1, dawn * 1.2);
  $('.boot-card').style.setProperty('--lit', `rgb(${lerp(179, 92, k)}, ${lerp(168, 168, k)}, ${lerp(238, 63, k)})`);
}, 66));
function closeLoading(fade) {
  const boot = $('#boot');
  const end = () => { loadingTimers.forEach(clearInterval); boot.hidden = true; sky.stop(); };
  if (!fade) { end(); return; }
  // The game is already drawing underneath: the fade and the last of the dawn run together.
  dawnTarget = 1;
  boot.classList.add('done');
  setTimeout(end, 450);
}
settingsReady.then(settings => {
  expectedMs = settings.bootMs;
  launchLog.setKeep(settings.logKeep);
  setLang(settings.lang);
  apply();
  document.documentElement.classList.remove('i18n-wait');
  if (!stageName) setStage(t('loading'));
  $('#tip').textContent = t(TIPS[tipIndex++ % TIPS.length]);
  if (!settings.motion) sky.setMotion(false);
});

// ---- Log: a bounded ring, rendered only while the overlay is open ----
const lines = [];
let dropped = 0, pending = [], flushTimer = 0, renderTimer = 0;
const stringify = v => v instanceof Error ? v.stack || v.message : String(v);
function sendLog() {
  flushTimer = 0;
  if (!pending.length) return;
  const body = pending.join('\n') + '\n';
  pending = [];
  try { navigator.sendBeacon(`/log?session=${session}`, body); } catch (_) {}
}
function log(level, ...args) {
  const entry = `${new Date().toISOString()} +${((performance.now() - started) / 1000).toFixed(3)}s [${level}] ${args.map(stringify).join(' ')}`;
  lines.push(entry);
  if (lines.length > 3000) { lines.shift(); dropped++; }
  if (remoteLog && level !== 'DEBUG') {
    pending.push(entry);
    if (level === 'FATAL' || level === 'WARN' || level === 'ERROR') sendLog();
    else flushTimer ||= setTimeout(sendLog, 1000);
  }
  if (!$('#debug').hidden) renderTimer ||= setTimeout(renderTrace, 250);
}
// The overlay shows the newest records, coloured as the launcher's log viewer does.
const TRACE_LINES = 600;
function renderTrace() {
  renderTimer = 0;
  const trace = $('#debug-trace');
  const follow = trace.scrollHeight - trace.scrollTop - trace.clientHeight < 40;
  const hidden = dropped + Math.max(0, lines.length - TRACE_LINES);
  const span = (className, textContent) => Object.assign(document.createElement('span'), {className, textContent});
  const fragment = document.createDocumentFragment();
  if (hidden) fragment.append(Object.assign(document.createElement('div'), {className: 'tl dim', textContent: `… ${hidden}`}));
  for (const line of analyze(lines.slice(-TRACE_LINES).join('\n')).lines) {
    const row = document.createElement('div');
    row.className = `tl ${line.kind}`;
    row.append(span('t', line.time), span('lv', line.level), span('src', line.source), span('m', line.message));
    fragment.append(row);
  }
  trace.replaceChildren(fragment);
  if (follow) trace.scrollTop = trace.scrollHeight;
}
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => { original(...args); log(level.toUpperCase(), ...args); };
}
const logText = () => `Astris launch log ${session}\n${location.href}\n${navigator.userAgent}\n${dropped} earlier records dropped\n\n${lines.join('\n')}\n`;
// The launcher's "Логи запуска" lists these; saved often so a crash keeps its log.
const persistLog = () => launchLog.save(logText());
setInterval(persistLog, 15000);
addEventListener('pagehide', persistLog);
document.addEventListener('visibilitychange', () => { if (document.hidden) persistLog(); });
function saveLog() {
  const blob = new Blob([logText()], {type: 'text/plain;charset=utf-8'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `astris-${new Date().toISOString().replaceAll(':', '-')}.log`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---- Rust Workers: wasm_thread pools them, the worker script reports start/finish ----
const workers = new Set();
let busyWorkers = 0;
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url, options) {
    super(url, options);
    if (options?.name === 'opfs') return;
    workers.add(this);
    this.addEventListener('message', event => {
      const data = event.data;
      if (!data?.__horizon) return; // wasm_thread owns the numeric control messages
      // Registered before wasm_thread's onmessage, so it never sees these.
      event.stopImmediatePropagation();
      const kind = data.__horizon;
      if (kind === 'start') busyWorkers++;
      else if (kind === 'complete') busyWorkers--;
      else if (kind === 'failure') window.horizonFailure(`Worker ${data.name}: ${data.message}`);
      else if (kind !== 'ready') log(kind.toUpperCase(), `[${data.name}] ${data.message}`);
    });
    this.addEventListener('error', event => window.horizonFailure(`Worker: ${event.message}`));
  }
  terminate() { workers.delete(this); super.terminate(); }
};

// ---- Hooks the Rust client calls ----
let fatal = false, frames = 0, flushSession = null, exiting = false;
// The engine reports its stages and notices in English, as the log keeps them; the
// screen shows those it knows in the page's language.
const ENGINE_TEXT = {
  'Creating the Astris renderer (WebGPU)…': 'stageRenderer',
  'Multiplayer is off in the browser version.': 'noticeNoMultiplayer',
  'Menu ready; the game’s resources are loading in the background…': 'stageMenuReady',
  'The game is ready: a world can be created or opened.': 'stageGameReady',
  'Resources ready; starting the game…': 'stageCreatingGame',
  'Loading the menu’s resources from this computer…': 'stageMenuResources',
  'Building the interface and fonts…': 'stageFonts',
  'Creating the menu screens and loading the language…': 'stageScreens',
  'Creating the game window…': 'stageWindow',
  'Leave the world first to join another one.': 'peerLeaveFirst',
};
const shown = message => (ENGINE_TEXT[message] ? t(ENGINE_TEXT[message]) : message);
window.horizonStage = message => { setStage(shown(message)); log('STAGE', message); };
// Frame times of the last health window, for its FPS and spikes.
let lastFrameAt = 0, frameGaps = [];
window.horizonFrame = () => {
  const now = performance.now();
  if (lastFrameAt && frameGaps.length < 20000) frameGaps.push(now - lastFrameAt);
  lastFrameAt = now;
  if (frames++ === 0) {
    closeLoading(true);
    const bootMs = performance.now() - started;
    settingsReady.then(() => prefs.load()).then(latest => prefs.save({...latest, bootMs}));
    log('HOST', `first frame after ${(bootMs / 1000).toFixed(1)}s`);
  }
};
let toastTimer = 0;
window.horizonNotice = message => {
  log('NOTICE', message);
  const toast = $('#toast');
  toast.textContent = shown(message);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
};
window.horizonFailure = reason => {
  const message = stringify(reason instanceof Error ? reason : new Error(String(reason)));
  log('FATAL', message);
  if (!fatal) document.exitPointerLock?.();
  fatal = true;
  $('#fatal-text').textContent = ($('#fatal-text').textContent + '\n' + message).trim().slice(-64000);
  // The browser gave no graphics adapter (the engine words it as for the desktop build):
  // on Linux, Chromium browsers keep WebGPU behind flags.
  if (/No Vulkan or OpenGL graphics driver|No suitable graphics adapter/i.test(message)) {
    const linux = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
    $('#fatal-hint').textContent = t(linux ? 'errNoAdapterLinux' : 'errNoAdapter');
    $('#fatal-hint').hidden = false;
  }
  // A software adapter (SwiftShader: the browser draws on the CPU) is far too small for
  // the game: the browser did not trust the real graphics card's driver.
  if (/texture layers; \d+ required/.test(message)) {
    $('#fatal-hint').textContent = t('errSoftwareAdapter');
    $('#fatal-hint').hidden = false;
  }
  if (!$('#boot').hidden) closeLoading(false);
  $('#fatal').hidden = false;
  persistLog();
};
window.horizonExit = async () => {
  if (fatal || exiting) return;
  exiting = true;
  log('HOST', 'game quit; saving and returning to the launcher');
  try { await flushSession?.(); } catch (_) {}
  await persistLog();
  location.href = './';
};
addEventListener('error', event => window.horizonFailure(event.error || `${event.message} (${event.filename}:${event.lineno})`));
addEventListener('unhandledrejection', event => {
  const message = stringify(event.reason);
  // Pointer lock and fullscreen requests are refused outside a user gesture; not fatal.
  if (/pointer.?lock|root document of this element is not valid|Document not active|fullscreen/i.test(message)) {
    event.preventDefault();
    log('WARN', `browser refused: ${message}`);
    return;
  }
  window.horizonFailure(event.reason);
});

// ---- Sound: Rust mixes into a ring in shared memory; an AudioWorklet plays it ----
// (crates/horizon-client-render/src/audio.rs, mod web). The context starts suspended until
// the player's first click or key, as browsers require.
let audioContext = null;
window.horizonAudioOpen = (memory, indices, samples, frames) => {
  if (!window.AudioContext) return 0;
  audioContext = new AudioContext({latencyHint: 'interactive'});
  audioContext.audioWorklet.addModule('./audio-worklet.js').then(() => {
    const node = new AudioWorkletNode(audioContext, 'horizon-output', {numberOfInputs: 0, outputChannelCount: [2]});
    node.port.postMessage({buffer: memory.buffer, indices, samples, frames});
    node.connect(audioContext.destination);
    log('HOST', `Web Audio output at ${audioContext.sampleRate} Hz`);
  }).catch(error => log('WARN', `Web Audio worklet failed: ${error}`));
  return audioContext.sampleRate;
};
for (const type of ['pointerdown', 'keydown']) {
  addEventListener(type, () => { if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {}); }, {capture: true});
}

// ---- Mouse: the pointer lock the game asked for, kept ----
// winit takes the lock as granted, but the browser can refuse it (no user gesture yet, or
// just after Esc). The wanted lock is asked for again on the next click or key, with raw
// movement where the browser has it.
let lockWanted = null;
const nativeLock = Element.prototype.requestPointerLock;
const nativeUnlock = Document.prototype.exitPointerLock;
function lockPointer(element) {
  const ask = options => { try { return Promise.resolve(nativeLock.call(element, options)); } catch (error) { return Promise.reject(error); } };
  return ask({unadjustedMovement: true}).catch(error => (error?.name === 'NotSupportedError' ? ask() : Promise.reject(error)));
}
Element.prototype.requestPointerLock = function () {
  lockWanted = this;
  return lockPointer(this).catch(error => log('DEBUG', `pointer lock not granted yet: ${error?.message || error}`));
};
Document.prototype.exitPointerLock = function () {
  lockWanted = null;
  return nativeUnlock.call(this);
};
for (const type of ['pointerdown', 'keydown']) {
  addEventListener(type, event => {
    // Esc is how the browser lets the pointer go: it never takes it back.
    if (event.code === 'Escape' || !lockWanted || document.pointerLockElement === lockWanted || fatal || !$('#debug').hidden) return;
    lockPointer(lockWanted).catch(() => {});
  }, {capture: true});
}
document.addEventListener('pointerlockchange', () => log('DEBUG', `pointer lock ${document.pointerLockElement ? 'on' : 'off'}`));

// ---- Fullscreen: Esc stays the game's ----
// In fullscreen the keyboard lock hands Esc to the game, so it pauses without leaving
// fullscreen (or letting the pointer go); pressing Esc three times quickly leaves
// fullscreen, and holding it does too (the browser's own way out, which it shows).
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) {
    navigator.keyboard?.lock?.(['Escape']).then(() => log('DEBUG', 'Esc kept in fullscreen'), error => log('DEBUG', `keyboard lock refused: ${error?.message || error}`));
  } else navigator.keyboard?.unlock?.();
});
let escapes = [];
addEventListener('keydown', event => {
  if (event.code !== 'Escape' || event.repeat || !document.fullscreenElement) return;
  const now = performance.now();
  escapes = escapes.filter(at => now - at < 1200);
  escapes.push(now);
  if (escapes.length >= 3) {
    escapes = [];
    document.exitFullscreen?.().catch(() => {});
  }
}, {capture: true});

// ---- Play together (peer.js): the panel, Ctrl+Shift+M ----
const PEER_ENABLED = false;
let peerShown = false;
function showPeer(open) {
  $('#peer').hidden = !open;
  if (open) {
    nativeUnlock.call(document);
    $('#peer-not-open').hidden = peer.hosting();
  }
}
function peerTab(name) {
  for (const button of document.querySelectorAll('[data-peer-tab]')) button.setAttribute('aria-pressed', String(button.dataset.peerTab === name));
  for (const pane of document.querySelectorAll('[data-peer-pane]')) pane.hidden = pane.dataset.peerPane !== name;
}
function setupPeer() {
  const status = text => { $('#peer-status').textContent = text; };
  const copy = id => navigator.clipboard?.writeText($(id).value).then(() => status(t('peerCopied')), () => $(id).select());
  let invitation = null;
  peerTab('host');
  for (const button of document.querySelectorAll('[data-peer-tab]')) button.onclick = () => peerTab(button.dataset.peerTab);
  $('#peer-close').onclick = () => showPeer(false);
  $('#peer-invite').onclick = async () => {
    if (!peer.hosting()) { $('#peer-not-open').hidden = false; status(t('peerNotOpen')); return; }
    status(t('peerWorking'));
    try {
      invitation = await peer.invite(() => { status(t('peerJoined')); toastSay(t('peerJoined')); });
      $('#peer-offer').value = invitation.code;
      status(t('peerSendCode'));
    } catch (error) { status(`${t('peerFailed')} ${error.message}`); }
  };
  $('#peer-offer-copy').onclick = () => copy('#peer-offer');
  $('#peer-connect').onclick = async () => {
    if (!invitation) { status(t('peerCreateFirst')); return; }
    try {
      const result = await invitation.accept($('#peer-answer-in').value);
      status(t(result === 'already' ? 'peerAlready' : 'peerConnecting'));
    }
    catch (error) { status(`${t('peerFailed')} ${error.message}`); }
  };
  $('#peer-reply').onclick = async () => {
    status(t('peerWorking'));
    try {
      const reply = await peer.answer($('#peer-offer-in').value, () => { status(t('peerJoining')); showPeer(false); });
      $('#peer-answer').value = reply.code;
      status(t('peerSendAnswer'));
    } catch (error) { status(`${t('peerFailed')} ${error.message}`); }
  };
  $('#peer-answer-copy').onclick = () => copy('#peer-answer');
  // When the world is opened to the network, say once where to invite from.
  setInterval(() => {
    if (!peerShown && peer.hosting()) { peerShown = true; toastSay(t('peerHint')); }
  }, 2000);
}
function toastSay(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastSay.timer);
  toastSay.timer = setTimeout(() => { toast.hidden = true; }, 6000);
}

// ---- Keys: the game gets F1-F11 (help, find, reload... are browser defaults) ----
addEventListener('keydown', event => {
  if (PEER_ENABLED && event.ctrlKey && event.shiftKey && event.code === 'KeyM') {
    event.preventDefault();
    event.stopImmediatePropagation();
    showPeer($('#peer').hidden);
    return;
  }
  // Typing in the panel stays in the panel.
  if (!$('#peer').hidden && event.target instanceof HTMLTextAreaElement) {
    event.stopImmediatePropagation();
    return;
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyL') {
    event.preventDefault();
    event.stopImmediatePropagation();
    const debug = $('#debug');
    debug.hidden = !debug.hidden;
    // The overlay frees the pointer but the game keeps wanting it: a click after it is closed takes it back.
    if (!debug.hidden) { nativeUnlock.call(document); renderTrace(); }
    return;
  }
  if (/^F([1-9]|1[01])$/.test(event.code)) event.preventDefault();
}, {capture: true});
$('#debug-close').onclick = () => { $('#debug').hidden = true; };
$('#debug-save').onclick = saveLog;
$('#fatal-log').onclick = saveLog;

setInterval(() => {
  let memory = '';
  const wasmBytes = window.horizonWasmMemory?.buffer?.byteLength;
  if (wasmBytes) memory += ` wasm=${(wasmBytes / 1048576).toFixed(0)}MiB`;
  const saves = window.horizonSessionResident?.();
  if (saves !== undefined) memory += ` saves_in_memory=${(saves / 1048576).toFixed(0)}MiB`;
  if (performance.memory) memory += ` js=${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MiB`;
  // FPS, the median and the 99th percentile frame time, and the longest frame: the
  // spikes (chunks arriving, a full collection) show in the last two, not in the FPS.
  let timing = '';
  if (frameGaps.length > 1 && !document.hidden) {
    const gaps = frameGaps.slice().sort((a, b) => a - b);
    const at = q => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))].toFixed(1);
    const fps = gaps.length / (gaps.reduce((a, b) => a + b, 0) / 1000);
    timing = ` fps=${fps.toFixed(0)} frame_ms p50=${at(0.5)} p99=${at(0.99)} max=${gaps.at(-1).toFixed(1)}`;
  }
  frameGaps = [];
  const health = `workers=${workers.size} busy=${busyWorkers} frames=${frames}${timing}${memory}`;
  $('#debug-health').textContent = health;
  log('HEALTH', health);
}, 10000);

// ---- Boot ----
async function boot() {
  log('HOST', navigator.userAgent, `isolated=${crossOriginIsolated} webgpu=${!!navigator.gpu}`);
  const settings = await settingsReady;
  // The game's resources are the player's Horizon install, imported in the launcher.
  const imported = await resources.installed();
  if (!imported) { location.replace('./?resources=missing'); return; }
  log('HOST', `resources: Minecraft ${imported.minecraft}, ${imported.files} files, ${imported.sounds} sounds, imported ${new Date(imported.importedAt).toISOString()}`);
  // The engine fetches its two bundles by URL (resource_io/browser.rs): answered from OPFS.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const kind = /\/(menu|world)-resources\.bin$/.exec(url.pathname)?.[1];
    if (kind && url.origin === location.origin) {
      const file = await resources.bundle(kind);
      if (file) return new Response(file, {headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size)}});
    }
    return nativeFetch(input, init);
  };
  if (!crossOriginIsolated) throw new Error(t('errIsolation'));
  if (!navigator.gpu) throw new Error(t('errGpu'));
  if (!store.opfsSupported()) throw new Error(t('errOpfs'));

  // One game per browser: two would write the same OPFS files.
  const lockReady = new Promise(resolve => {
    navigator.locks.request('horizon-game', {ifAvailable: true}, lock => {
      resolve(!!lock);
      return lock ? new Promise(() => {}) : undefined;
    });
  });
  if (!await lockReady) throw new Error(t('errTwoTabs'));

  // The engine downloads and compiles while the saves are read: neither waits for the other.
  const want64 = settings.wasm64;
  const compile = dir => WebAssembly.compileStreaming(fetch(new URL(`./${dir}/horizon_client_bg.wasm`, location.href)));
  let compiled = compile(want64 ? 'pkg64' : 'pkg');
  compiled.catch(() => {});
  setStage(t('readingSaves'));
  const restoreStarted = performance.now();
  await store.restoreForGame(log);
  log('HOST', `saves read in ${((performance.now() - restoreStarted) / 1000).toFixed(2)}s`);
  await sounds.exposeToGame(log).catch(error => log('WARN', `sounds not listed: ${error}`));

  let module = null;
  if (want64) {
    try {
      module = await import('./pkg64/horizon_client.js');
      await compiled;
      log('HOST', 'experimental wasm64 build');
    } catch (error) {
      log('WARN', `wasm64 build unavailable (${error}); using wasm32`);
      module = null;
      compiled = compile('pkg');
    }
  }
  module ??= await import('./pkg/horizon_client.js');
  globalThis.horizonRandomFill = len => {
    const out = new Uint8Array(len);
    for (let at = 0; at < len; at += 65536) crypto.getRandomValues(out.subarray(at, Math.min(len, at + 65536)));
    return out;
  };

  setStage(t('loadingWasm'));
  const wasm = await module.default({module_or_path: await compiled});
  window.horizonWasmMemory = wasm?.memory;
  flushSession = store.startPersistence(module, log, {memory: wasm?.memory});
  window.horizonSessionResident = () => module.horizon_session_resident?.();
  // Playing together (peer.js) is off until the WebRTC connection works across
  // networks: no channel opened between two machines in testing.
  if (PEER_ENABLED) {
    peer.attach(module, log);
    setupPeer();
  }

  // The launcher's worker count applies on start; in-game changes flow back to it.
  if (settings.workers >= 1) module.horizon_set_workers(settings.workers);
  // A count picked in the game's settings becomes the launcher's; "auto" stays auto
  // until then (the first reading is what auto chose).
  let workers = settings.workers;
  setInterval(() => {
    const now = module.horizon_get_workers?.();
    if (!now) return;
    if (!workers) { workers = now; return; }
    if (now !== workers) {
      workers = now;
      prefs.load().then(latest => prefs.save({...latest, workers: now}));
    }
  }, 2000);
  log('HOST', 'WASM initialised; Rust start-up continues asynchronously');
}
boot().catch(window.horizonFailure);
