# Crossprobe

A KiCad editor that runs in the browser. Open a KiCad project folder, view and
edit its schematic and board, and save it back as KiCad files: unmodified files
are written back byte for byte, and edits produce minimal diffs. KiCad's
behaviour is reimplemented in TypeScript and checked against KiCad itself
(`kicad-cli`).

Website: <https://crossprobe.dev>

## What it does

- Schematic, PCB and 3D views, with cross-probing between them.
- Schematic editing: wires, labels, buses, hierarchical sheets, parts from KiCad's
  libraries, annotation, ERC.
- PCB editing: placement, routing with 45° tracks and vias, zones, Update PCB from
  schematic, DRC, schematic ↔ board parity.
- Symbol and footprint editors; plotting; fabrication outputs (Gerber, drill, BOM,
  pick-and-place, IPC-2581, ODB++, STEP, GLB).
- [Design blocks](blocks/README.md) (reference circuits with cited checklists),
  [requirements](docs/requirements.md) and [compatibility](docs/compatibility.md)
  checks, and datasheet evidence pinned to parts.

## Run it

With Docker ([docs/docker.md](docs/docker.md)):

```sh
docker compose up --build
```

Then open <http://localhost:5173> in Chrome, Edge or another Chromium browser and
choose your project's folder. Files stay on your computer: the browser reads the
folder and saves into it.

Without Docker, with Node.js 20 or later (KiCad's libraries are read from a KiCad
installation, or from `KICAD_SYMBOLS`, `KICAD_FOOTPRINTS` and `KICAD_DEMOS`):

```sh
npm ci
npm run dev         # the app at http://localhost:5173
```

## Develop

```sh
npm run build       # @crossprobe/kicad-sexpr and @crossprobe/kicad-model
npm run typecheck   # the app
npm test
```

| Path | What it is |
|---|---|
| [`packages/kicad-sexpr`](packages/kicad-sexpr) | Lossless parser and writer for every KiCad S-expression format, with KiCad-style editing helpers |
| [`packages/kicad-model`](packages/kicad-model) | The design model: schematic hierarchy and nets as KiCad sees them, the board, ERC, DRC, parity, editing, fabrication outputs, design blocks |
| [`apps/web`](apps/web) | The browser app |
| [`apps/web/src/extensions`](apps/web/src/extensions/api.ts) | The editor's extension points: inspector tabs, places to open and keep projects, sections of the Review tab |

Many tests compare results with KiCad itself on KiCad's bundled demo projects.
They skip when KiCad is not installed. Point them at KiCad and other projects
with `KICAD_CLI=/path/to/kicad-cli` and `KICAD_CORPUS=/path/a:/path/b`. The
browser scripts in `scripts/e2e-*.mjs` drive the app end to end
([docs/end-to-end.md](docs/end-to-end.md)).

## Licence

Apache-2.0 (see [LICENSE](LICENSE)). Third-party material keeps its own licence;
see [NOTICE](NOTICE). No KiCad source code is included: KiCad's behaviour is
reimplemented and checked against `kicad-cli`, never copied.
