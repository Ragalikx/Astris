// The Astris launcher: the game's resources (the player's Horizon install, imported once),
// engine and Minecraft version, settings (kept in OPFS by settings.js), launch logs, packs.
// "Play" opens play.html, where the game takes the whole viewport.
import * as store from './session-store.js';
import * as logs from './launch-logs.js';
import * as prefs from './settings.js';
import {t, setLang, apply, LANGUAGES, locale} from './i18n.js';
import {icon, fillIcons} from './icons.js';
import {startSky} from './sky.js';
import {analyze} from './log-view.js';
import * as resources from './horizon-import.js';

const LAUNCHER_VERSION = '0.1.0';
const GITHUB_URL = 'https://github.com/Ragalikx/Astris';
// Where "What is Horizon?" leads: the project whose launcher prepares the game's resources.
const HORIZON_URL = 'https://github.com/horizon-rust/horizon#readme';
// The engine build the launcher ships with.

// What Astris is made of, for the licences window: the engine, the libraries built into
// it, the fonts and icons, and the game's own files (the player's copy).
const LICENCE_TEXT = {
  'MIT': 'https://opensource.org/license/mit',
  'Apache-2.0': 'https://www.apache.org/licenses/LICENSE-2.0',
  'MPL-2.0': 'https://www.mozilla.org/MPL/2.0/',
  'OFL-1.1': 'https://openfontlicense.org/open-font-license-official-text/',
  'Zlib': 'https://zlib.net/zlib_license.html',
};
const SOURCES = [
  {name: 'Horizon', kind: 'engine', by: 'Ludovic Marie', team: true, licence: ['MIT'], url: 'https://github.com/horizon-rust/horizon'},
  {name: 'wgpu, naga', kind: 'graphics', by: 'gfx-rs', team: true, licence: ['MIT', 'Apache-2.0'], url: 'https://github.com/gfx-rs/wgpu'},
  {name: 'winit', kind: 'window', by: 'rust-windowing', team: true, licence: ['Apache-2.0'], url: 'https://github.com/rust-windowing/winit'},
  {name: 'wasm-bindgen, js-sys, web-sys', kind: 'web', by: 'wasm-bindgen', team: true, licence: ['MIT', 'Apache-2.0'], url: 'https://github.com/wasm-bindgen/wasm-bindgen'},
  {name: 'wasm_thread', kind: 'threads', by: 'chemicstry', licence: ['MIT', 'Apache-2.0'], url: 'https://github.com/chemicstry/wasm_thread'},
  {name: 'Symphonia', kind: 'sound', by: 'Philip Deljanov', team: true, licence: ['MPL-2.0'], url: 'https://github.com/pdeljanov/Symphonia'},
  {name: 'glam', kind: 'math', by: 'Cameron Hart', team: true, licence: ['MIT', 'Apache-2.0'], url: 'https://github.com/bitshifter/glam-rs'},
  {name: 'flate2, miniz_oxide', kind: 'compression', by: 'rust-lang, Frommi', team: true, licence: ['MIT', 'Apache-2.0', 'Zlib'], url: 'https://github.com/rust-lang/flate2-rs'},
  {name: 'png', kind: 'images', by: 'image-rs', team: true, licence: ['MIT', 'Apache-2.0'], url: 'https://github.com/image-rs/image-png'},
  {name: 'serde', kind: 'data', by: 'Erick Tryzelaar, David Tolnay', licence: ['MIT', 'Apache-2.0'], url: 'https://github.com/serde-rs/serde'},
  {name: 'Inter', kind: 'font', by: 'Rasmus Andersson', licence: ['OFL-1.1'], url: 'https://github.com/rsms/inter'},
  {name: 'JetBrains Mono', kind: 'font', by: 'JetBrains', licence: ['OFL-1.1'], url: 'https://github.com/JetBrains/JetBrainsMono'},
  {name: 'Pixelify Sans', kind: 'font', by: 'The Pixelify Sans Project Authors', licence: ['OFL-1.1'], url: 'https://github.com/eifetx/Pixelify-Sans'},
  {name: 'Octicons', kind: 'icons', by: 'GitHub', licence: ['MIT'], url: 'https://github.com/primer/octicons'},
  {name: 'Minecraft', kind: 'game', by: 'Mojang Studios', licence: [], url: 'https://www.minecraft.net/'},
];

const $ = s => document.querySelector(s);

// ---- The launcher's own log: what it saw and did, in the game log's format (log-view.js
// reads both), kept in OPFS beside the launch logs and sent to the dev server's /log. ----
const launcherLog = logs.createLaunchLog(Date.now(), 'launcher');
const LOG_SESSION = `launcher-${launcherLog.name.split('.')[0]}`;
const LOG_STARTED = performance.now();
const launcherLines = [];
// A dev server is reached by localhost or by an IP address; a real host has a name.
const LOG_REMOTE = location.hostname === 'localhost' || /^[\d.]+$|^\[[\da-f:]+\]$/i.test(location.hostname) || location.hostname.endsWith('.ts.net') || new URLSearchParams(location.search).get('debug') === '1';
let logPending = [], logTimer = 0;
const stringify = v => v instanceof Error ? `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`
  : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
function llog(level, ...args) {
  const line = `${new Date().toISOString()} +${((performance.now() - LOG_STARTED) / 1000).toFixed(3)}s [${level}] ${args.map(stringify).join(' ')}`;
  launcherLines.push(line);
  if (launcherLines.length > 5000) launcherLines.splice(0, 1000);
  logPending.push(line);
  if (!logTimer) logTimer = setTimeout(flushLauncherLog, 1000);
}
function flushLauncherLog() {
  clearTimeout(logTimer);
  logTimer = 0;
  if (logPending.length && LOG_REMOTE) {
    try { navigator.sendBeacon(`/log?session=${LOG_SESSION}`, logPending.join('\n') + '\n'); } catch (_) {}
  }
  logPending = [];
  return launcherLog.save(launcherLines.join('\n') + '\n');
}
addEventListener('error', event => llog('ERROR', `uncaught: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`, event.error?.stack || ''));
addEventListener('unhandledrejection', event => llog('ERROR', 'unhandled rejection:', event.reason));
addEventListener('pagehide', () => { flushLauncherLog(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) flushLauncherLog(); });

// What the browser keeps for the site: the estimate and the top of OPFS with sizes.
async function logStorage(why) {
  try {
    const {usage = 0, quota = 0, usageDetails = {}} = await navigator.storage.estimate();
    llog('HOST', `storage (${why}): ${formatBytes(usage)} used of ${formatBytes(quota)}`, usageDetails);
    const top = await navigator.storage.getDirectory();
    const entries = [];
    for await (const [name, entry] of top.entries()) {
      const bytes = entry.kind === 'file' ? await entry.getFile().then(f => f.size, () => 0) : await folderBytes(entry);
      entries.push(`${name}${entry.kind === 'directory' ? '/' : ''} ${formatBytes(bytes)}`);
    }
    llog('HOST', `OPFS: ${entries.join(', ') || 'empty'}`);
  } catch (error) { llog('WARN', `storage (${why}) unknown:`, error); }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let settings = {...prefs.DEFAULTS};
let imported = null, browserOk = true, sky = null;

function update(patch) {
  settings = {...settings, ...patch};
  prefs.save(settings);
}

// ---- Language ----
// The top bar's language menu.
function renderLangMenu() {
  const picker = $('#lang-picker');
  const button = picker.querySelector('.lang-button');
  const list = $('#lang-list');
  const show = open => { list.hidden = !open; button.setAttribute('aria-expanded', String(open)); };
  $('#lang-value').textContent = LANGUAGES.find(([code]) => code === settings.lang)[1];
  list.replaceChildren(...LANGUAGES.map(([code, label]) => {
    const item = el('li', {}, el('button', {type: 'button', textContent: `${label} · ${LANGUAGE_NAMES[code]}`}));
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(code === settings.lang));
    item.firstChild.onclick = () => { show(false); update({lang: code}); renderAll(); };
    return item;
  }));
  button.onclick = () => show(list.hidden);
  if (!picker.dataset.wired) {
    picker.dataset.wired = '1';
    document.addEventListener('click', event => { if (!picker.contains(event.target)) show(false); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') show(false); });
  }
}
const LANGUAGE_NAMES = {en: 'English', ru: 'Русский', uk: 'Українська'};

// ---- The game's resources and the Play button ----
// Top right: what is imported, or that the Horizon folder is still needed.
function renderResources() {
  const chip = $('#resources-chip');
  chip.className = `account-chip ${imported ? '' : 'signed-out'}`;
  chip.replaceChildren(icon('box'), el('span', {className: 'who'},
    el('b', {textContent: imported ? `Minecraft ${imported.minecraft}` : t('resourcesNeeded')}),
    el('span', {className: imported ? 'licence-ok' : 'licence-bad',
      textContent: imported ? t('resourcesReady', {date: when(new Date(imported.importedAt))}) : t('resourcesPick')})));
  chip.onclick = () => openImport();
  $('#play').disabled = !browserOk;
}

function play() {
  llog('HOST', `play clicked: ${imported ? `imported ${imported.minecraft} at ${new Date(imported.importedAt).toISOString()}` : 'nothing imported, opening the import window'}`);
  try {
    if (!imported) { openImport(); return; }
    // The game page needs the CPU and GPU from the first moment: the sky goes now.
    sky?.stop();
    flushLauncherLog();
    location.href = './play.html';
  } catch (error) { llog('ERROR', 'play failed:', error); }
}

// The import window: what Horizon is, where its prepared folder lies, then a log of the copy.
// One line of the import log; problems in red, the end in green.
function importLog(line, kind = /^error\b/.test(line) ? 'err' : /^done\b/.test(line) ? 'ok' : '') {
  llog(kind === 'err' ? 'ERROR' : kind === 'ok' ? 'STAGE' : 'INFO', `import: ${line}`);
  const box = $('#imp-log');
  box.append(el('div', {className: kind, textContent: line}));
  box.scrollTop = box.scrollHeight;
}
function showImportStage(stage) {
  $('#imp-intro').hidden = stage !== 'intro';
  $('#imp-run').hidden = stage === 'intro';
}
// Where the Horizon launcher keeps its builds (launcher/src/backend.rs data_dir: the
// system's data folder + horizon-launcher), for the player's system.
function horizonPaths() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  if (platform.includes('mac')) return {path: '~/Library/Application Support/horizon-launcher/versions/<build>/.local/horizon-client/26.3'};
  if (platform.includes('linux')) return {path: '~/.local/share/horizon-launcher/versions/<build>/.local/horizon-client/26.3'};
  return {path: 'C:\\Users\\<user>\\AppData\\Roaming\\horizon-launcher\\versions\\<build>\\.local\\horizon-client\\26.3'};
}
function openImport() {
  const where = horizonPaths();
  $('#imp-path').textContent = where.path;
  showImportStage('intro');
  $('#imp-log').replaceChildren();
  $('#imp-status').textContent = '';
  $('#imp-pick').disabled = false;
  $('#imp-scan').hidden = true;
  showImportMode?.();
  openWindow('import');
}
const MiB = n => (n / 1048576).toFixed(0);
// Set up by setupImportWindow: imports from a server's address.
let importFromNetwork = null, showImportMode = null;
function setupImportWindow() {
  $('#imp-what').href = HORIZON_URL;
  const folderInput = $('#imp-folder');
  const bar = $('#imp-bar');
  const text = $('#imp-progress-text');
  bar.replaceChildren(...Array.from({length: 24}, () => document.createElement('span')));
  $('#imp-wait').replaceChildren(...Array.from({length: 24}, (_, i) => Object.assign(document.createElement('span'), {style: `--i:${i}`})));
  const setBar = fraction => {
    const p = Math.max(0, Math.min(1, fraction));
    const lit = Math.floor(p * 24 + 1e-9);
    for (const [i, block] of [...bar.children].entries()) block.classList.toggle('on', i < lit);
    bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  };
  // The wave steps one block at a time across whatever width the window has.

  // The run stage: the explanation leaves and the progress and the log take the window.
  // `waiting` shows the block wave instead of the bar, for steps with no measure (the
  // browser listing the folder, the folder being checked).
  const phase = (message, {waiting = false} = {}) => {
    showImportStage('run');
    $('#imp-wait').hidden = !waiting;
    bar.hidden = waiting;
    text.textContent = message;
    $('#imp-done').hidden = true;
    $('#imp-back').hidden = true;
  };
  const failed = message => {
    importLog(message, 'err');
    $('#imp-wait').hidden = true;
    bar.hidden = true;
    text.textContent = message;
    $('#imp-back').hidden = false;
  };

  // Without showDirectoryPicker (Brave, Firefox) the folder upload lists every file before
  // the page hears of it: the page getting the focus back means a folder was chosen.
  let choosing = false, chosenAt = 0;
  folderInput.oncancel = () => {
    if (!choosing && $('#imp-run').hidden) return;
    importLog('folder pick cancelled');
    choosing = false;
    showImportStage('intro');
    $('#imp-scan').hidden = true;
    $('#imp-pick').disabled = false;
  };
  addEventListener('focus', () => {
    if (!choosing) return;
    // The cancel event comes just after the focus: a moment is given to it first.
    setTimeout(() => {
      if (!choosing) return;
      choosing = false;
      chosenAt = performance.now();
      importLog('folder chosen, waiting for the browser');
      phase(t('importBrowserListing'), {waiting: true});
    }, 250);
  });
  // A ZIP of the prepared folder: read in the browser, file by file as it is copied.
  $('#imp-zip').onchange = async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    remote = false;
    $('#imp-log').replaceChildren();
    phase(t('importLooking'), {waiting: true});
    importLog(`zip: ${file.name}, ${(file.size / 1048576).toFixed(1)} MiB`);
    try {
      await examine(await resources.fromZip(file, file.name));
    } catch (error) {
      importLog(`error: ${error.message}`);
      failed(t('importFailed', {error: error.message}));
    }
  };
  folderInput.onchange = () => {
    choosing = false;
    const files = folderInput.files;
    if (chosenAt) importLog(`browser handed over ${files.length} files after ${((performance.now() - chosenAt) / 1000).toFixed(1)} s`);
    if (files.length) examine(resources.fromFileList(files));
    folderInput.value = '';
  };
  $('#imp-pick').onclick = async () => {
    remote = false;
    $('#imp-log').replaceChildren();
    if (!resources.pickSupported()) {
      importLog('folder window opened');
      $('#imp-scan-text').textContent = t('importChoose');
      $('#imp-scan').hidden = false;
      $('#imp-pick').disabled = true;
      choosing = true;
      chosenAt = 0;
      folderInput.click();
      return;
    }
    let handle;
    try { handle = await window.showDirectoryPicker({id: 'horizon', mode: 'read'}); }
    catch (error) { if (error.name !== 'AbortError') $('#imp-status').textContent = error.message; return; }
    examine(handle);
  };

  // The picked folder is checked, and when it holds a prepared 26.3 the copy starts
  // right away; anything else ends on its reason and Back.
  async function examine(handle) {
    phase(t('importLooking'), {waiting: true});
    importLog(`picked: ${handle.name}`);
    let dir;
    try {
      const found = await resources.locate(handle, importLog);
      if (found.mods.length) importLog(t('importMods'));
      if (!found.dir) { failed(t(found.unprepared ? 'importUnprepared' : 'importNotFound')); return; }
      const manifest = await resources.readManifest(found.dir);
      importLog(t('importFound', {mc: manifest.minecraft}));
      dir = found.dir;
    } catch (error) {
      importLog(`error: ${error.message}`);
      failed(error.code === 'version' ? t('importWrongVersion', {found: error.found, want: resources.MINECRAFT})
        : error.code === 'schema' ? t('importWrongSchema', {found: error.found}) : t('importFailed', {error: error.message}));
      return;
    }
    await copy(dir);
  }

  // Phones and tablets cannot hand a browser a folder, so they start on the online install.
  let mode = matchMedia('(pointer: coarse)').matches && !resources.pickSupported() ? 'online' : 'local';
  const showMode = () => {
    segmented($('#imp-mode'), [['local', t('localMode')], ['online', t('onlineMode')]], mode, value => { mode = value; showMode(); });
    $('#imp-online').hidden = mode !== 'online';
    $('#imp-local').hidden = mode !== 'local';
    $('#imp-net-url').value = settings.netUrl;
    $('#imp-net-consent').checked = settings.netConsent;
    netReady();
  };
  const netReady = () => {
    $('#imp-net-start').disabled = !$('#imp-net-consent').checked || !/^https?:\/\/./i.test($('#imp-net-url').value.trim());
  };
  $('#imp-net-url').oninput = () => { update({netUrl: $('#imp-net-url').value.trim()}); netReady(); };
  $('#imp-net-consent').onchange = () => { update({netConsent: $('#imp-net-consent').checked}); netReady(); };
  $('#imp-net-start').onclick = () => { if (!$('#imp-net-start').disabled) importFromNetwork($('#imp-net-url').value.trim()); };
  showImportMode = showMode;
  importFromNetwork = async address => {
    remote = true;
    if (!$('#import').open) openImport();
    $('#imp-log').replaceChildren();
    phase(t('netFetching'), {waiting: true});
    importLog(`network source: ${address}`);
    try {
      await examine(await resources.fromNetwork(address, importLog));
    } catch (error) {
      importLog(`error: ${error.message}`);
      failed(t('netFailed', {error: error.message}));
    }
  };
  let remote = false;
  async function copy(dir) {
    phase(t(remote ? 'onlinePreparing' : 'importPreparing'), {waiting: true});
    setBar(0);
    try {
      imported = await resources.importFrom(dir, {
        sounds: (remote ? $('#imp-net-sounds') : $('#imp-sounds')).checked,
        log: importLog,
        onProgress: (done, total) => {
          if (!$('#imp-wait').hidden) { $('#imp-wait').hidden = true; bar.hidden = false; }
          setBar(total ? done / total : 1);
          text.textContent = t(remote ? 'onlineProgress' : 'importProgress', {done: MiB(done), total: MiB(total)});
        },
      });
      $('#imp-wait').hidden = true;
      bar.hidden = false;
      setBar(1);
      text.textContent = t(remote ? 'onlineDone' : 'importDone');
      renderResources();
      $('#imp-done').hidden = false;
      $('#imp-done').focus();
    } catch (error) {
      importLog(`error: ${error.message}`);
      failed(error.code === 'space' ? t('importNoSpace', {need: error.message})
        : error.code === 'unreadable' ? t('importUnreadable', {n: error.count})
        : error.name === 'ImportBusy' ? t('importBusy')
        : error.name === 'NoModificationAllowedError' ? t('importLocked')
        : t('importFailed', {error: error.message}));
    }
  }
  $('#imp-back').onclick = () => {
    showImportStage('intro');
    $('#imp-scan').hidden = true;
    $('#imp-pick').disabled = false;
  };
  $('#imp-done').onclick = () => { sky?.stop(); flushLauncherLog(); location.href = './play.html'; };
}

function environmentChecks() {
  const checks = [
    [crossOriginIsolated, 'checkIsolation'],
    [!!navigator.gpu, 'checkGpu'],
    [store.opfsSupported(), 'checkOpfs'],
  ];
  const failed = checks.filter(([ok]) => !ok);
  for (const [, key] of failed) llog('WARN', `browser check failed: ${key}, Play is turned off`);
  $('#checks').replaceChildren(...failed.map(([, key]) => el('div', {textContent: `✕ ${t('unavailable', {what: t(key)})}`})));
  return failed.length === 0;
}

// ---- Licences: every source on the left, the picked one's card on the right ----
let licencePicked = 0;
function renderLicences() {
  $('#lic-list').replaceChildren(...SOURCES.map((source, i) => {
    const button = el('button', {type: 'button'}, el('b', {textContent: source.name}), el('span', {textContent: t(`lic_${source.kind}`)}));
    button.setAttribute('aria-pressed', String(i === licencePicked));
    button.onclick = () => { licencePicked = i; renderLicences(); };
    return el('li', {}, button);
  }));
  const source = SOURCES[licencePicked];
  const link = (href, text) => el('a', {href, textContent: text, target: '_blank', rel: 'noopener noreferrer'});
  const rows = [
    el('h3', {textContent: source.name}),
    el('p', {className: 'muted', textContent: t(`lic_${source.kind}`)}),
    el('dl', {},
      el('dt', {textContent: t('licBy')}), el('dd', {textContent: source.team ? t('licTeam', {name: source.by}) : source.by}),
      el('dt', {textContent: t('licLicence')}),
      el('dd', {}, ...(source.licence.length
        ? source.licence.flatMap((id, i) => [i ? document.createTextNode(` ${t('licOr')} `) : '', link(LICENCE_TEXT[id], id)])
        : [document.createTextNode(t('licGameTerms'))])),
      el('dt', {textContent: t('licSource')}), el('dd', {}, link(source.url, source.url.replace(/^https:\/\//, '')))),
  ];
  if (source.kind === 'game') rows.push(el('p', {textContent: t('licGameNote')}), el('p', {className: 'muted', textContent: t('disclaimer')}));
  $('#lic-card').replaceChildren(...rows);
}

// ---- Last launch card ----
let logEntries = [];
const when = date => date.toLocaleString(locale(), {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});

async function loadLogs() {
  try {
    logEntries = await logs.list();
    await Promise.all(logEntries.map(async entry => { entry.report = analyze(await logs.read(entry.name)); }));
  } catch (_) { logEntries = []; }
  renderLastLaunch();
  if ($('#settings').open) renderLogList();
}

function badge(report) {
  if (report.fatal) return ['bad', t('launchFailed')];
  const problems = report.errors + report.warnings;
  if (problems) return [report.errors ? 'bad' : 'warn', t('launchProblems', {n: problems})];
  if (report.firstFrame != null) return ['ok', t('launchOk', {s: report.firstFrame.toFixed(1)})];
  return ['ok', t('noProblems')];
}

function renderLastLaunch() {
  const box = $('#last-launch');
  const last = logEntries.find(entry => entry.kind !== 'launcher');
  if (!last) { box.replaceChildren(el('span', {className: 'muted', textContent: t('noLaunches')})); return; }
  const [cls, text] = badge(last.report);
  box.replaceChildren(el('b', {textContent: when(last.started)}), el('span', {className: `badge ${cls}`, textContent: text}));
}

// ---- The server guide ----
// Python, coloured for reading: keywords, strings, comments, numbers, called names. Nodes
// are built as text, never parsed as HTML.
const PY_KEYWORDS = new Set('and as class def elif else for from if import in is not or pass return self super while with None True False'.split(' '));
function highlightPython(pre) {
  const source = pre.textContent;
  const token = /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(\d+)\b|\b([A-Za-z_]\w*)\b(?=\s*\()|\b([A-Za-z_]\w*)\b/g;
  const parts = [];
  let at = 0, match;
  while ((match = token.exec(source))) {
    if (match.index > at) parts.push(document.createTextNode(source.slice(at, match.index)));
    const [text, comment, string, number, called, word] = match;
    const kind = comment ? 'com' : string ? 'str' : number ? 'num' : called ? (PY_KEYWORDS.has(called) ? 'kw' : 'fn') : PY_KEYWORDS.has(word) ? 'kw' : '';
    parts.push(kind ? el('span', {className: kind, textContent: text}) : document.createTextNode(text));
    at = match.index + text.length;
  }
  parts.push(document.createTextNode(source.slice(at)));
  pre.replaceChildren(...parts);
}
let guideReady = false;
function setupGuide() {
  if (guideReady) return;
  guideReady = true;
  for (const pre of document.querySelectorAll('#guide pre[data-lang="python"]')) highlightPython(pre);
  const button = $('#guide-open'), panel = $('#guide');
  const show = open => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  // Opened by a click on its button, it stays until closed: its cross, Esc, a click
  // outside it, or the settings window closing.
  button.onclick = () => show(true);
  $('#guide-close').onclick = () => show(false);
  const settings = $('#settings');
  settings.addEventListener('pointerdown', event => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) show(false);
  });
  settings.addEventListener('cancel', event => {
    if (!panel.hidden) { event.preventDefault(); show(false); }
  });
  settings.addEventListener('close', () => show(false));
}

// ---- Settings window ----
function openWindow(id, tab) {
  const dialog = document.getElementById(id);
  if (id === 'settings') { renderSettings(); selectTab(tab || 'general'); }
  if (!dialog.open) dialog.showModal();
  // Under a window the sky is blurred away: it rests, so the browser does not redraw and
  // re-blur the whole screen every frame behind the window.
  sky?.setMotion(false);
}

function selectTab(name) {
  for (const button of document.querySelectorAll('.tab-list [data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === name));
  for (const panel of document.querySelectorAll('.tab[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  if (name === 'logs') renderLogList();
  if (name === 'data') renderUsage();
}

function segmented(box, options, selected, onPick) {
  box.replaceChildren(...options.map(([value, label]) => {
    const button = el('button', {type: 'button', textContent: label});
    button.setAttribute('aria-pressed', String(value === selected));
    button.onclick = () => onPick(value);
    return button;
  }));
}

function renderSettings() {
  const nick = $('#nickname');
  nick.value = settings.nickname;
  nick.placeholder = 'Steve';
  nick.oninput = () => {
    if (nick.value && !nick.checkValidity()) return;
    update({nickname: nick.value.trim()});
  };
  // The network source: only with the player's word that they know the risks.
  const netUrl = $('#net-url'), consent = $('#net-consent'), netImport = $('#net-import');
  netUrl.value = settings.netUrl;
  consent.checked = settings.netConsent;
  const netReady = () => { netImport.disabled = !consent.checked || !/^https?:\/\/./i.test(netUrl.value.trim()); };
  netReady();
  netUrl.oninput = () => { update({netUrl: netUrl.value.trim()}); netReady(); };
  consent.onchange = () => { update({netConsent: consent.checked}); netReady(); };
  netImport.onclick = () => {
    if (netImport.disabled) return;
    $('#settings').close();
    importFromNetwork(netUrl.value.trim());
  };
  setupGuide();
  const cap = $('#frame-cap');
  cap.checked = settings.frameCap;
  cap.onchange = () => update({frameCap: cap.checked});
  const motion = $('#motion');
  motion.checked = settings.motion;
  motion.onchange = () => { update({motion: motion.checked}); sky?.setMotion(motion.checked); };

  // Worker threads: a slider of eight blocks, or "Auto" (what the game then picks:
  // half of this device's threads, 2 to 6, as graphics.rs does).
  const autoWorkers = Math.min(6, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  const slider = $('#workers'), auto = $('#workers-auto');
  // The slider runs 0-8 so value n puts the thumb on the edge after the nth block;
  // 0 is not a count, so it snaps back to 1.
  const showWorkers = () => {
    const n = settings.workers || autoWorkers;
    slider.value = String(n);
    slider.style.setProperty('--fill', String(n / 8));
    slider.classList.toggle('is-auto', !settings.workers);
    auto.checked = !settings.workers;
    $('#workers-val').textContent = settings.workers ? String(n) : `${t('autoCap')} · ${n}`;
  };
  showWorkers();
  slider.oninput = () => { update({workers: Math.max(1, Number(slider.value))}); showWorkers(); };
  auto.onchange = () => { update({workers: auto.checked ? 0 : Number(slider.value)}); showWorkers(); };
  $('#wasm64-link').onclick = event => { event.preventDefault(); selectTab('experimental'); };

  // Memory: the same block slider, one block per size the build can address.
  const memSlider = $('#memory'), memAuto = $('#memory-auto');
  const sizes = () => (settings.wasm64 ? [1, 2, 3, 4, 6, 8] : [1, 2, 3, 4]);
  const memory = () => {
    const steps = sizes();
    if (!steps.includes(settings.memoryGiB) && settings.memoryGiB) update({memoryGiB: steps.at(-1)});
    // As for the threads: value k (1..) is the edge after the kth block, size steps[k - 1].
    const at = settings.memoryGiB ? steps.indexOf(settings.memoryGiB) + 1 : steps.length;
    memSlider.max = String(steps.length);
    memSlider.value = String(at);
    memSlider.style.setProperty('--block', `${100 / steps.length}%`);
    memSlider.style.setProperty('--fill', String(at / steps.length));
    memSlider.classList.toggle('is-auto', !settings.memoryGiB);
    memAuto.checked = !settings.memoryGiB;
    $('#memory-val').textContent = settings.memoryGiB ? `${settings.memoryGiB} GB` : t('autoCap');
  };
  const memPick = () => sizes()[Math.max(1, Number(memSlider.value)) - 1];
  memSlider.oninput = () => { update({memoryGiB: memPick()}); memory(); };
  memAuto.onchange = () => { update({memoryGiB: memAuto.checked ? 0 : memPick()}); memory(); };
  memory();

  const keep = $('#log-keep');
  keep.value = String(settings.logKeep);
  keep.onchange = () => {
    const n = Math.round(Number(keep.value));
    if (n >= 1 && n <= 100) {
      update({logKeep: n});
      logs.prune(n, launcherLog.name).then(loadLogs);
    }
    keep.value = String(settings.logKeep);
  };

  const box = $('#wasm64');
  let supported = false;
  try { supported = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 7, 0, 0])); } catch (_) {}
  box.checked = supported && settings.wasm64;
  box.disabled = !supported;
  $('#wasm64-note').textContent = supported ? t('wasm64Hint') : t('wasm64Unsupported');
  box.onchange = () => { update({wasm64: box.checked}); memory(); };
  $('#touch').checked = settings.touch;
  $('#touch').onchange = () => update({touch: $('#touch').checked});
}

// What the game's folder (opfs-worker.js's horizon-session) and the launcher keep, by kind.
const GAME_ROOT = 'horizon-session';
const CATEGORIES = [['resources', 'catResources', '#c9a86b'], ['worlds', 'catWorlds', '#5aa83f'], ['settings', 'catSettings', '#e0b45a'], ['packs', 'catPacks', '#6fa8dc'],
  ['game', 'catGame', '#9b8fd8'], ['logs', 'catLogs', '#c27a5a'], ['other', 'catOther', '#4c4f5a']];

async function folderBytes(dir) {
  let bytes = 0;
  for await (const entry of dir.values()) {
    try { bytes += entry.kind === 'file' ? (await entry.getFile()).size : await folderBytes(entry); } catch (_) {}
  }
  return bytes;
}

async function storageBreakdown() {
  const sizes = Object.fromEntries(CATEGORIES.map(([key]) => [key, 0]));
  const top = await navigator.storage.getDirectory();
  for await (const [name, entry] of top.entries()) {
    if (name === GAME_ROOT && entry.kind === 'directory') {
      for await (const [inner, item] of entry.entries()) {
        const bytes = item.kind === 'file' ? await item.getFile().then(f => f.size, () => 0) : await folderBytes(item);
        const kind = inner === 'saves' ? 'worlds'
          : inner === 'resourcepacks' || inner === 'shaderpacks' ? 'packs'
          : item.kind === 'file' && /\.(txt|json|dat|nbt|toml)$/i.test(inner) ? 'settings' : 'game';
        sizes[kind] += bytes;
      }
    } else if (name === 'astris-resources' || name === 'astris-sounds') sizes.resources += await folderBytes(entry);
    else if (name === 'astris-logs') sizes.logs += await folderBytes(entry);
    else if (name === 'astris-settings.json') sizes.settings += await entry.getFile().then(f => f.size, () => 0);
    else sizes.game += entry.kind === 'file' ? await entry.getFile().then(f => f.size, () => 0) : await folderBytes(entry);
  }
  return sizes;
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i && bytes < 10 ? 1 : 0)} ${units[i]}`;
}

let manageKind = null;

async function renderUsage() {
  // Walking every world file takes a while: a block wave stands in for the bar meanwhile.
  if (!$('#usage-bar').children.length || $('#usage-bar').dataset.loading) {
    $('#usage-bar').dataset.loading = '1';
    $('#usage-bar').replaceChildren(...Array.from({length: 24}, (_, i) => el('span', {className: 'wave', style: `--i:${i}`})));
  }
  const {usage, quota, details} = await store.usage();
  $('#usage').textContent = t('usedOf', {used: formatBytes(usage), quota: quota ? formatBytes(quota) : '?'});
  let sizes;
  try { sizes = await storageBreakdown(); } catch (_) { sizes = null; }
  const counted = sizes ? Object.values(sizes).reduce((a, b) => a + b, 0) : 0;
  const used = Math.max(usage, counted);
  $('#usage').textContent = t('usedOf', {used: formatBytes(used), quota: quota ? formatBytes(quota) : '?'});
  $('#usage-percent').textContent = quota ? `${(used / quota * 100).toFixed(used / quota < 0.1 ? 1 : 0)}%` : '';
  delete $('#usage-bar').dataset.loading;
  if (!sizes) return;
  // What the browser counts beyond the files (caches, IndexedDB, leftovers of copies it
  // has not let go of yet): the files are walked, the rest is only its word.
  sizes.other += Math.max(0, usage - counted);
  const hidden = Object.entries(details || {}).map(([kind, n]) => `${kind}: ${formatBytes(n)}`).join(', ');
  $('#usage-other').hidden = sizes.other < 64 << 20;
  $('#usage-other').textContent = t('otherHint', {size: formatBytes(sizes.other)}) + (hidden ? ` (${hidden})` : '');
  // The bar is the whole quota: the parts are what is used, the rest is free.
  const whole = Math.max(quota, used, 1);
  $('#usage-bar').replaceChildren(...CATEGORIES.filter(([key]) => sizes[key] > 0).map(([key, label, color]) => {
    const part = el('span', {title: `${t(label)}: ${formatBytes(sizes[key])}`});
    part.style.cssText = `width:${sizes[key] / whole * 100}%;background:${color}`;
    return part;
  }));
  $('#usage-legend').replaceChildren(...CATEGORIES.map(([key, label, color]) => {
    const swatch = el('i');
    swatch.style.background = color;
    const name = el('span', {textContent: t(label)});
    return el('li', {}, swatch, name, el('b', {textContent: formatBytes(sizes[key])}),
      el('em', {textContent: `${(sizes[key] / Math.max(used, 1) * 100).toFixed(sizes[key] / Math.max(used, 1) < 0.1 ? 1 : 0)}%`}));
  }));
  renderManage();
}

// The Data tab's preview: worlds, packs and the other game files, each with its size.
async function renderManage() {
  const box = $('#usage-manage');
  box.hidden = false;
  const parts = [];
  for (const kind of ['worlds', 'packs', 'game']) parts.push(await manageList(kind));
  box.replaceChildren(...parts);
}

async function manageList(manageKind) {
  const game = await (await navigator.storage.getDirectory()).getDirectoryHandle(GAME_ROOT, {create: true});
  const title = el('h3', {className: 'manage-title', textContent: t({worlds: 'catWorlds', packs: 'catPacks', game: 'catGame'}[manageKind])});
  const box = el('section', {className: 'manage-part'}, title);
  if (manageKind === 'game') {
    const items = [];
    for await (const [name, entry] of game.entries()) {
      if (['saves', 'resourcepacks', 'shaderpacks'].includes(name)) continue;
      if (entry.kind === 'file' && /\.(txt|json|dat|nbt|toml)$/i.test(name)) continue;
      const bytes = entry.kind === 'file' ? await entry.getFile().then(f => f.size, () => 0) : await folderBytes(entry);
      items.push(el('li', {}, el('span', {className: 'manage-name', textContent: entry.kind === 'directory' ? `${name}/` : name}),
        el('span', {className: 'hint', textContent: formatBytes(bytes)})));
    }
    box.append(items.length ? el('ul', {}, ...items) : el('p', {className: 'hint', textContent: t('nothingHere')}));
    return box;
  }
  const folders = manageKind === 'worlds' ? ['saves'] : ['resourcepacks', 'shaderpacks'];
  const items = [];
  for (const folder of folders) {
    let dir;
    try { dir = await game.getDirectoryHandle(folder); } catch (_) { continue; }
    for await (const [name, entry] of dir.entries()) {
      if (manageKind === 'worlds' && entry.kind !== 'directory') continue;
      const bytes = entry.kind === 'file' ? await entry.getFile().then(f => f.size, () => 0) : await folderBytes(entry);
      items.push({folder, name, bytes});
    }
  }
  items.sort((a, b) => b.bytes - a.bytes);
  if (!items.length) { box.append(el('p', {className: 'hint', textContent: t('nothingHere')})); return box; }
  box.append(el('ul', {}, ...items.map(item => {
    const remove = el('button', {type: 'button', className: 'small-button danger-text', textContent: t('deleteItem')});
    remove.onclick = async () => {
      const ask = manageKind === 'worlds' ? 'deleteWorldConfirm' : 'deletePackConfirm';
      if (!confirm(t(ask, {name: item.name}))) return;
      remove.disabled = true;
      try {
        if (manageKind === 'worlds') await store.removeWorld(item.name);
        else await store.removePack(item.folder, item.name);
      } catch (error) { alert(error.message); }
      renderUsage();
    };
    const kind = item.folder === 'shaderpacks' ? ` · ${t('shaderpack')}` : '';
    return el('li', {}, el('span', {className: 'manage-name', textContent: item.name}),
      el('span', {className: 'hint', textContent: formatBytes(item.bytes) + kind}), remove);
  })));
  return box;
}

// ---- Log viewer ----
let viewing = null, filter = 'all';

function renderLogList() {
  const list = $('#log-list');
  if (!logEntries.length) {
    list.replaceChildren(el('li', {className: 'muted', textContent: t('noLaunches')}));
    renderLog();
    return;
  }
  if (!logEntries.some(e => e.name === viewing?.name)) viewing = logEntries[0];
  list.replaceChildren(...logEntries.map(entry => {
    const [cls, text] = badge(entry.report);
    const button = el('button', {type: 'button'},
      el('b', {textContent: when(entry.started)}),
      entry.kind === 'launcher' ? el('span', {className: 'badge', textContent: t('launcherLog')}) : el('span', {className: `badge ${cls}`, textContent: text}),
      el('span', {className: 'muted small', textContent: `${(entry.bytes / 1024).toFixed(1)} KiB`}));
    button.setAttribute('aria-current', String(entry === viewing));
    button.onclick = () => { viewing = entry; renderLogList(); };
    return el('li', {}, button);
  }));
  renderLog();
}

function renderLog() {
  const box = $('#log-lines');
  const report = viewing?.report;
  segmented($('#log-filter'), [['all', t('all')], ['problems', t('problems')], ['stages', t('stages')]], filter, value => { filter = value; renderLog(); });
  if (report) {
    for (const [i, button] of [...$('#log-filter').children].entries()) {
      const n = [report.lines.length, report.errors + report.warnings, report.stages][i];
      button.append(el('span', {className: 'count', textContent: String(n)}));
    }
  }
  if (!report) { box.replaceChildren(el('div', {className: 'log-empty', textContent: t('pickLog')})); $('#log-summary').replaceChildren(); return; }

  const summary = [
    [report.errors ? 'bad' : 'ok', t('errors', {n: report.errors})],
    [report.warnings ? 'warn' : 'ok', t('warnings', {n: report.warnings})],
  ];
  if (report.firstFrame != null) summary.push(['ok', t('firstFrame', {s: report.firstFrame.toFixed(1)})]);
  $('#log-summary').replaceChildren(...summary.map(([cls, text]) => el('span', {className: `badge ${cls}`, textContent: text})));

  const query = $('#log-search').value.trim().toLowerCase();
  const shown = report.lines.filter(line =>
    (filter === 'all' || (filter === 'problems' ? line.kind === 'err' || line.kind === 'warn' : line.kind === 'ok'))
    && (!query || line.raw.toLowerCase().includes(query)));
  if (!shown.length) { box.replaceChildren(el('div', {className: 'log-empty', textContent: t('emptyFilter')})); return; }
  const fragment = document.createDocumentFragment();
  for (const line of shown) {
    const row = el('div', {className: `line ${line.kind}`});
    row.dataset.n = line.n;
    const message = el('span');
    if (line.source) message.append(el('span', {className: 'src', textContent: `${line.source} `, title: line.where}));
    if (query) {
      const lower = line.message.toLowerCase();
      let at = 0;
      for (let hit = lower.indexOf(query); hit >= 0; hit = lower.indexOf(query, at)) {
        message.append(line.message.slice(at, hit), el('mark', {textContent: line.message.slice(hit, hit + query.length)}));
        at = hit + query.length;
      }
      message.append(line.message.slice(at));
    } else message.textContent = line.message;
    row.append(el('span', {className: 'n', textContent: String(line.n)}), el('span', {className: 't', textContent: line.time}), el('span', {className: 'lv', textContent: line.level}), message);
    fragment.append(row);
  }
  box.replaceChildren(fragment);
}

function setupLogViewer() {
  let searchTimer = 0;
  $('#log-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderLog, 120); };
  $('#log-jump').onclick = () => {
    const first = viewing?.report.lines.find(line => line.kind === 'err') ?? viewing?.report.lines.find(line => line.kind === 'warn');
    if (!first) return;
    if (filter === 'stages') { filter = 'all'; renderLog(); }
    const row = $(`#log-lines .line[data-n="${first.n}"]`);
    row?.scrollIntoView({block: 'center'});
    row?.classList.remove('flash');
    void row?.offsetWidth;
    row?.classList.add('flash');
  };
  $('#log-download').onclick = async () => {
    if (!viewing) return;
    const url = URL.createObjectURL(new Blob([await logs.read(viewing.name)], {type: 'text/plain;charset=utf-8'}));
    el('a', {href: url, download: `astris-${viewing.name.replace(/\.gz$/, '')}`}).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
}

// ---- Packs and data ----
function setupImport() {
  for (const input of document.querySelectorAll('input[data-import]')) {
    input.onchange = async () => {
      for (const file of input.files) {
        try {
          await store.importPack(input.dataset.import, file);
          // On for the next launch, as if picked in the game's pack screen.
          await store.enablePack(input.dataset.import, file.name);
          $('#import-status').textContent = t('packEnabled', {name: file.name});
        } catch (error) {
          $('#import-status').textContent = t('addFailed', {name: file.name, error: error.message});
        }
      }
      input.value = '';
    };
  }
  // Everything this site keeps in the browser: the game's files (through its worker,
  // which closes its handles), the rest of OPFS (resources, logs, launcher settings), web
  // storage, the old IndexedDB store and caches.
  $('#clear').onclick = async () => {
    if (!confirm(t('clearConfirm'))) return;
    $('#clear').disabled = true;
    llog('HOST', 'delete all local data');
    await logStorage('before deleting');
    try { await store.clearAll(); } catch (error) { llog('WARN', 'game store clear:', error); }
    try {
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) await root.removeEntry(name, {recursive: true}).catch(error => llog('WARN', `remove ${name}:`, error));
    } catch (error) { llog('WARN', 'OPFS:', error); }
    try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
    try { for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name); } catch (_) {}
    try { for (const key of await caches.keys()) await caches.delete(key); } catch (_) {}
    // And everything the browser keeps for the site that no API reaches, by the
    // server's Clear-Site-Data answer (a host without it just answers 404).
    try {
      const answer = await fetch('./clear-site-data', {method: 'POST', cache: 'no-store'});
      llog('HOST', `clear-site-data: HTTP ${answer.status}${answer.headers.get('Clear-Site-Data') ? ', storage cleared by the browser' : ', not supported by this server'}`);
    } catch (error) { llog('WARN', 'clear-site-data:', error); }
    await logStorage('after deleting');
    // The wipe took this log's file with it: written again before the reload.
    await flushLauncherLog();
    location.reload();
  };
}

// ---- Wiring ----
function renderAll() {
  setLang(settings.lang);
  apply();
  // Shown only now: the page's built-in English would flash before the chosen language.
  document.documentElement.classList.remove('i18n-wait');
  renderLangMenu();
  browserOk = environmentChecks();
  renderResources();
  renderLicences();
  renderLastLaunch();
  if ($('#settings').open) {
    renderSettings();
    const tab = document.querySelector('.tab-list [aria-selected="true"]')?.dataset.tab;
    if (tab) selectTab(tab);
  }
}

async function main() {
  fillIcons();
  for (const mark of document.querySelectorAll('.mark')) mark.append(el('img', {src: './astris-logo.svg', alt: ''}));
  $('#side-github').href = GITHUB_URL;
  for (const button of document.querySelectorAll('[data-open]')) button.onclick = () => openWindow(button.dataset.open, button.dataset.tab);
  for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => button.closest('dialog').close();
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.onclick = event => { if (event.target === dialog) dialog.close(); };
    dialog.addEventListener('close', () => { if (!document.querySelector('dialog[open]')) sky?.setMotion(settings.motion); });
  }
  for (const button of document.querySelectorAll('.tab-list [data-tab]')) button.onclick = () => selectTab(button.dataset.tab);
  setupLogViewer();
  setupImport();
  $('#play').onclick = play;
  setupImportWindow();

  llog('HOST', `launcher ${LAUNCHER_VERSION} at ${location.href}`);
  llog('HOST', navigator.userAgent);
  llog('HOST', `isolated=${crossOriginIsolated} webgpu=${!!navigator.gpu} opfs=${store.opfsSupported()} folderPicker=${resources.pickSupported()} cores=${navigator.hardwareConcurrency} memory=${navigator.deviceMemory ?? '?'}GB`);
  settings = await prefs.load();
  launcherLog.setKeep(settings.logKeep);
  imported = await resources.installed();
  llog('HOST', imported ? `resources: Minecraft ${imported.minecraft}, ${imported.files} files, ${imported.sounds} sounds, imported ${new Date(imported.importedAt).toISOString()}` : 'resources: none imported');
  logStorage('start').then(flushLauncherLog).then(loadLogs);
  sky = startSky($('#sky'), {animate: settings.motion});
  renderAll();
  loadLogs();
  // The game page sends players here when nothing is imported yet.
  if (!imported && new URLSearchParams(location.search).get('resources') === 'missing') openImport();
}
main().then(() => { window.astrisReady = true; });
