# Running the app in Docker

The container runs the web app's development server with KiCad 9's symbol,
footprint and demo libraries (from Debian 13's packages). Your projects stay on
your computer: the browser opens the folder you choose, and the container never
sees it.

Needs Docker with Compose v2 (Docker Desktop, or Docker Engine 23+ with the
compose plugin).

## Run

```sh
docker compose up --build
```

The first build downloads the Node image, the KiCad libraries (about 550 MB) and
the npm packages. Then open <http://localhost:5173> in Chrome, Edge or another
Chromium browser. Stop with Ctrl-C, or `docker compose down` if you started it
with `-d`.

The port is published on 127.0.0.1 only. To use another port, change
`"127.0.0.1:5173:5173"` in `compose.yaml` to, for example, `"127.0.0.1:8080:5173"`.

## Develop

```sh
docker compose watch
```

This runs the same container and copies your edits under `apps/web`, `packages`,
`blocks` and `third_party` into it as you save, and Vite reloads the page.
Changing `package-lock.json` rebuilds the image. The app uses the packages'
source directly, so edits there show up at once; the dev server's own library
indexing uses their built output, which `docker compose restart` rebuilds.

## What works

- Open a KiCad project by choosing or dropping its folder; view and edit the
  schematic and board.
- Place parts from KiCad's symbol and footprint libraries (the first search
  builds an index, which takes about ten seconds).
- Open KiCad's demo projects from the start screen.
- Save back to the folder you opened, in Chromium browsers (the File System
  Access API, which works on `http://localhost`). Firefox and Safari can open a
  folder, but saving downloads the changed files instead.

## Libraries

By default the image contains Debian's `kicad-symbols`, `kicad-footprints` and
`kicad-demos` under `/usr/share/kicad`, where the dev server looks for them.

If KiCad is installed on your computer, you can use its libraries instead
(the same versions as your KiCad, and no download). Build without them and
mount yours over `/usr/share/kicad` with a `compose.override.yaml` next to
`compose.yaml`, which Compose reads automatically:

```yaml
services:
  web:
    build:
      args:
        KICAD_LIBS: "0"
    volumes:
      # Linux (packages or a build from source: /usr/share/kicad or /usr/local/share/kicad)
      - /usr/share/kicad:/usr/share/kicad:ro
      # macOS: - /Applications/KiCad/KiCad.app/Contents/SharedSupport:/usr/share/kicad:ro
      # Windows: - "C:/Program Files/KiCad/9.0/share/kicad:/usr/share/kicad:ro"
```

The folder must hold `symbols` and `footprints` (and `3dmodels`, if you have
them). On macOS the demos are in `/Library/Application Support/kicad/demos`;
mount that too, as `- "/Library/Application Support/kicad/demos:/usr/share/kicad/demos:ro"`,
or the start screen lists none. Docker Desktop shares only some folders by
default (Settings, Resources, File sharing); add `/Applications` there if the
mount comes up empty.

The folders can also be given separately, with `KICAD_SYMBOLS`,
`KICAD_FOOTPRINTS`, `KICAD_DEMOS` and `KICAD_3DMODELS` under `environment:`
pointing at paths inside the container.

## 3D models

KiCad's 3D models (`kicad-packages3d`, about 4.7 GB installed) are left out by
default. The 3D view still works and shows boxes for parts without a model. To
include them:

```sh
KICAD_3D=1 docker compose up --build
```

Or mount a KiCad installation that has them, as above.

## Troubleshooting

- **The part picker shows only a few libraries.** The KiCad libraries were not
  found. Check with `docker compose exec web ls /usr/share/kicad/symbols`; if
  you mount your own, check the host path.
- **Saving downloads files instead of writing the folder.** Use a Chromium
  browser, and open the app as `http://localhost:5173` (or `127.0.0.1`).
  Browsers allow folder access only on localhost or https, so it does not work
  from another machine's address.
- **Port 5173 is in use.** Change the published port in `compose.yaml` (see Run).
- **Errors about missing modules after pulling changes.** Rebuild:
  `docker compose up --build`.
- **The build fails to download behind a corporate proxy.** Pass the proxy and,
  if it re-signs TLS, its CA certificate:
  `docker build --build-arg HTTPS_PROXY=http://proxy:3128 --secret id=ca,src=proxy-ca.crt -t crossprobe-web:local .`
  then `docker compose up`.
- **Files created by the container.** It runs as the image's `node` user (uid
  1000) and writes nothing to your checkout.
