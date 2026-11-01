"""Builds the static site for Cloudflare Pages (or any static host) into dist/.

Run after web/build.ps1 -Release (and -Wasm64 for the 64-bit build):
    python tools/build-site.py

Cloudflare Pages refuses files over 25 MiB, so each engine .wasm is cut into parts
listed in parts.json; play.js joins them back before compiling. dist.zip holds the same
files for the dashboard's upload (forward slashes in its paths, which Cloudflare needs).
"""
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / 'web'
DIST = ROOT / 'dist'
PART = 20 * 1024 * 1024
SITE = {'.html', '.js', '.css', '.svg'}
SKIP = {'dev_server.py', 'build.ps1', 'browser-session.log'}


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    for file in WEB.iterdir():
        if file.is_file() and file.name not in SKIP and (file.suffix in SITE or file.name == '_headers'):
            shutil.copy2(file, DIST / file.name)

    for pkg in ('pkg', 'pkg64'):
        source = WEB / pkg
        wasm = source / 'horizon_client_bg.wasm'
        if not wasm.exists():
            print(f'{pkg}: not built, skipped')
            continue
        target = DIST / pkg
        target.mkdir()
        shutil.copy2(source / 'horizon_client.js', target / 'horizon_client.js')
        data = wasm.read_bytes()
        parts = []
        for i in range(0, len(data), PART):
            name = f'horizon_client_bg.{len(parts)}.wasm'
            (target / name).write_bytes(data[i:i + PART])
            parts.append(name)
        (target / 'parts.json').write_text(json.dumps({'parts': parts}), encoding='utf-8')
        print(f'{pkg}: {len(data) / 1048576:.1f} MiB in {len(parts)} parts')

    if not (DIST / 'pkg').exists():
        sys.exit('web/pkg is missing: run web/build.ps1 -Release first')
    too_big = [f for f in DIST.rglob('*') if f.is_file() and f.stat().st_size > 25 * 1024 * 1024]
    if too_big:
        sys.exit(f'over 25 MiB: {too_big}')
    files = sorted(f for f in DIST.rglob('*') if f.is_file())
    with zipfile.ZipFile(ROOT / 'dist.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            archive.write(file, file.relative_to(DIST).as_posix())
    print(f'dist/ ready, {len(files)} files; dist.zip for upload')


if __name__ == '__main__':
    main()
