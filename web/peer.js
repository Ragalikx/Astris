// Playing together, browser with browser, over WebRTC with no server: the pages trade an
// offer code and an answer code, then a data channel carries the game's bytes in and out
// of the engine (horizon_client::peer). Switched off in play.js for now.
const CODE = 'ASTRIS1.';
// What a channel may hold unsent before the page stops taking more from the game.
const HIGH_WATER = 4 << 20;
const CHUNK = 64 << 10;

let engine = null, log = () => {};
const channels = new Map();

async function pack(description) {
  const json = new Blob([JSON.stringify({type: description.type, sdp: description.sdp})]);
  const packed = await new Response(json.stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  let text = '';
  for (const byte of new Uint8Array(packed)) text += String.fromCharCode(byte);
  return CODE + btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
async function unpack(code) {
  const body = code.trim();
  if (!body.startsWith(CODE)) throw new Error('not an Astris code');
  const text = atob(body.slice(CODE.length).replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
  const json = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  const description = JSON.parse(json);
  if (!['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string') throw new Error('damaged code');
  return description;
}

// Every candidate gathered, so one code carries all of them (no signalling afterwards).
function gathered(connection) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { if (connection.iceGatheringState === 'complete') resolve(); };
    connection.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 4000);
  });
}

// A data channel joined to one engine connection, its bytes moved both ways.
function carry(channel, id, label) {
  channel.binaryType = 'arraybuffer';
  channels.set(id, channel);
  channel.onmessage = event => {
    if (!engine.horizon_peer_push(id, new Uint8Array(event.data))) channel.close();
  };
  const pump = setInterval(() => {
    while (channel.readyState === 'open' && channel.bufferedAmount < HIGH_WATER) {
      const bytes = engine.horizon_peer_take(id, CHUNK);
      if (bytes === undefined) { channel.close(); break; }
      if (!bytes.length) break;
      channel.send(bytes);
    }
  }, 4);
  channel.onclose = () => {
    clearInterval(pump);
    channels.delete(id);
    engine.horizon_peer_close(id);
    log('HOST', `peer ${id} (${label}) closed`);
  };
  log('HOST', `peer ${id} (${label}) open`);
}

/** The host: a new invitation, and a way to take the guest's answer to it. */
export async function invite(onConnected) {
  const connection = new RTCPeerConnection({iceServers: []});
  const channel = connection.createDataChannel('astris', {ordered: true});
  channel.onopen = () => {
    const id = engine.horizon_peer_accept();
    if (!id) { channel.close(); return; }
    carry(channel, id, 'guest');
    onConnected?.();
  };
  await connection.setLocalDescription(await connection.createOffer());
  await gathered(connection);
  return {
    code: await pack(connection.localDescription),
    // Once per invitation: a second paste of the answer (or one after the guest joined)
    // changes nothing.
    accept: async answer => {
      if (connection.signalingState !== 'have-local-offer') return 'already';
      await connection.setRemoteDescription(await unpack(answer));
      return 'accepted';
    },
    connection,
  };
}

/** The guest: the answer to a host's invitation; the game joins once the channel opens. */
export async function answer(offer, onConnected) {
  const connection = new RTCPeerConnection({iceServers: []});
  connection.ondatachannel = ({channel}) => {
    channel.onopen = () => {
      const id = engine.horizon_peer_dial();
      carry(channel, id, 'host');
      engine.horizon_peer_join(id);
      onConnected?.();
    };
  };
  await connection.setRemoteDescription(await unpack(offer));
  await connection.setLocalDescription(await connection.createAnswer());
  await gathered(connection);
  return {code: await pack(connection.localDescription), connection};
}

export const hosting = () => !!engine?.horizon_peer_hosting?.();

export function attach(module, logger) {
  engine = module;
  log = logger;
}
