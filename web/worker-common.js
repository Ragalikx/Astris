// Shared body of the Rust thread Workers (rust-worker.js, rust-worker64.js).
//
// A Worker is pooled by wasm_thread: after a thread finishes it waits for the next one
// and runs it on the instance, TLS block and stack it already has. "exit" frees them.
Error.stackTraceLimit = 80;

// Worker stacks live in the shared wasm memory, which never shrinks; pooling keeps their
// count at the peak number of live threads. A wasm stack overflow corrupts memory instead
// of trapping, so this stays at the size the deep worldgen recursion was tested with.
const THREAD_STACK = 8 * 1024 * 1024;

export function runRustWorker(initSync, entryPoint, {destroyArgs}) {
  const send = (kind, message) => postMessage({__horizon: kind, message, name: self.name});
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    console[level] = (...args) => send(level, args.map(x => x?.stack || String(x)).join(' '));
  }
  globalThis.horizonStage = message => send('info', message);
  globalThis.horizonNotice = message => send('warn', message);
  globalThis.horizonFailure = message => send('failure', new Error(String(message)).stack);
  globalThis.horizonFrame = () => {};
  // A downloaded sound's bytes (audio.rs, mod web): its blob URL, read synchronously,
  // which only a Worker may do.
  globalThis.horizonReadUrl = url => {
    const request = new XMLHttpRequest();
    request.open('GET', url, false);
    request.responseType = 'arraybuffer';
    try { request.send(); } catch (_) { return undefined; }
    return request.status === 200 || request.status === 0 ? new Uint8Array(request.response) : undefined;
  };
  self.addEventListener('error', event => send('failure', event.error?.stack || event.message));
  self.addEventListener('unhandledrejection', event => send('failure', event.reason?.stack || String(event.reason)));

  let exports = null;
  self.onmessage = event => {
    if (event.data === 'exit') {
      // No Rust frames remain on this Worker's stack between threads.
      exports?.__wbindgen_thread_destroy?.(...destroyArgs);
      close();
      return;
    }
    const [module, memory, work] = event.data;
    try {
      if (!exports) {
        exports = initSync({module, memory, thread_stack_size: THREAD_STACK});
        send('ready', 'Worker initialized against shared Rust memory');
      }
      send('start', 'thread started');
      entryPoint(work);
      send('complete', 'thread finished; Worker idle');
    } catch (error) {
      send('failure', error?.stack || String(error));
      close();
    }
  };
}
