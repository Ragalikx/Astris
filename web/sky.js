// The Astris backdrop: a pixel-art night sky over a blocky horizon, drawn at a third of the
// screen's resolution at ~15 fps. `setDawn(k)` brightens it toward a Minecraft morning.
const FRAME_MS = 66;

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Sky stops from the zenith to the horizon. */
const SKY = [[3, 4, 7], [6, 7, 12], [10, 12, 19], [17, 19, 28]];
/** The same stops at dawn: Minecraft's day blue over a warm horizon. */
const DAWN = [[64, 104, 168], [104, 146, 214], [156, 186, 228], [236, 196, 160]];

function paintBase(w, h, groundTop) {
  const base = document.createElement('canvas');
  base.width = w;
  base.height = h;
  const ctx = base.getContext('2d');
  // The gradient in bands of 3 pixels, as a texture would be.
  for (let y = 0; y < h; y += 3) {
    const k = Math.min(1, y / groundTop) * (SKY.length - 1);
    const i = Math.min(SKY.length - 2, Math.floor(k));
    ctx.fillStyle = rgb(mix(SKY[i], SKY[i + 1], k - i));
    ctx.fillRect(0, y, w, 3);
  }
  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  const rand = rng(1337);
  const add = (x, y, c, a) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    for (let j = 0; j < 3; j++) px[o + j] = Math.min(255, px[o + j] + (c[j] - px[o + j]) * a);
  };
  // The Milky Way: a soft diagonal band of dust with a darker lane, and dense faint stars.
  const ax = -w * 0.1, ay = h * 0.95, bx = w * 1.1, by = h * 0.05;
  const len = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / len, ny = (bx - ax) / len;
  const width = Math.max(18, h * 0.16);
  for (let y = 0; y < groundTop; y++) {
    for (let x = 0; x < w; x++) {
      const d = (x - ax) * nx + (y - ay) * ny;
      const along = ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (len * len);
      const glow = Math.exp(-((d / width) ** 2)) * (0.55 + 0.45 * Math.sin(along * 9.0 + 1.3));
      const lane = Math.exp(-(((d - width * 0.15) / (width * 0.18)) ** 2)) * 0.6;
      const dust = glow * (1 - lane) * (0.6 + 0.4 * rand());
      if (dust > 0.05) add(x, y, [150, 155, 185], dust * 0.11);
      if (rand() < dust * 0.025) add(x, y, [220, 222, 240], 0.3 + rand() * 0.35);
    }
  }
  // Faint stars everywhere above the ground.
  for (let i = 0; i < w * h / 240; i++) add(Math.floor(rand() * w), Math.floor(rand() * groundTop), [210, 212, 230], 0.12 + rand() * 0.2);
  // A ringed planet, top right.
  const cx = Math.round(w * 0.84), cy = Math.round(h * 0.17), r = Math.max(6, Math.round(h * 0.035));
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r) continue;
      const light = Math.max(0, (-x - y) / (r * 1.5) + 0.35);
      const band = (y + r) % 3 === 0 ? 0.85 : 1;
      add(cx + x, cy + y, mix([28, 26, 38], [168, 152, 200], Math.min(1, light)).map(v => v * band), 1);
    }
  }
  for (let x = -r * 2; x <= r * 2; x++) {
    const y = Math.round(x * 0.28);
    const behind = x * x + y * y < r * r && y < 0;
    if (!behind) {
      add(cx + x, cy + y, [200, 180, 140], 0.6);
      add(cx + x, cy + y + 1, [150, 110, 90], 0.45);
    }
  }
  ctx.putImageData(image, 0, 0);
  return base;
}

function paintGround(w, h, groundTop) {
  const layer = document.createElement('canvas');
  layer.width = w;
  layer.height = h;
  const ctx = layer.getContext('2d');
  const rand = rng(42);
  const BLOCK = 4;
  // Far hills, then the near ground: heights from a random walk, in whole blocks.
  const ridge = (top, amp, color, rim) => {
    let height = top;
    const columns = [];
    for (let x = 0; x < w; x += BLOCK) {
      height += Math.round((rand() - 0.5) * 2) * BLOCK;
      height = Math.max(top - amp, Math.min(top + amp, height));
      columns.push(height);
      ctx.fillStyle = color;
      ctx.fillRect(x, height, BLOCK, h - height);
      ctx.fillStyle = rim;
      ctx.fillRect(x, height, BLOCK, 1);
    }
    return columns;
  };
  ridge(groundTop - BLOCK * 3, BLOCK * 3, '#0e1014', '#1a1d24');
  const near = ridge(groundTop + BLOCK, BLOCK * 2, '#060709', '#15181d');
  // Spruces on the near ground, and a small observatory on its highest block.
  ctx.fillStyle = '#060709';
  for (let i = 0; i < near.length; i++) {
    if (rand() > 0.09) continue;
    const x = i * BLOCK, base = near[i], tall = 3 + Math.floor(rand() * 3);
    for (let level = 0; level < tall; level++) {
      const half = Math.max(1, Math.floor((tall - level) * 1.2));
      ctx.fillRect(x + 2 - half, base - (level + 1) * 3, half * 2, 3);
    }
    ctx.fillRect(x + 1, base - tall * 3 - 2, 2, 2);
  }
  const peak = near.indexOf(Math.min(...near.slice(near.length * 0.55, near.length * 0.8)), Math.floor(near.length * 0.55));
  if (peak >= 0) {
    const x = peak * BLOCK, base = near[peak];
    ctx.fillRect(x - 6, base - 8, 16, 8);
    ctx.fillRect(x - 4, base - 11, 12, 3);
    ctx.fillRect(x - 2, base - 13, 8, 2);
    ctx.fillStyle = '#ffd98a';
    ctx.fillRect(x - 3, base - 5, 2, 2);
    ctx.fillStyle = '#060709';
    ctx.fillRect(x + 4, base - 17, 2, 6);
    ctx.fillRect(x + 6, base - 19, 2, 3);
  }
  return layer;
}

export function startSky(canvas, {animate = true} = {}) {
  const ctx = canvas.getContext('2d', {alpha: false});
  let w = 0, h = 0, base = null, ground = null, groundDawn = null, stars = [], last = 0, raf = 0, motion = animate;
  let meteor = null, nextMeteor = 4000, dawn = 0, dawnSky = null;
  const t0 = performance.now();

  function build() {
    const scale = innerWidth > 1600 ? 4 : 3;
    w = Math.max(160, Math.ceil(innerWidth / scale));
    h = Math.max(120, Math.ceil(innerHeight / scale));
    canvas.width = w;
    canvas.height = h;
    const groundTop = Math.round(h * 0.86);
    base = paintBase(w, h, groundTop);
    ground = paintGround(w, h, groundTop);
    groundDawn = document.createElement('canvas');
    groundDawn.width = w;
    groundDawn.height = h;
    const tint = groundDawn.getContext('2d');
    tint.drawImage(ground, 0, 0);
    tint.globalCompositeOperation = 'source-atop';
    tint.fillStyle = 'rgba(44, 72, 32, .8)';
    tint.fillRect(0, 0, w, h);
    const rand = rng(99);
    dawnSky = null;
    stars = Array.from({length: Math.round(w * h / 1600)}, () => ({
      x: Math.floor(rand() * w), y: Math.floor(rand() * groundTop * 0.95),
      phase: rand() * 6.28, speed: 0.6 + rand() * 2.2, big: rand() < 0.08,
      tint: rand() < 0.2 ? [255, 220, 170] : rand() < 0.3 ? [170, 220, 255] : [235, 235, 255],
    }));
    draw(performance.now());
  }

  function aurora(t) {
    // Two thin curtains, barely there: green-teal and violet.
    const fade = 1 - dawn;
    const curtains = [[90, 255, 190, 0.045 * fade, 0.26, 0], [150, 130, 230, 0.03 * fade, 0.34, 2.1]];
    for (const [r, g, b, alpha, at, shift] of curtains) {
      for (let x = 0; x < w; x += 2) {
        const wave = Math.sin(x * 0.018 + t * 0.25 + shift) * h * 0.05 + Math.sin(x * 0.006 - t * 0.12 + shift) * h * 0.07;
        const y = Math.round(h * at + wave);
        const strength = 0.5 + 0.5 * Math.sin(x * 0.011 + t * 0.4 + shift * 2);
        const len = Math.round(h * 0.1 * (0.5 + strength * 0.6));
        const third = Math.max(1, Math.round(len / 3));
        for (let k = 0; k < 3; k++) {
          ctx.fillStyle = `rgba(${r},${g},${b},${(k === 1 ? alpha : alpha * 0.5) * strength})`;
          ctx.fillRect(x, y + k * third, 2, third);
        }
      }
    }
  }

  function draw(now) {
    const t = motion ? (now - t0) / 1000 : 0;
    ctx.drawImage(base, 0, 0);
    if (dawn > 0) {
      if (!dawnSky) {
        dawnSky = ctx.createLinearGradient(0, 0, 0, h * 0.86);
        DAWN.forEach((c, i) => dawnSky.addColorStop(i / (DAWN.length - 1), rgb(c)));
      }
      ctx.globalAlpha = dawn;
      ctx.fillStyle = dawnSky;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    if (dawn < 1) aurora(t);
    for (const s of stars) {
      const level = Math.round((0.5 + 0.5 * Math.sin(t * s.speed + s.phase)) * 3) / 3;
      const starAlpha = 1 - dawn * 0.95;
      ctx.fillStyle = `rgba(${s.tint[0]},${s.tint[1]},${s.tint[2]},${(0.25 + level * 0.75) * starAlpha})`;
      ctx.fillRect(s.x, s.y, 1, 1);
      if (s.big && level > 0.6) {
        ctx.fillStyle = `rgba(${s.tint[0]},${s.tint[1]},${s.tint[2]},${level * 0.35 * starAlpha})`;
        ctx.fillRect(s.x - 1, s.y, 3, 1);
        ctx.fillRect(s.x, s.y - 1, 1, 3);
      }
    }
    if (motion) {
      const ms = now - t0;
      if (!meteor && ms > nextMeteor) {
        const rand = Math.random;
        meteor = {x: w * (0.2 + rand() * 0.6), y: h * (0.05 + rand() * 0.25), start: ms};
        nextMeteor = ms + 7000 + rand() * 9000;
      }
      if (meteor) {
        const k = (ms - meteor.start) / 900;
        if (k >= 1) meteor = null;
        else {
          const hx = Math.round(meteor.x - k * w * 0.18), hy = Math.round(meteor.y + k * h * 0.12);
          for (let i = 0; i < 10; i++) {
            ctx.fillStyle = `rgba(255,255,255,${(1 - i / 10) * (1 - k) * 0.9})`;
            ctx.fillRect(hx + i * 2, hy - Math.round(i * 1.3), 2, 1);
          }
        }
      }
    }
    ctx.drawImage(ground, 0, 0);
    if (dawn > 0) {
      // The ground takes the morning's grass tones, still in shadow.
      ctx.globalAlpha = dawn;
      ctx.drawImage(groundDawn, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < FRAME_MS) return;
    last = now;
    draw(now);
  }

  let resizeTimer = 0;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(build, 150); };
  addEventListener('resize', onResize);
  build();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const setMotion = on => {
    motion = on && !reduced;
    cancelAnimationFrame(raf);
    raf = 0;
    if (motion) raf = requestAnimationFrame(frame);
    else draw(performance.now());
  };
  setMotion(animate);

  return {
    setMotion,
    /** 0 = night … 1 = the game's morning; eased toward over a few frames by the caller. */
    setDawn(k) {
      dawn = Math.max(0, Math.min(1, k));
      if (!motion) draw(performance.now());
    },
    stop() {
      cancelAnimationFrame(raf);
      removeEventListener('resize', onResize);
      canvas.width = canvas.height = 0;
    },
  };
}
