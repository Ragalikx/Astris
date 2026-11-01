"""Shares a Horizon-prepared folder over the network for Astris's "import from the
network": run it on the computer that has Horizon, then give the launcher the address
it prints (on the same network, or through a private one such as Tailscale).

    python astris-share.py "C:\\Users\\you\\AppData\\Roaming\\horizon-launcher\\versions\\<build>\\.local\\horizon-client\\26.3" [port] [address]

The port is 8790 unless given; the address is every network interface (0.0.0.0) unless
given, 127.0.0.1 keeping it to this computer.

It serves the folder read-only, with the file list Astris reads (/__astris.json: each
file's path and size) and the headers a page in another origin needs to read it (CORS,
and Cross-Origin-Resource-Policy for its cross-origin isolation), for the local launcher
and the sites named in ASTRIS_ORIGINS (space separated), such as where Astris is hosted:

    set ASTRIS_ORIGINS=https://astris.example

Other pages in the player's browser get no CORS answer and cannot read the files, but a
program that can reach the port can: share it only on networks you trust.
"""
import json
import os
import socket
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if len(sys.argv) < 2:
    sys.exit(__doc__)
root = Path(sys.argv[1]).resolve()
if not (root / 'horizon-resources.json').is_file():
    sys.exit(f'{root} has no horizon-resources.json: choose the prepared 26.3 folder')
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
# Every network interface by default; 127.0.0.1 keeps it to this computer.
address = sys.argv[3] if len(sys.argv) > 3 else '0.0.0.0'
# The sites allowed to read the folder from a browser: the local launcher, and any
# given in ASTRIS_ORIGINS (space separated, e.g. the address Astris is hosted at).
# Any other page the player has open gets no CORS answer, so it cannot read the files.
ORIGINS = {'http://127.0.0.1:8766', 'http://localhost:8766', *os.environ.get('ASTRIS_ORIGINS', '').split()}
listing = json.dumps([[p.relative_to(root).as_posix(), p.stat().st_size]
                      for p in sorted(root.rglob('*')) if p.is_file()]).encode()


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        super().end_headers()

    def do_GET(self):
        if self.path == '/__astris.json':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(listing)))
            self.end_headers()
            self.wfile.write(listing)
            return
        super().do_GET()

    def list_directory(self, path):
        self.send_error(403)

    def log_message(self, *args):
        pass


host = socket.gethostname()
print(f'Sharing {root}')
print(f'In the Astris launcher, give: http://{host}:{port}/ (or this computer\'s address, e.g. its Tailscale name)')
ThreadingHTTPServer((address, port), partial(Handler, directory=str(root))).serve_forever()
