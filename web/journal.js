// Reads a launch log (play.js's format: `ISO +12.345s [LEVEL] message`) into lines sorted
// into kinds the viewer colours: err, warn, ok (stages, the first frame), dim (health
// samples), info, head (the header before the first record).
const RECORD = /^(\S+)\s+\+(\d+(?:\.\d+)?)s\s+\[(\w+)\]\s?([\s\S]*)$/;
const ERROR_TEXT = /panicked at|RuntimeError|unreachable executed|Uncaught|out of memory|LinkError/i;

function kindOf(level, message) {
  if (level === 'FATAL' || level === 'ERROR' || ERROR_TEXT.test(message)) return 'err';
  // A pointer lock asked for outside a click: expected, play.js only notes it.
  if (level === 'WARN') return message.startsWith('browser refused:') ? 'dim' : 'warn';
  if (level === 'STAGE' || level === 'NOTICE' || (level === 'HOST' && /first frame|initialised/.test(message))) return 'ok';
  if (level === 'HEALTH' || level === 'DEBUG') return 'dim';
  return 'info';
}

/** {lines: [{n, time, level, message, source, where, kind, raw}], errors, warnings, stages, fatal, firstFrame} */
export function analyze(text) {
  const lines = [];
  let errors = 0, warnings = 0, stages = 0, fatal = false, firstFrame = null;
  for (const [i, raw] of text.split('\n').entries()) {
    if (!raw.trim()) continue;
    const match = RECORD.exec(raw);
    if (!match) {
      // A continuation of the record above (a stack trace) keeps its kind.
      const above = lines.at(-1);
      const kind = above && above.level ? (above.kind === 'err' ? 'err' : above.kind) : 'head';
      lines.push({n: i + 1, time: '', level: '', message: raw, source: '', where: '', kind, raw});
      continue;
    }
    const [, , seconds, level, text] = match;
    const kind = kindOf(level, text);
    // Rust records start `module::path [file:line]: `; the viewer shows the module apart.
    // A worker's record is prefixed with `[its name] ` (empty for the pool's workers).
    const rust = /^(?:\[([^\]]*)\] )?([\w:]+) \[([^\]]+)\]: ([\s\S]*)$/.exec(text);
    const message = rust ? rust[4] : text;
    const worker = rust?.[1] ? `${rust[1]} · ` : '';
    const source = rust ? worker + rust[2].split('::').slice(-2).join('::') : '';
    const where = rust ? `${rust[2]} ${rust[3]}` : '';
    if (kind === 'err') errors++;
    if (kind === 'warn') warnings++;
    if (kind === 'ok') stages++;
    if (level === 'FATAL') fatal = true;
    if (firstFrame == null && level === 'HOST') {
      const frame = /first frame after ([\d.]+)s/.exec(message);
      if (frame) firstFrame = Number(frame[1]);
    }
    lines.push({n: i + 1, time: `+${Number(seconds).toFixed(1)}s`, level, message, source, where, kind, raw});
  }
  return {lines, errors, warnings, stages, fatal, firstFrame};
}
