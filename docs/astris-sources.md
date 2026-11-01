# Astris: where the launcher takes the game's files from

Astris runs entirely in the browser. It needs the files the Horizon launcher prepares for
Minecraft 26.3 (the folder with `horizon-resources.json`), copies them once into the
browser's storage (OPFS), and plays from there. It never sends anything to a source
except the GET requests described here.

A source is one of:

- a folder on this computer, picked in the import window;
- a ZIP of that folder on this computer, picked in the import window;
- a server on the network: a shared folder, or a link to a ZIP.

This page describes the network form, for anyone who wants to serve the files from
their own machine, NAS or a private network such as Tailscale.

## What the folder holds

The prepared folder is `<Horizon data>/horizon-launcher/versions/<build>/.local/horizon-client/26.3`.
The launcher looks for `horizon-resources.json` in the folder it is given, or up to five
levels below it, so a source may also hold the whole build folder. The manifest must say
`"minecraft": "26.3"` and `"schema": 7`.

What the launcher copies, about 598 MiB in all:

| Part | Size | |
|---|---|---|
| `assets/` without sounds | ~100 MiB | textures, models, fonts, languages |
| everything outside `assets/` | ~140 MiB | gameplay, world generation and other data exported from the game |
| `assets/minecraft/sounds` and `sounds.json` | ~360 MiB | only when the player keeps "Sounds" on |

## Form 1: a shared folder

The address the player enters is the folder's URL, e.g. `http://my-pc:8790/`.

1. `GET {address}/__astris.json` answers the file list:

   ```json
   [["horizon-resources.json", 2048], ["assets/minecraft/lang/en_us.json", 551234], ...]
   ```

   Each entry is `[path, size]`: the path relative to the folder with `/` separators, the
   size in bytes. Entries with an empty, `.` or `..` part are ignored.

2. `GET {address}/{path}` (each path segment URL-encoded) answers a file's bytes. The
   launcher asks for at most 8 files at a time, while it writes, and checks each one's
   size against the list.

## Form 2: a ZIP

An address whose path ends in `.zip` is downloaded whole (`GET`) and read in the
browser. Entries may be stored or deflated; ZIP64 archives work. The archive holds the
same folder, at its root or in a folder (`26.3/...`). Already compressed files (`.ogg`,
`.png`) are best stored: deflating them gains nothing.

The same ZIP can be picked from the computer in the import window.

## Headers every answer needs

The launcher page is cross-origin isolated (it uses WebAssembly threads), so a source
on another origin must answer every request, the list, the files or the ZIP, with:

```
Access-Control-Allow-Origin: <the launcher's origin, e.g. https://astris.example>
Cross-Origin-Resource-Policy: cross-origin
```

A launcher opened over https may only read https sources (browsers block http from an
https page). Tailscale's `tailscale serve` and `tailscale funnel` give an https address.

## Reference server

`tools/astris-share.py` serves a folder in form 1:

```
python tools/astris-share.py "<path to 26.3>" [port] [address]
```

The port is 8790 unless given; the address is every interface unless given (`127.0.0.1`
keeps it to this computer). It answers CORS only to the local launcher and to the
origins listed in `ASTRIS_ORIGINS` (space separated). It builds `__astris.json` at start.

## Other servers

Any static server works once it serves `__astris.json` and the headers above. The list
can be made once with:

```
python -c "import json,pathlib,sys; r=pathlib.Path(sys.argv[1]); print(json.dumps([[p.relative_to(r).as_posix(), p.stat().st_size] for p in sorted(r.rglob('*')) if p.is_file()]))" "<path to 26.3>" > "<path to 26.3>/__astris.json"
```

nginx:

```nginx
server {
    listen 8790;
    root /srv/horizon/26.3;
    location / {
        add_header Access-Control-Allow-Origin "https://astris.example" always;
        add_header Cross-Origin-Resource-Policy "cross-origin" always;
        autoindex off;
    }
}
```

Caddy:

```
:8790 {
    root * /srv/horizon/26.3
    header Access-Control-Allow-Origin "https://astris.example"
    header Cross-Origin-Resource-Policy "cross-origin"
    file_server
}
```

## Security

- The files go straight into the game: serve only your own copy, and only to origins you
  trust. Anything that can reach the port can read the folder.
- The launcher sends nothing but GET requests to a source, and reads only the paths in
  the list (or the ZIP's own entries).
- The player confirms in the launcher that they download from their own licensed copy.
