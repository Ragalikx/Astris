"""Local development server for the Astris web build: the static files with the headers
WebAssembly threads need (COOP/COEP), and launch logs posted to /log.

The game's resources do not come from here: the player imports their Horizon-prepared
folder in the launcher (horizon-import.js), and the game reads it from OPFS."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
import os
import socket
import threading

LOG_KEEP = 50
LOG_MAX_POST = 4 << 20

WEB_ROOT = Path(__file__).resolve().parent
LOG_ROOT = WEB_ROOT / 'logs'
LOG_LOCK = threading.Lock()
# Never served: the logs (paths and names of the player's folders), local caches, and
# the server's own files. Decided on the resolved file, so no spelling of the URL
# (%6Cogs, LOGS on Windows, //logs) gets around it.
PRIVATE_DIRS = (LOG_ROOT, WEB_ROOT / '.cache')
PRIVATE_SUFFIXES = ('.log', '.py', '.ps1')
# The address to listen on: this computer only, unless ASTRIS_HOST says otherwise
# (0.0.0.0 shares it on the local network, for trying it from other devices).
BIND = os.environ.get('ASTRIS_HOST', '127.0.0.1')


def own_names():
    names = {'127.0.0.1', 'localhost', '[::1]'}
    # Names a proxy in front of it answers to, e.g. tailscale serve's https name.
    names.update(n.lower() for n in os.environ.get('ASTRIS_NAMES', '').split())
    if BIND != '127.0.0.1':
        host = socket.gethostname()
        names.add(host.lower())
        for info in socket.getaddrinfo(host, None):
            address = info[4][0]
            names.add(f'[{address}]' if ':' in address else address)
    return tuple(names)


# Only these names reach the server, this computer's own: a page on another domain that
# points its name at this computer (DNS rebinding) is turned away.
LOCAL_HOSTS = own_names()


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.wasm': 'application/wasm'}

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        # Not to be framed by another site, nor read as another content type.
        self.send_header('Content-Security-Policy', "frame-ancestors 'none'")
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        # Revalidate instead of re-downloading: the 30 MB wasm answers 304 when unchanged.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _refused(self):
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0].lower()
        if host not in LOCAL_HOSTS:
            self.send_error(421, 'Unknown host')
            return True
        target = Path(self.translate_path(self.path))
        if any(target == d or target.is_relative_to(d) for d in PRIVATE_DIRS) or target.suffix.lower() in PRIVATE_SUFFIXES:
            self.send_error(404)
            return True
        return False

    def _same_site(self):
        # The launcher's own requests only: a page on another site could otherwise wipe
        # this site's storage (Clear-Site-Data) or fill the logs with a plain form post.
        fetch_site = self.headers.get('Sec-Fetch-Site')
        origin = self.headers.get('Origin')
        if fetch_site not in (None, 'same-origin') or (origin and urlsplit(origin).netloc.rsplit(':', 1)[0].lower() not in LOCAL_HOSTS):
            self.send_error(403, 'Cross-site request refused')
            return False
        return True

    def do_GET(self):
        if not self._refused():
            super().do_GET()

    def do_HEAD(self):
        if not self._refused():
            super().do_HEAD()

    def translate_path(self, path):
        target = (WEB_ROOT / unquote(urlsplit(path).path).lstrip('/')).resolve()
        if not target.is_relative_to(WEB_ROOT):
            return str(WEB_ROOT / '.missing')
        return str(target)

    def list_directory(self, path):
        self.send_error(403, 'Directory listing disabled')

    def do_POST(self):
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0].lower()
        if host not in LOCAL_HOSTS:
            return self.send_error(421, 'Unknown host')
        if not self._same_site():
            return
        if urlsplit(self.path).path == '/clear-site-data':
            # The launcher's "delete all local data": the browser drops all of the site's
            # storage, the space it still counts for unfinished writes included.
            self.send_response(204)
            self.send_header('Clear-Site-Data', '"storage"')
            self.end_headers()
            return
        if urlsplit(self.path).path != '/log':
            return self.send_error(404)
        length = min(int(self.headers.get('Content-Length', '0')), LOG_MAX_POST)
        body = self.rfile.read(length) if length > 0 else b''
        # Launch logs: one file per launch in logs/, the newest LOG_KEEP kept.
        session = parse_qs(urlsplit(self.path).query).get('session', ['unknown'])[0]
        session = ''.join(c for c in session if c.isalnum() or c == '-')[:64] or 'unknown'
        with LOG_LOCK:
            LOG_ROOT.mkdir(exist_ok=True)
            target = LOG_ROOT / f'{session}.log'
            fresh = not target.exists()
            with target.open('ab') as f:
                f.write(body)
                if not body.endswith(b'\n'):
                    f.write(b'\n')
            if fresh:
                logs = sorted(LOG_ROOT.glob('*.log'), key=lambda p: p.stat().st_mtime)
                for stale in logs[:-LOG_KEEP]:
                    stale.unlink(missing_ok=True)
        self.send_response(204)
        self.end_headers()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8766'))
    server = ThreadingHTTPServer((BIND, port), partial(Handler, directory=str(WEB_ROOT)))
    for name in sorted(LOCAL_HOSTS):
        print(f'Astris: http://{name}:{port}/', flush=True)
    server.serve_forever()
