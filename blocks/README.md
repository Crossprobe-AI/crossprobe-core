# Design blocks

Ready-made pieces of a design: a module with its reference circuit, a power
stage, an interface. Crossprobe stores them in **KiCad's own design-block
format** (KiCad 9+), so any KiCad user can add the library and use them there
too, and Crossprobe adds what KiCad's format has no place for: where each
value comes from, whether a person has checked it, and a checklist.

```
blocks/
  specs/                     the source of truth: one JSON per block
  images/                    <id>.svg (cropped schematic, for the page) and <id>.png (1200x630, social preview)
  library/
    crossprobe.kicad_blocks/                  a KiCad design-block library
      <id>.kicad_block/
        <id>.kicad_sch                        the schematic (KiCad)
        <id>.json                             description + keywords (KiCad)
        <id>.crossprobe.json                  sources, review status, parts, checklist (Crossprobe)
```

The files under `library/` and `images/` are generated and committed, so a
change is an ordinary diff. Images need `kicad-cli` and `rsvg-convert`; without
them the build skips them and keeps the committed ones.

## Public repository

The library is published to
[github.com/Crossprobe-AI/kicad-design-blocks](https://github.com/Crossprobe-AI/kicad-design-blocks)
on every change. Its README is generated from the `.crossprobe.json` files, so
edit blocks here, never there.

## How a block is made

1. **Draft a spec** (`blocks/specs/<id>.json`): the parts (KiCad symbol,
   value, footprint), the net each pin goes to, notes for the sheet, and a
   checklist, plus the `seo` title and description for its public page. AI can
   draft this from the datasheet. Every part and checklist
   item names its **source** (document and page) or is marked
   `"basis": "convention"` when it is common practice rather than something
   the document says.
2. **Generate:** `node scripts/build-blocks.mjs` (needs `npm run build` and
   KiCad's symbol libraries) turns the spec into the schematic in KiCad's
   layout, then checks it: citations resolve, and the schematic's nets, read
   with the same connectivity code the app uses, are exactly the spec's.
   Output is deterministic: rebuilding changes nothing. `--check` fails if
   the committed library is out of date.
3. **Review:** a person compares each value with its cited page and the
   rendered schematic, then sets `"status": "reviewed"`, `reviewedBy` and
   `reviewedAt`. Until then the block is a `draft` and is shown as one.
4. **Tests** (`npm test`) use KiCad as the oracle: KiCad must load every
   block, its netlist must equal the spec, and ERC may report only the
   unavoidable "power input not driven" (a block has no supply). Inserting a
   block into a KiCad demo project must give a netlist that KiCad and our code
   agree on.

## Using a block

`insertBlock` (in `@crossprobe/kicad-model`) copies a block's schematic into a
sheet with its library symbols, gives new parts references like `C?` and
instance data for the target project; `planAnnotation` in `unannotated` mode
then numbers them. Items that touch existing wires join their nets, so
`findFreeSpot` finds empty space below the sheet's content.

## Rules for content

- **Cite or label.** A claim from a document needs a page; anything else is
  `convention`. The checklist separates what is *required* by the datasheet
  from *recommended* practice and *info*.
- **Don't copy documents.** Values and pin assignments are facts, quoted with
  page numbers. Schematics are redrawn from KiCad's own symbols; text from a
  datasheet is not reproduced beyond short quotes.
- **Licenses.** Blocks are Apache-2.0. KiCad's symbols and footprints are
  CC-BY-SA 4.0 with KiCad's exception for designs that use them. Espressif's
  hardware guidelines are Apache-2.0; its datasheets are not, so we cite them.
- **Datasheet versions change.** Each source names the version it was read
  from. Re-check a block when the datasheet is revised.

## Blocks

| Block | Status | Source |
|---|---|---|
| `esp32-s3-wroom-1-minimal`: ESP32-S3-WROOM-1 module with decoupling, EN reset network and button, USB, UART, JTAG and boot header | draft | Espressif datasheet v1.8, Figure 9-1 |
| `esp32-c3-wroom-02-minimal`: ESP32-C3-WROOM-02 module with decoupling, EN reset network and button, boot-strap pull-ups, USB, UART, JTAG and boot header | draft | Espressif datasheet v1.7, Figure 9-1 |
| `rp2040-minimal`: RP2040 with decoupling, internal regulator capacitors, W25Q128JVS flash, 12 MHz crystal, USB and BOOTSEL | draft | Raspberry Pi, Hardware design with RP2040; MIT design files R3-S1 |
| `ap2112k-3v3-ldo`: 3.3 V, 600 mA LDO from 5 V | draft | Diodes AP2112 datasheet, DS39724 Rev. 2-2 |
| `mcp73831-li-ion-charger`: single-cell Li-ion charger, 500 mA | draft | Microchip MCP73831/2 datasheet, DS20001984H |
| `usb-c-power-input`: USB-C receptacle as a 5 V sink with USB 2.0 data | draft | USB Type-C Cable and Connector Specification, Release 2.0 |

Blocks combine: take 3.3 V for the RP2040 or ESP32 block from the LDO block.

## PCB layouts

A spec may carry a `layout`: part positions, tracks and vias (mm, KiCad board
coordinates), plus layout rules with the same citation rules as the checklist.
The build writes `<id>.kicad_pcb` next to the schematic and a layout picture
(`blocks/images/<id>-pcb.svg`). KiCad's DRC with schematic parity must pass:
the only findings allowed are the missing board outline (a block takes the
board it is placed on) and, for modules, drill sizes and library-mismatch
notes that come from KiCad's own footprint.

| Block | Layout |
|---|---|
| `ap2112k-3v3-ldo`, `mcp73831-li-ion-charger`, `usb-c-power-input` | placed and routed |
| `esp32-s3-wroom-1-minimal`, `esp32-c3-wroom-02-minimal` | placement (`"routed": false`) with antenna keep-out clear, plus the critical nets routed: 3V3 decoupling, ground pin, EN reset network; the rest is a ratsnest |
| `rp2040-minimal` | placement only: decoupling at the supply pins, crystal at XIN/XOUT, flash near the QSPI pins; nothing routed (0.4 mm pitch fan-out depends on your rules) |

`fabReferences` puts reference designators on the fab layer in dense placements.

"Add block" in the app and "Open in Crossprobe" put the footprints (and
copper, when the block is routed) on the project's board, linked to the new
schematic symbols. Layouts are drafts too: review them with the schematic.
