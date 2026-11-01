import {initSync, wasm_thread_entry_point} from './pkg/horizon_client.js';
import {runRustWorker} from './worker-common.js';

runRustWorker(initSync, wasm_thread_entry_point, {destroyArgs: []});
