import {initSync, wasm_thread_entry_point} from './pkg64/horizon_client.js';
import {runRustWorker} from './worker-common.js';

// getrandom's custom backend on wasm64 (see horizon-threads) reads this hook.
globalThis.horizonRandomFill = len => {
  const out = new Uint8Array(len);
  for (let at = 0; at < len; at += 65536) crypto.getRandomValues(out.subarray(at, Math.min(len, at + 65536)));
  return out;
};
// wasm-bindgen's memory64 thread support passes addresses to JS as f64, plain numbers.
runRustWorker(initSync, wasm_thread_entry_point, {destroyArgs: [0, 0, 0]});
