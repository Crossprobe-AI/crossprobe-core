# End-to-end: a simple board, start to finish, in the browser

The benchmark is KiCad's own *Getting Started in KiCad* tutorial (battery, resistor,
LED): it is the flow that nearly every beginner tutorial and video repeats. A
startup or consultant has to be able to do all of it in Crossprobe without opening
KiCad. Common beginner failure points from tutorials are wrong or missing
footprint assignment, skipped ERC (missing PWR_FLAG), skipped DRC, an open board
outline, and stale zone fills.

| Step | Tutorial action | Status |
|---|---|---|
| 1 | New project | done (KiCad 10 files, default rules; first save asks for a folder or downloads a zip) |
| 2 | Place symbols (A), move / rotate / delete | done |
| 3 | Wires (W), labels (L) | done; T-joins get junctions automatically, wires end on a wire's middle |
| 4 | Power symbols (P), PWR_FLAG | done: Power tool (P) with one-click GND, +3V3, +5V, VCC, … and PWR_FLAG |
| 5 | Annotate | done |
| 6 | Edit value / properties (E) | done (inspector) |
| 7 | Assign footprints (CvPcb) | done: chooser filtered by the symbol's footprint filters and pin count, with a pad preview; a table of all parts |
| 8 | ERC | done (KiCad-exact) |
| 9 | BOM | done (CSV grouped by value, footprint and part number, in the fab zip) |
| 10 | Board setup (layers, rules, net classes) | copper layer count (2–8, inner layers and stackup as KiCad's Board Setup makes them), design-rule minimums, and net classes (sizes, nets by pattern, add/remove) editable, with KiCad-default and JLCPCB 2- and 4-layer presets |
| 11 | Update PCB from schematic (F8) | done; new footprints packed by their courtyards |
| 12 | Board outline on Edge.Cuts | done: rectangle, rounded rectangle or polygon; width / height in the properties panel; 4 × M3 corner holes in one click |
| 13 | Place footprints: move / rotate / flip | done |
| 14 | Route (X), vias (V), unrouted count | done; routes only end on pads of their own net; one-click autorouting per connection or for all (grid router, KiCad-DRC-clean) |
| 15 | Copper zone (GND pour) | done: polygon tool or "whole board", net / layer editable |
| 16 | DRC | clearance, edge, shorts, unconnected, hole size, annular ring, dangling tracks / vias, courtyard overlap, co-located holes, starved thermals (all KiCad-exact on the demos); silkscreen and mask checks to add |
| 17 | 3D viewer | done |
| 17b | Silkscreen text | done: Text tool (front or, viewed from below, mirrored back), editable content, size and side |
| 18 | Gerbers + drill files | done: Gerber X2 per layer and Excellon PTH/NPTH, checked against KiCad's plots |
| 19 | Pick-and-place (assembly) | done: identical to KiCad's CSV position file |

## Priorities

Done: new project, board outline (rectangle, rounded, polygon), zone tool, footprint
assignment (filtered chooser, project reuse), fabrication outputs
(Gerber X2, drill, BOM, pick-and-place, optional JLCPCB files), the power tool,
silkscreen text, mounting holes, board setup with fab presets, one-click ERC and DRC
fixes, an autorouter for single connections (one layer, else vias), walkaround and
shove interactive routing, differential pairs, length tuning, "Route all" with fan-out,
rip-up and stitching to pours, plus the fixes the scripted runs turned up.

1. Board polish: logo edges follow pixels (no curve smoothing); teardrops are straight-edged (KiCad also offers curved ones); radial dimensions show text only.
2. Routing: shove pushes up to three tracks deep, but along the grid: tracks at exactly the minimum spacing count as crowded; differential pairs don't shove or swap P/N (KiCad's router doesn't swap either: place the parts so the pair arrives in order); meanders are square and single-sided. A pair's skew is matched with low bumps on the shorter leg where they fit, not with KiCad's coupled skew serpentines. "Route all" takes about 5 s on the USB board (in the worker).
3. DRC exclusions are set from the Issues tab. KiCad honours one only where our marker position matches its own.
4. Copper connection width (min_connection) isn't checked. A first try that followed KiCad's vertex-pair search flagged thermal spokes and fill bridges KiCad doesn't, so it was shelved.

`scripts/e2e-tutorial.mjs` builds the tutorial board in the browser from a new
project (place, wire, power flag, footprints through the chooser, ERC, Update PCB, flip, rounded
outline, mounting holes, silkscreen text, route, GND zone, fab zip) and saves the files. KiCad then reports them ERC-clean, parity-clean and fully
routed, with no DRC violations at all. As in KiCad's tutorial the battery is flipped
to the back so the GND pour on B.Cu connects it to the LED.

## Videos of the runs

`RECORD=<file.webm>` on `scripts/e2e-usb.mjs` or `scripts/e2e-power.mjs` saves a video of the
run at twice the speed. No ffmpeg is needed:
1. Chrome DevTools' screencast collects the frames while the script works.
2. A blank page replays them onto a canvas, and the browser's MediaRecorder encodes the WebM
   (`scripts/lib/record.mjs`).

## The README's GIF

`scripts/readme-demo.mjs <project folder>` records `docs/media/demo.gif` from a board in
progress: the USB-C board below, stopped before "Route all"
(`STOP=poured node scripts/e2e-usb.mjs <project folder>`). The run opens the
project folder from the start screen, selects the microcontroller in the schematic, shows it on the board, routes one connection by hand,
runs "Route all" and turns the 3D view, with a short caption on each step. The frames are screenshots, and
`scripts/lib/gif.mjs` encodes them, so this needs no ffmpeg either. Run it again when the
app's look changes.

## Fabrication outputs

"Fab outputs" in the top bar runs a pre-flight (closed outline, everything routed, no
clearance problems, current zone fills, ERC, footprints) and downloads one zip:
Gerber X2 for copper, mask, paste, silkscreen and the outline, Excellon drill files,
a BOM and a pick-and-place file, named the way KiCad names them. Against KiCad's own
plots of the demo boards, every layer, silkscreen text included, covers the same
shapes within 1% (most exactly), the holes are the same, and position files are
identical. Text is drawn in KiCad's own stroke font (Newstroke, which its author
released as CC0) and laid out as KiCad does; TrueType text comes from the glyph
outlines KiCad caches in the file. The zip also carries the IPC-D-356 test netlist
(`<board>.d356`). It is byte-identical to KiCad's own IPC-D-356 export on all 19 demo
boards (`test/ipc356.test.ts`).

It also carries KiCad's Gerber job file (`<board>-job.gbrjob`). The file gives the board's
size, layer count, thickness and finish, plus its clearances, minimum track widths, each
Gerber's function and the material stackup. On all 19 demo boards, its specs, design rules and
stackup equal those in KiCad's job file. On three boards the whole file does, character
for character after the header (`test/gbrjob.test.ts`). The Gerbers' `%TF.ProjectId` uses
KiCad's GUID and the title block's revision.

## IPC-2581 and ODB++

`scripts/e2e-fab-formats.mjs` turns on both options in pic_programmer's Fab outputs. The zip
carries `pic_programmer-IPC-2581.xml` and a `pic_programmer-odb/` tree. Each equals KiCad's
own export by what CAM tools read: 63 parts, 112 nets, 251 holes. The zip's Gerber job file
equals KiCad's after the header, so the project's design rules reach it.

## STEP

`scripts/e2e-step.mjs` exports pic_programmer from the 3D view: the board and 54 part models,
with 2 VRML-only models left out, as KiCad also leaves them out. OpenCascade reads the download
as 62 meshes, 35175 mm³; KiCad's STEP is 62 meshes, 35178 mm³ (our holes are polygons).

The 3D view seats parts where KiCad's 3D viewer does: at z 1.585 mm on top (body 1.51 + F.Cu
0.035 + paste 0.04), and −0.075 mm underneath.

## Mesh exports (GLB, STL, PLY)

`scripts/e2e-mesh-export.mjs` exports pic_programmer as GLB, STL and PLY from the 3D view. Each
has the board and 56 part models, the two VRML-only ones included. Against KiCad's exports
(`--subst-models`):
- GLB: the same 56 parts, each part's box within 0.014 mm, the whole board's box identical;
- STL and PLY: the whole box identical (mm, Z up), and the PLY has a colour per vertex;
- STL: the enclosed volume within 0.05% of KiCad's. Where the board body had faces wound
  inwards, it came out 8% short.

## Plots (PDF and SVG)

"Plot" in the top bar exports the schematic's sheets, or any board layers, as SVG files or one
PDF. The PDF goes through the browser's print dialog, with a page per sheet or layer at its own
size, so it stays vector.
- Board layers are drawn by the same layer plot as the Gerbers. `scripts/check-plot-svg.mjs`
  rasterizes ours and KiCad's SVG export for 3 demo boards × 6 layers, and they match
  to the pixel, drill marks included.
- `scripts/e2e-plot.mjs` drives the dialog on pic_programmer. It checks one SVG per sheet, a
  PDF with a page per sheet at A4, and front and back copper with the back mirrored.

## A second board: SMD, net labels, two pours

`scripts/e2e-smd.mjs` builds a small SMD LED driver (2-pin header, 0603 resistor, LED
and capacitor) the other common way: pins are connected by net labels instead of
wires, the parts are dragged into place after Update PCB, GND gets a pour on both
sides with stitching vias, and the outline is a rounded rectangle. KiCad reports the
saved project ERC-clean, DRC-clean, fully connected and in sync with the schematic.

## Unsaved changes survive a reload

`scripts/e2e-persist.mjs` edits a new project, a project from a block link and a
folder project (an in-browser OPFS folder stands in for the folder picker), reloads
the page and checks that the same files come back unsaved, text for text. Save then
writes the restored edits into the folder. It also checks that Discard goes back to the
files as saved (or to the start screen for a project never saved) and that the
start-screen link drops the kept changes. It needs no KiCad install.

## A third board: USB-C microcontroller

`scripts/e2e-usb.mjs` is the board a startup's first product looks like. It has an
ATmega32U4 (TQFP-44, 0.8 mm pitch), a USB-C receptacle (0.5 mm pitch), an AMS1117
regulator, an 8 MHz crystal, decoupling, an LED and an I2C header, 21 parts in all.
It is drawn the way most real schematics are: power symbols and net labels on the
pins, and the unused pins flagged with one "No-connect all".

The board steps:

1. Parts are placed by hand, with the connector rotated to face the edge.
2. A reference is dragged off a neighbour's pads.
3. Copper to hole is set to the fab's figure: this receptacle's own contacts sit
   0.18 mm from its pegs.
4. Both USB pairs are routed with the differential-pair tool. The MCU-side pair is
   then matched ("Match pair": 0.154 mm of skew made up by one low bump).
5. GND is poured on both sides, with the front pour joining pads solidly.
6. "Route all" does the rest.

KiCad then reports the saved project ERC-clean, DRC-clean, fully connected and in
sync with the schematic.

With `LAYERS=4`, the same board is built the usual four-layer way. The JLCPCB 4-layer
preset sets four layers, their rules and their JLC04161H-7628 stackup. A USB net class takes both
pairs and is sized for 90 Ω on that stackup (0.325 mm at a 0.25 mm gap); the pairs are
routed and matched at that width. GND goes on In1.Cu and +3V3 on In2.Cu as whole-board
planes. The signals stay outside, because
"Route all" keeps tracks off other nets' inner planes; the first run put 12 signal
tracks there and left two ground vias without a plane to reach. "Route all" fans the fine-pitch power pins out to the planes,
routes the rest and stitches every other plane pad down with a via, 43 vias in all.
KiCad reports this build clean as well.

What this run turned up, now fixed:

- **Schematic:**
  - Labels on left-hand pins read into the part; they now face away from it.
  - Twenty-five unused pins needed twenty-five clicks; "No-connect all" does them
    in one.
- **View:**
  - Fit framed the board as it was first framed.
  - Clicks on the Fit button reached the board underneath and set an outline
    corner.
- **Silkscreen:** a footprint's reference couldn't be moved apart from the part.
  KiCad-style, it can now be dragged; fields placed by Update PCB get UUIDs, as
  KiCad writes them.
- **Differential pairs:** a USB-C D+ contact has a D− contact on each side. The
  pair now takes whichever of them keeps P and N uncrossed.
- **Route all**, which had left the connector's CC lines, its second D+/D−
  contacts and most ground pins unrouted:
  - Fine-pitch pads now get a straight fan-out stub, outwards or under the part.
  - When the nearest pads can't be joined, other pads of the same two pieces of
    copper are tried.
  - Connections that fail get one round of rip-up and reroute.
  - Ground pins of fine-pitch parts get vias before the signals are routed.
  - Pads the pours don't reach afterwards are stitched to a pour on the other
    layer.
  - An unreachable goal is found by a flood fill instead of an exhaustive search.
- **DRC and router:**
  - The DRC now checks copper to holes, as KiCad does (unplated holes included).
  - The router keeps that clearance too.
  - Board setup has the copper-to-hole field, and zones have KiCad's
    pad-connection setting.

## A fourth board: a through-hole power supply

`scripts/e2e-power.mjs` builds a 12 V → 5 V linear supply, all through-hole:
- a barrel jack, polyfuse and 1N4007 for reverse polarity;
- a 7805 in TO-220;
- electrolytic and disc capacitors;
- a screw terminal;
- a power LED.

The steps:

1. A Power net class (1 mm tracks, 0.3 mm clearance) takes `VIN*, GND, +5V` in
   Board setup.
2. Parts are placed with the jack's mouth at the edge.
3. Four M3 holes go in the corners.
4. GND is poured on the back, and "Route all" routes the rest: the supply nets at
   1 mm, the LED at the default width.

KiCad reports it clean (ERC, DRC, connectivity, parity).

What it turned up:
- **Net classes:** only Default could be edited. Board setup now lists every class
  with its sizes and the nets it takes (KiCad's patterns, with a count of matching
  nets), and classes can be added and removed.
- **Footprints:** the run unticks the chooser's symbol filters for the polyfuse
  (KiCad's own filters don't list PTC footprints). The 7805 symbol comes without a
  footprint, as in KiCad's library, so it gets one from the chooser.

## A footprint of your own

`scripts/e2e-footprint.mjs` gives a 3-pin, 2 mm connector the footprint KiCad's libraries
don't have:
1. "New footprint…" from the chooser.
2. A row of three through-hole pads, pad 1 made square.
3. A fab body, a silkscreen outline and the courtyard. The checks catch the footprint still
   typed SMD, and their fix makes it through-hole.
4. Assign it, then Update PCB places it with its nets.
5. Select it on the board, "Edit footprint", make the pads bigger, and "Update 1 on the
   board".

KiCad loads the project library, and its DRC finds the board's copy the same as the
library's (no `lib_footprint_mismatch`), with the board in sync with the schematic.

## More footprint editing

`scripts/e2e-footprint-more.mjs` works on a copy of pic_programmer's R1 footprint:
1. Draws a custom pad.
2. Mirrors all three pads.
3. Renumbers them backwards as P1–P3.
4. Sets a 3D model with an offset.

KiCad reads all of it back.

## The 3D model preview

`scripts/e2e-model-preview.mjs` opens pic_programmer's R1 footprint in the editor. Its model
shows on a patch of board with the pads, placed with the 3D view's transform. Setting Rotate Z
to 90 writes it to the file's `(model …)`, and the preview shows the turned model.

## A symbol of your own

`scripts/e2e-symbol.mjs` draws a 6-pin amplifier that KiCad's libraries don't have:
1. "New symbol…" from the part picker.
2. Pins from a pasted list (supplies end up top, ground bottom, outputs right).
3. A footprint field, and the fault pin made open-collector.
4. Place it from the project library.
5. "Edit symbol" from the part, add a seventh pin with the pin tool, and "Update 1 on the
   schematic".

KiCad's netlist lists all seven pins with the names and types made, and its ERC finds the
schematic's copy the same as the library's.

## The net inspector

`scripts/e2e-nets.mjs` opens KiCad's 4-layer video demo and the Net Inspector.
- /DQ17's row shows 82.805 mm and 4 vias, which is KiCad's own figure.
- The per-layer columns add up to the track length.
- Sorting, filtering and CSV work.
- Clicking a row selects the net on the board.

## Blind, buried and micro vias

`scripts/e2e-vias.mjs` makes a new four-layer board and uses the via tool twice:
- "Microvias" on F.Cu places a microvia from F.Cu to In1.Cu;
- "Blind/buried" on In1.Cu places a buried via from In1.Cu to In2.Cu.

KiCad's drill export of the saved board makes the same span files as our fab zip.

## Update schematic from PCB

`scripts/e2e-backannotate.mjs` renames R1 to R50 and makes C2 330uF on pic_programmer's board.
"Update schematic" lists both changes, and applies them in one step. KiCad's parity check
of the saved project then finds nothing, as before the edits.

## Renumbering the board by position

`scripts/e2e-renumber.mjs` renumbers pic_programmer's board top to bottom, left to right
(57 references change). The flow is KiCad's:
1. Update schematic sends the new references to the schematic.
2. Update PCB sends the net names made from them.

KiCad's parity check of the saved project then finds nothing. `test/board-reannotate.test.ts`
covers directions, grid rounding, the mirrored back, exclusions, prefixes and start numbers.

## Align and distribute

`scripts/e2e-align.mjs` box-selects R1–R6, D2–D7 and their tracks on pic_programmer's board
(33 items), then from the right-click menu:
1. Align to Top: KiCad's own boxes of the saved board (pcbnew's, footprints without their
   text, as its align tool takes them) give every moved item the same top.
2. Distribute Horizontally with Even Gaps: KiCad's boxes give equal gaps, in the order the
   items had.

Undo puts everything back. `test/arrange.test.ts` compares our boxes with KiCad's on six demo
boards and covers the target choice (locked item, item under the cursor, extreme item).

## Create Array

`scripts/e2e-array.mjs` box-selects 33 items on pic_programmer's board (six footprints, their
tracks and texts) and makes a 3 × 1 grid 30 mm apart from the right-click menu's
"Create Array…". kicad-cli's position file of the saved board has all 12 copies 30 and 60 mm
right of a part like them, under unique references. Undo removes them. `test/board-array.test.ts`
checks the cell offsets (grid, stagger, snake, circle) and has KiCad's pcbnew make the same copies:
every copied footprint matches.

## Position Relative To

`scripts/e2e-posrel.mjs` box-selects six footprints (with their tracks and texts) on
pic_programmer's board, and with Shift+P:
1. Grid origin, offset 120, 100: kicad-cli's position file of the saved board has the top-left
   footprint (R1) at 120, 100 and the others moved by the same amount.
2. An item picked on the board (P3), 10 mm at 90° in polar coordinates: R1 is 10 mm below P3's
   position.

Undo puts everything back. `test/arrange.test.ts` compares item positions (what the reference and
anchor are taken from) with KiCad's on six demo boards.

## Point editing a zone

`scripts/e2e-points.mjs` selects pic_programmer's copper zone by its edge and, from its handles
and the right-click menu:
1. Drags a corner to 240, 50.
2. Drags the top edge up by its middle to y = 40. Its corners slide along the neighbouring
   edges, as in KiCad.
3. Adds a corner on the left edge and removes the one at 74.295, 127.635.

KiCad's pcbnew reads the saved board's outline as exactly those corners. Four undos restore it.
`apps/web/test/point-edit.test.ts` covers the handles of every shape kind.

## Zone properties

`scripts/e2e-zone-props.mjs` selects pic_programmer's copper zone. In its properties panel it sets a
name, priority 2, clearance 0.3, minimum width 0.2, thermal gap 0.6, spoke width 0.4, and removing
islands below 5 mm². The zone refills after each change. KiCad's pcbnew reads every property back
from the saved board as set, and eight undos restore them. `test/zone-props.test.ts` writes two sets
of properties into the zones of three demo boards, and pcbnew reads each one back.

## Groups

`scripts/e2e-groups.mjs` box-selects 33 items on pic_programmer's board and groups them with
Ctrl+G. KiCad's pcbnew reads the group back with its 33 members. Then:
1. One click on R1 selects the whole group, and a drag moves all six footprints by the same
   amount.
2. L locks the group: pcbnew reads it as locked, and a drag moves nothing.
3. Ctrl+Shift+G ungroups it: pcbnew finds no groups, and a click selects R1 alone again.

`test/board-group.test.ts` reads the demo's own groups, then nests, locks, ungroups and prunes
groups. pcbnew reads each step back the same.

## Cleanup tracks & vias

`scripts/e2e-cleanup.mjs` runs Cleanup on pic_programmer's board. It finds 5 collinear merges
and 8 tracks inside pads, and the board goes from 370 tracks to 357. Undo brings them back.
KiCad's DRC of the saved board stays at 0 violations and 0 unconnected.

## Page settings

`scripts/e2e-page.mjs` sets pic_programmer's root sheet to A3 with a new title block, copied
to the other sheet and the board, each keeping its own paper. KiCad's SVG export shows both
sheets with the new title block and the root sheet on A3. The board file carries the title
block too. `test/page-settings.test.ts` checks paper sizes (named, portrait, user) and
title-block text in KiCad's schematic and board SVGs.

## Buses

`scripts/e2e-bus.mjs` builds a small bus in a new project:
- two resistors' pins wired to bus entries (Z, R turns them);
- a bus drawn with the Bus tool (B), labelled `D[0..1]`;
- member wires labelled D0 and D1.

KiCad's netlist puts R1 pin 1 on /D0 and R2 pin 1 on /D1, as ours does. KiCad's ERC has no
bus findings.

## Schematic text and graphics

`scripts/e2e-sch-graphics.mjs` draws notes in a new project:
- a text (T) and a text box;
- lines, a rectangle and a circle;
- then a double-click on the text renames it.

KiCad's `sch upgrade` writes the same items back, and its SVG plot shows both texts.
`test/sch-graphics.test.ts` checks the model functions the same way.

## Symbol properties and global labels

`scripts/e2e-symbol-props.mjs` changes placed parts in the inspector, on KiCad's demos:
- a pin of cm5_minima's accelerometer is switched to an alternate function (SDI to SDA);
- the part is marked do-not-populate and its Value is hidden;
- a global label is placed with the Global label tool and its shape changed;
- a PIC on pic_programmer is switched to its De Morgan body.

KiCad's `sch upgrade` writes each change back, and its netlist names the pin SDA and
marks the part DNP. `test/symbol-props.test.ts` checks the model functions the same way.

`scripts/e2e-field-move.mjs` drags a resistor's value away from the part, turns it (R)
and changes it with a double-click, then drags the part: its fields go along. KiCad
writes the field back where it was put.

## Symbol units

`scripts/e2e-symbol-units.mjs` builds a two-unit symbol in the symbol editor:
- unit A gets pins 1 and 2 and a box, and unit B gets pins 3 and 4 and an arc;
- unit B is named OUT, the units are locked, a De Morgan style is added, and pins 1 and 2
  become a jumper group;
- in the pin table, pin 1 is renamed and pin 4 retyped.

It then makes a second symbol into a supply power symbol. KiCad's `sym upgrade` reads both
back the same, and KiCad plots both units in both body styles.

## Multi-unit parts

`scripts/e2e-units.mjs` places an LM324 (four amplifiers and a power unit) from the part picker,
which places U1A.
- The part's "Units" row offers "Place B–E". Each click places the next unit under the same
  reference, and the tool goes back to select after the last one.
- KiCad's ERC reports `missing_unit` before and not after.
- KiCad's netlist has one U1 with all 14 pins.

## The symbol fields table

`scripts/e2e-fields.mjs` opens KiCad's pic_programmer demo and the Fields table:
1. Add an MPN column and fill it on the grouped 10K line (R1–R7).
2. Ungroup, and change C1's value.

KiCad's BOM export of the saved schematic shows the MPN on exactly those seven resistors and
C1's new value.

## Editing an existing KiCad project

`scripts/e2e-roundtrip.mjs` opens KiCad's pic_programmer demo, changes a resistor's
value in the schematic, runs Update PCB, refills the zones and saves. KiCad then
reports the same ERC and DRC results as for the untouched original, the board in
sync with the schematic, and the schematic differs by exactly the one changed line.

## Clicks, and undo around a zone refill

`scripts/e2e-click.mjs` clicks a pad of StickHub's J2, which sits off the edit grid. The click
selects J2 and changes nothing: same position, nothing to save. A press that wobbles by a pixel
does the same. A drag moves J2 and snaps it to the grid.

`scripts/e2e-zone-undo.mjs` deletes a track on pic_programmer's board, refills the zones and
undoes both. The fill from before the refill comes back, in the model and on the canvas, and
the "zones are out of date" notice follows undo and redo.
