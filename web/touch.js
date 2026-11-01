// Touch controls (Settings > Experimental): a stick on the left, the camera under a finger on
// the right, buttons for the rest. Nothing here knows the game: touches become the keyboard
// and mouse events winit already reads from the canvas, so the engine sees a player at a desk.

const canvas = () => document.querySelector('body > canvas');

function key(code, down) {
  const target = canvas();
  if (!target) return;
  const name = {Space: ' ', ShiftLeft: 'Shift', Escape: 'Escape'}[code] ?? code.replace(/^Key|^Digit/, '').toLowerCase();
  target.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {code, key: name, bubbles: true, cancelable: true}));
}

function mouse(type, button, extra = {}) {
  const target = canvas();
  if (!target) return;
  const box = target.getBoundingClientRect();
  target.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
    clientX: box.width / 2, clientY: box.height / 2,
    button, buttons: type === 'pointerup' ? 0 : button === 2 ? 2 : button === 0 ? 1 : 0,
    ...extra,
  }));
}

// A button that holds a key, or the mouse, for as long as it is pressed.
function hold(label, press, release) {
  const button = Object.assign(document.createElement('button'), {type: 'button', textContent: label});
  button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); button.setPointerCapture(event.pointerId); button.classList.add('on'); press(); });
  const up = event => { event.preventDefault(); event.stopPropagation(); if (button.classList.contains('on')) { button.classList.remove('on'); release(); } };
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
  return button;
}
const tap = (label, code) => hold(label, () => key(code, true), () => key(code, false));

function stick() {
  const pad = Object.assign(document.createElement('div'), {className: 'touch-stick'});
  const knob = Object.assign(document.createElement('div'), {className: 'touch-knob'});
  pad.append(knob);
  const held = new Set();
  const want = codes => {
    for (const code of held) if (!codes.has(code)) { key(code, false); held.delete(code); }
    for (const code of codes) if (!held.has(code)) { key(code, true); held.add(code); }
  };
  let id = null;
  const move = event => {
    const box = pad.getBoundingClientRect();
    const r = box.width / 2;
    let x = event.clientX - box.left - r, y = event.clientY - box.top - r;
    const length = Math.hypot(x, y);
    if (length > r) { x *= r / length; y *= r / length; }
    knob.style.transform = `translate(${x}px, ${y}px)`;
    const dead = r * 0.3, codes = new Set();
    if (y < -dead) codes.add('KeyW');
    if (y > dead) codes.add('KeyS');
    if (x < -dead) codes.add('KeyA');
    if (x > dead) codes.add('KeyD');
    want(codes);
  };
  pad.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); id = event.pointerId; pad.setPointerCapture(id); move(event); });
  pad.addEventListener('pointermove', event => { if (event.pointerId === id) { event.preventDefault(); event.stopPropagation(); move(event); } });
  const end = event => { if (event.pointerId !== id) return; id = null; knob.style.transform = ''; want(new Set()); };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  return pad;
}

// The rest of the screen turns the camera; a short tap there clicks (for menus and attacks).
function look(layer) {
  const SPEED = 2.2;
  let id = null, lastX = 0, lastY = 0, startedAt = 0, travelled = 0;
  layer.addEventListener('pointerdown', event => {
    if (id !== null) return;
    event.preventDefault();
    id = event.pointerId;
    layer.setPointerCapture(id);
    lastX = event.clientX; lastY = event.clientY; startedAt = performance.now(); travelled = 0;
  });
  layer.addEventListener('pointermove', event => {
    if (event.pointerId !== id) return;
    event.preventDefault();
    const dx = event.clientX - lastX, dy = event.clientY - lastY;
    lastX = event.clientX; lastY = event.clientY;
    travelled += Math.abs(dx) + Math.abs(dy);
    mouse('pointermove', -1, {movementX: dx * SPEED, movementY: dy * SPEED});
  });
  const end = event => {
    if (event.pointerId !== id) return;
    id = null;
    if (travelled < 8 && performance.now() - startedAt < 250) {
      mouse('pointerdown', 0, {clientX: event.clientX, clientY: event.clientY});
      mouse('pointerup', 0, {clientX: event.clientX, clientY: event.clientY});
    }
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
}

export function startTouch() {
  const root = Object.assign(document.createElement('div'), {className: 'touch'});
  const area = Object.assign(document.createElement('div'), {className: 'touch-look'});
  look(area);
  const left = Object.assign(document.createElement('div'), {className: 'touch-left'});
  left.append(stick(), tap('⇩', 'ShiftLeft'));
  const right = Object.assign(document.createElement('div'), {className: 'touch-right'});
  right.append(
    hold('⛏', () => mouse('pointerdown', 0), () => mouse('pointerup', 0)),
    hold('▣', () => mouse('pointerdown', 2), () => mouse('pointerup', 2)),
    tap('⇧', 'Space'),
  );
  const top = Object.assign(document.createElement('div'), {className: 'touch-top'});
  top.append(tap('E', 'KeyE'), tap('Q', 'KeyQ'), tap('T', 'KeyT'), tap('Esc', 'Escape'));
  root.append(area, left, right, top);
  document.body.append(root);
  // The canvas takes keys only while focused.
  root.addEventListener('pointerdown', () => canvas()?.focus({preventScroll: true}), {capture: true});
}
