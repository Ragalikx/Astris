// Loaded before the page's module, in plain old JavaScript on purpose: when a browser is too
// old for the launcher (or the game page), the module dies silently and leaves a grey page.
// This says so instead. The module sets window.astrisReady once it is up.
(function () {
  var shown = false, errors = [];
  var lang = (navigator.language || 'en').slice(0, 2);
  var text = {
    en: ['This browser cannot run Astris', 'It is too old or lacks something the site needs. Update Chrome or Edge, or open the site in an up-to-date Chromium-based browser.'],
    ru: ['Этот браузер не может запустить Astris', 'Он устарел или не умеет того, что нужно сайту. Обновите Chrome или Edge либо откройте сайт в свежем браузере на Chromium.'],
    uk: ['Цей браузер не може запустити Astris', 'Він застарів або не вміє того, що потрібно сайту. Оновіть Chrome чи Edge або відкрийте сайт у свіжому браузері на Chromium.']
  }[lang === 'ru' || lang === 'uk' ? lang : 'en'];

  function show() {
    if (shown || window.astrisReady || !document.body) return;
    shown = true;
    var box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;padding:24px;background:#07080b;color:#e8e8ec;font:15px/1.5 system-ui,sans-serif';
    var inner = document.createElement('div');
    inner.style.cssText = 'max-width:560px';
    var h = document.createElement('h1');
    h.style.cssText = 'margin:0 0 12px;font-size:22px';
    h.appendChild(document.createTextNode(text[0]));
    var p = document.createElement('p');
    p.style.cssText = 'margin:0 0 12px;color:#a9abb5';
    p.appendChild(document.createTextNode(text[1]));
    var details = document.createElement('pre');
    details.style.cssText = 'margin:0;padding:10px;white-space:pre-wrap;word-break:break-word;font:12px monospace;color:#d98a7e;background:#0e0f13';
    details.appendChild(document.createTextNode((errors.join('\n') || 'no response') + '\n' + navigator.userAgent));
    inner.appendChild(h);
    inner.appendChild(p);
    inner.appendChild(details);
    box.appendChild(inner);
    document.body.appendChild(box);
  }

  function failed(message) {
    if (window.astrisReady) return;
    errors.push(String(message));
    setTimeout(show, 300);
  }
  window.addEventListener('error', function (event) {
    // Resources that fail to load (a font, an image) do not mean the page is broken.
    if (event.target && event.target !== window) return;
    failed(event.message || event.error);
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    failed(reason && reason.message ? reason.name + ': ' + reason.message : reason);
  });
  // A browser without modules never runs the page at all.
  if (!('noModule' in HTMLScriptElement.prototype)) failed('JavaScript modules are not supported');
  // Nor does one that chokes while parsing it: nothing fires, so a quiet page is a failed one.
  setTimeout(function () { if (!window.astrisReady) failed('the page did not start'); }, 15000);
})();
