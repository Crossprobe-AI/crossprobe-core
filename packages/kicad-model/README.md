# @crossprobe/kicad-model

The design model of a KiCad project, in TypeScript: the schematic hierarchy and its nets
as KiCad sees them, the board, ERC and DRC, schematic ↔ board parity, editing, and
fabrication outputs (Gerber, drill, BOM, pick-and-place, IPC-2581, ODB++, STEP). It is
the model behind [Crossprobe](https://github.com/Crossprobe-AI/crossprobe-core), a KiCad
editor in the browser, and is checked against what KiCad itself does with the same projects.

```sh
npm install @crossprobe/kicad-model
```

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildNetlist, loadSchematic, parseBoard, runErc } from "@crossprobe/kicad-model";

const dir = process.argv[2]; // a KiCad project folder, e.g. KiCad's demos/pic_programmer
const read = (path) => readFileSync(join(dir, path), "utf8");

const schematic = loadSchematic("pic_programmer.kicad_sch", read); // the root sheet; sub-sheets are read through `read`
const netlist = buildNetlist(schematic, { detail: true }); // detail: what ERC needs
console.log(`${netlist.nets.length} nets`);
for (const v of runErc(schematic, netlist)) console.log(`${v.severity}: ${v.message}`);

const board = parseBoard(read("pic_programmer.kicad_pcb"));
console.log(`${board.footprints.length} footprints, ${board.tracks.length} tracks`);
```

It reads files through the function you give it, so it runs in Node and in the browser
alike. Files are parsed with [@crossprobe/kicad-sexpr](https://github.com/Crossprobe-AI/crossprobe-core/tree/main/packages/kicad-sexpr), so edits keep
everything else in the file as it was.

Node.js 22.12 or later. Apache-2.0; see the repository's [NOTICE](https://github.com/Crossprobe-AI/crossprobe-core/blob/main/NOTICE).
