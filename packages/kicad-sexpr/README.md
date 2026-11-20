# @crossprobe/kicad-sexpr

A lossless parser and writer for KiCad's S-expression files (`.kicad_pcb`, `.kicad_sch`,
`.kicad_sym`, `.kicad_mod`, `.kicad_wks`, …), with KiCad-style editing helpers. An
unmodified file is written back byte for byte, and an edit changes only what it touches,
so diffs stay minimal. Part of [Crossprobe](https://github.com/Crossprobe-AI/crossprobe-core).

```sh
npm install @crossprobe/kicad-sexpr
```

```js
import { readFileSync } from "node:fs";
import { arg, findChild, isList, parse, serialize } from "@crossprobe/kicad-sexpr";

const text = readFileSync(process.argv[2], "utf8"); // any KiCad file: .kicad_pcb, .kicad_sch, .kicad_sym, …
const doc = parse(text);
console.log(serialize(doc) === text); // true: an unmodified file is written back byte for byte

const root = doc.children.find(isList); // (kicad_pcb …)
console.log(arg(findChild(root, "version"), 0)); // the file format version, e.g. 20260206
```

Node.js 22.12 or later, or any modern browser. No dependencies. Apache-2.0.
