# Changelog

## [0.4.0](https://github.com/Crossprobe-AI/crossprobe-core/compare/v0.3.0...v0.4.0) (2026-11-25)


### Features

* a viewer on phones: the views as tabs, a tapped part's details, pinch to zoom ([#152](https://github.com/Crossprobe-AI/crossprobe-core/issues/152)) ([f97a991](https://github.com/Crossprobe-AI/crossprobe-core/commit/f97a9911ea78fcf82f0835b0e5c61425b1e00d94))
* board.lengthMatch in a design spec; the length tuner keeps the hole clearance ([#145](https://github.com/Crossprobe-AI/crossprobe-core/issues/145)) ([03967c7](https://github.com/Crossprobe-AI/crossprobe-core/commit/03967c7e5319099ce57ff403da6c34cc2f322693))
* design specs place multi-unit symbols; routing can be given a deadline ([#120](https://github.com/Crossprobe-AI/crossprobe-core/issues/120)) ([5c72145](https://github.com/Crossprobe-AI/crossprobe-core/commit/5c72145af462c8a52d6331e06d984431b745f348))
* negotiated rip-up in Route all, for what the first passes leave open ([#148](https://github.com/Crossprobe-AI/crossprobe-core/issues/148)) ([c6eeedb](https://github.com/Crossprobe-AI/crossprobe-core/commit/c6eeedb41a9c6da2ded20b6998dc25df667127d1))
* net classes in a design spec; the router keeps the hole clearance from vias it made ([#141](https://github.com/Crossprobe-AI/crossprobe-core/issues/141)) ([9b19999](https://github.com/Crossprobe-AI/crossprobe-core/commit/9b19999b9f49dd53a0fa73277e3c5330761104a7))
* place.along, a part's position along its edge ([#146](https://github.com/Crossprobe-AI/crossprobe-core/issues/146)) ([f340cc0](https://github.com/Crossprobe-AI/crossprobe-core/commit/f340cc09f85fb248ecfdde0d447ed2ac5009cfdc))
* Route all routes a differential pair as one, coupled at the class's pair width and gap ([#143](https://github.com/Crossprobe-AI/crossprobe-core/issues/143)) ([321484d](https://github.com/Crossprobe-AI/crossprobe-core/commit/321484d5ca20f57471c57893fab254715afe8279))
* routeThrough, a route through points chosen by hand ([#149](https://github.com/Crossprobe-AI/crossprobe-core/issues/149)) ([2e8475b](https://github.com/Crossprobe-AI/crossprobe-core/commit/2e8475b49b48f93d7489d4ed9e18cf12dfa951d7))
* the autorouter leaves a fine-pitch pad by a neck when its net's track is too wide ([#130](https://github.com/Crossprobe-AI/crossprobe-core/issues/130)) ([6d4db9b](https://github.com/Crossprobe-AI/crossprobe-core/commit/6d4db9b54f6fd66f70c36219530e5cfbe8cc7ab8))
* the design placer keeps parts apart by a courtyard's shape, not its box ([#114](https://github.com/Crossprobe-AI/crossprobe-core/issues/114)) ([#135](https://github.com/Crossprobe-AI/crossprobe-core/issues/135)) ([d65dad0](https://github.com/Crossprobe-AI/crossprobe-core/commit/d65dad0c9e2716106848e231acf64190d19e88b4))
* viaInPad on a design spec's part ([#144](https://github.com/Crossprobe-AI/crossprobe-core/issues/144)) ([e28036a](https://github.com/Crossprobe-AI/crossprobe-core/commit/e28036ae0d97104ed04ef0cd151325e753e68dec))


### Bug Fixes

* an unplated hole's own clearance is kept from it, as in KiCad ([#129](https://github.com/Crossprobe-AI/crossprobe-core/issues/129)) ([344b9d7](https://github.com/Crossprobe-AI/crossprobe-core/commit/344b9d75fd4d7bb15954370c3743d7eb84b05d6d))
* an unplated pad with a ring of copper is copper, and items without a net are on one net, as in KiCad ([#128](https://github.com/Crossprobe-AI/crossprobe-core/issues/128)) ([#132](https://github.com/Crossprobe-AI/crossprobe-core/issues/132)) ([ec35f39](https://github.com/Crossprobe-AI/crossprobe-core/commit/ec35f39908792c3bb148a833175759fc52077f69))
* an unplated slot is a board edge, as in KiCad ([#131](https://github.com/Crossprobe-AI/crossprobe-core/issues/131)) ([#133](https://github.com/Crossprobe-AI/crossprobe-core/issues/133)) ([cf07729](https://github.com/Crossprobe-AI/crossprobe-core/commit/cf077294133591e0574b211a640433606706ba83))
* generated sheets keep their texts apart, and pin numbers sit where KiCad draws them ([#136](https://github.com/Crossprobe-AI/crossprobe-core/issues/136)) ([8016a36](https://github.com/Crossprobe-AI/crossprobe-core/commit/8016a36602bec2137333e93985247ecf4b0eb028))
* KiCad 5 footprints read and placed as KiCad does; parts kept off holes outside a footprint's body ([#126](https://github.com/Crossprobe-AI/crossprobe-core/issues/126)) ([ad77a83](https://github.com/Crossprobe-AI/crossprobe-core/commit/ad77a837c49b325e7c0792c7349b798a2a71f0cf))
* routeThrough keeps the hole to hole between its own vias ([#151](https://github.com/Crossprobe-AI/crossprobe-core/issues/151)) ([00bd23e](https://github.com/Crossprobe-AI/crossprobe-core/commit/00bd23ed5d825df95457228ea99a9cfa6c02d810))
* the phone viewer's top bar and round buttons ([#154](https://github.com/Crossprobe-AI/crossprobe-core/issues/154)) ([4b1b98b](https://github.com/Crossprobe-AI/crossprobe-core/commit/4b1b98bb7e2de65cca8492073a3fa28d9f0bb042))


### Performance Improvements

* the autorouter does the same work in a fraction of the time ([#125](https://github.com/Crossprobe-AI/crossprobe-core/issues/125)) ([f3e6e0b](https://github.com/Crossprobe-AI/crossprobe-core/commit/f3e6e0b70e04bb73a929826e1281e9f85f8c64c3)), closes [#121](https://github.com/Crossprobe-AI/crossprobe-core/issues/121)
* the router checks there is a way at all before its first search ([#147](https://github.com/Crossprobe-AI/crossprobe-core/issues/147)) ([404802b](https://github.com/Crossprobe-AI/crossprobe-core/commit/404802bfc379688e7bc712caa014f75b697882fc))

## [0.3.0](https://github.com/Crossprobe-AI/crossprobe-core/compare/v0.2.0...v0.3.0) (2026-11-23)


### Features

* a link to the source in the top bar, with GitHub's mark ([#119](https://github.com/Crossprobe-AI/crossprobe-core/issues/119)) ([290aa65](https://github.com/Crossprobe-AI/crossprobe-core/commit/290aa659affee3e5159bf7f69e60b448974b2fa2))
* a start-new slot at the top of the start screen's new-project card ([#111](https://github.com/Crossprobe-AI/crossprobe-core/issues/111)) ([28054b8](https://github.com/Crossprobe-AI/crossprobe-core/commit/28054b8ddd7746a34c97da2b7d20f8b756fffca3))
* CopyField for values of several lines; OverflowTabs exported, with a label ([#106](https://github.com/Crossprobe-AI/crossprobe-core/issues/106)) ([4a6e44f](https://github.com/Crossprobe-AI/crossprobe-core/commit/4a6e44f1c46187a584ea9deea8fa8e16febf254b))
* error boundaries, and an onError hook for extensions ([#108](https://github.com/Crossprobe-AI/crossprobe-core/issues/108)) ([57366ec](https://github.com/Crossprobe-AI/crossprobe-core/commit/57366ec93d2b7fa7afd04bafa34805a5c6c7b5a2))
* hosted at the root of its own domain; contributing and security guides, issue forms, package metadata ([#97](https://github.com/Crossprobe-AI/crossprobe-core/issues/97)) ([7bd3f29](https://github.com/Crossprobe-AI/crossprobe-core/commit/7bd3f2911f42705f37f38d3b8759d7c49a542110))
* place.near can name a pin ("U1:1"), to sit a part beside that pad ([#113](https://github.com/Crossprobe-AI/crossprobe-core/issues/113)) ([5d6907d](https://github.com/Crossprobe-AI/crossprobe-core/commit/5d6907dd1d721332303ba8365851714f0e57535f))
* start screen with a card for each way in, and the design blocks as examples ([#105](https://github.com/Crossprobe-AI/crossprobe-core/issues/105)) ([984f3f6](https://github.com/Crossprobe-AI/crossprobe-core/commit/984f3f678ac8956387834bc673cbf8a61ccda7ad))


### Bug Fixes

* a menu closes when an extension's item in it is chosen ([#109](https://github.com/Crossprobe-AI/crossprobe-core/issues/109)) ([0efca4c](https://github.com/Crossprobe-AI/crossprobe-core/commit/0efca4c91a45d3207d8043a053a5773ed4146122))
* an overhanging part keeps its pads the edge clearance ([#117](https://github.com/Crossprobe-AI/crossprobe-core/issues/117)) ([ff47852](https://github.com/Crossprobe-AI/crossprobe-core/commit/ff47852c1340c0a420dbab06ab37b5ae03837fed))
* part_count matches each field on its own, and counts by reference prefix ([#112](https://github.com/Crossprobe-AI/crossprobe-core/issues/112)) ([aa37a50](https://github.com/Crossprobe-AI/crossprobe-core/commit/aa37a509601644ecc5dffa9e24ba3d19e3c0cfce))
* the design placer keeps parts apart by their bodies, not their reference texts ([#115](https://github.com/Crossprobe-AI/crossprobe-core/issues/115)) ([627f624](https://github.com/Crossprobe-AI/crossprobe-core/commit/627f6243dbfde637e9f8e4ec0a10f782f82e29d3))

## [0.2.0](https://github.com/Crossprobe-AI/crossprobe-core/compare/v0.1.1...v0.2.0) (2026-11-19)


### Features

* align and distribute on the board, as KiCad's tool ([#3](https://github.com/Crossprobe-AI/crossprobe-core/issues/3)) ([121c631](https://github.com/Crossprobe-AI/crossprobe-core/commit/121c631c9a25e8278f802d86688f0fb1780bcf71))
* Create Array on the board, as KiCad's tool ([32b6ab2](https://github.com/Crossprobe-AI/crossprobe-core/commit/32b6ab2e17632ad37aed8476e11b9a7d0cdb0938))
* custom drawing sheets (.kicad_wks) on schematic pages ([#27](https://github.com/Crossprobe-AI/crossprobe-core/issues/27)) ([af056f3](https://github.com/Crossprobe-AI/crossprobe-core/commit/af056f3ec08f76c77acad3ecb22732eb6a48a44c))
* differential pair gap and uncoupled length rules in DRC ([#29](https://github.com/Crossprobe-AI/crossprobe-core/issues/29)) ([7a77419](https://github.com/Crossprobe-AI/crossprobe-core/commit/7a77419c27ceb6de6e66c9f1b2c325d31da81dd8))
* drawing sheet logos (bitmaps) in the board's page frame ([#58](https://github.com/Crossprobe-AI/crossprobe-core/issues/58)) ([26d31e8](https://github.com/Crossprobe-AI/crossprobe-core/commit/26d31e893daee332d263981908a4eb6a50c24e9c))
* DRC for holes in courtyards, overlapping zones and footprint types ([#22](https://github.com/Crossprobe-AI/crossprobe-core/issues/22)) ([aade016](https://github.com/Crossprobe-AI/crossprobe-core/commit/aade0160f52252c6cbe60cb2044ea4bd5dd25b37))
* edit zone properties: name, priority, clearance, widths, islands ([#15](https://github.com/Crossprobe-AI/crossprobe-core/issues/15)) ([df0ac78](https://github.com/Crossprobe-AI/crossprobe-core/commit/df0ac78ca661439d5a0cff3a9635d9b4028acdc3))
* ERC exclusions, and five more ERC checks (ground pins, shared unit pins, buses) ([#25](https://github.com/Crossprobe-AI/crossprobe-core/issues/25)) ([2e3bf9c](https://github.com/Crossprobe-AI/crossprobe-core/commit/2e3bf9c8e019655d34d562a1ad4e72d494018fcb))
* find and replace, arcs, intersheet references, alternates in the symbol editor, four more ERC checks ([#17](https://github.com/Crossprobe-AI/crossprobe-core/issues/17)) ([3ad8a2e](https://github.com/Crossprobe-AI/crossprobe-core/commit/3ad8a2ecbd8d74fa504446e3d7277f746e5b68dd))
* footprints against their library copies, as KiCad's DRC ([#23](https://github.com/Crossprobe-AI/crossprobe-core/issues/23)) ([4d902c4](https://github.com/Crossprobe-AI/crossprobe-core/commit/4d902c43d3eb572828842ae1bfe76d3dd19e433f))
* groups on the board, as KiCad's ([#18](https://github.com/Crossprobe-AI/crossprobe-core/issues/18)) ([dd254db](https://github.com/Crossprobe-AI/crossprobe-core/commit/dd254db13ab7a1dbfdeb2620a295b405ab9bc3d8))
* hatched zone fills ([#49](https://github.com/Crossprobe-AI/crossprobe-core/issues/49)) ([52b7589](https://github.com/Crossprobe-AI/crossprobe-core/commit/52b75890b643068e9ec87b3b2bb63961d9349e31))
* images in the schematic ([#28](https://github.com/Crossprobe-AI/crossprobe-core/issues/28)) ([99ca1de](https://github.com/Crossprobe-AI/crossprobe-core/commit/99ca1dee458327a6739906d7381bc7e8cadee3f4))
* length and skew rules in DRC, with fromTo between parts ([#26](https://github.com/Crossprobe-AI/crossprobe-core/issues/26)) ([434e681](https://github.com/Crossprobe-AI/crossprobe-core/commit/434e68120375d27e0bae79c8fc62cf99d26b69ff))
* minimum connection width in DRC, as KiCad checks it ([#84](https://github.com/Crossprobe-AI/crossprobe-core/issues/84)) ([deb0630](https://github.com/Crossprobe-AI/crossprobe-core/commit/deb0630228179407028dc052ba867fd0e77c0437))
* missing and malformed courtyards and malformed board outline in DRC, as KiCad checks them ([#95](https://github.com/Crossprobe-AI/crossprobe-core/issues/95)) ([c1d0286](https://github.com/Crossprobe-AI/crossprobe-core/commit/c1d0286fcb9c5125b8f878b6ae1f489c241f0023))
* net class directives and rule areas, and nets in several classes as KiCad 10 makes them ([#24](https://github.com/Crossprobe-AI/crossprobe-core/issues/24)) ([15af3de](https://github.com/Crossprobe-AI/crossprobe-core/commit/15af3de3e2df4ee6f7501fb994fb701d87f83bee))
* point editing of zones and shapes on the board, as KiCad's ([82ebba2](https://github.com/Crossprobe-AI/crossprobe-core/commit/82ebba26055da96c3529886312f5920abf2f02ea))
* Position Relative To on the board, as KiCad's tool ([200518a](https://github.com/Crossprobe-AI/crossprobe-core/commit/200518aff708dfb500d94ae2714694d7bc3064c8))
* save a selection as a design block ([#30](https://github.com/Crossprobe-AI/crossprobe-core/issues/30)) ([db12f54](https://github.com/Crossprobe-AI/crossprobe-core/commit/db12f54487eb91ee702b03ed6b1651803a7cd292))
* schematic editor parity: global labels, symbol properties, text variables, annotation options, netlist export, field editing ([#8](https://github.com/Crossprobe-AI/crossprobe-core/issues/8)) ([f76e14b](https://github.com/Crossprobe-AI/crossprobe-core/commit/f76e14b734ece051c86277db6264bea2e88e3f4a))
* sheet symbol properties and pin sync, nine more ERC checks, the DNP cross ([#10](https://github.com/Crossprobe-AI/crossprobe-core/issues/10)) ([dcd0899](https://github.com/Crossprobe-AI/crossprobe-core/commit/dcd0899569b53ed9a266810f098ad2a7d51666a4))
* tables and links in the schematic ([#40](https://github.com/Crossprobe-AI/crossprobe-core/issues/40)) ([da75879](https://github.com/Crossprobe-AI/crossprobe-core/commit/da75879868b4e31f0958786082b5b2534a61a9b2))
* text boxes on the board, as KiCad's ([#21](https://github.com/Crossprobe-AI/crossprobe-core/issues/21)) ([8569286](https://github.com/Crossprobe-AI/crossprobe-core/commit/8569286ffc800cf763ecfa161505114ad1793f82))
* the board's page frame (drawing sheet) in the board view ([#41](https://github.com/Crossprobe-AI/crossprobe-core/issues/41)) ([bfd9dc1](https://github.com/Crossprobe-AI/crossprobe-core/commit/bfd9dc1bcafe4cfdb1c5447068487bbbd7c6a76e))
* the editors' tools in a rail at the canvas's left edge; view-only made plain ([#90](https://github.com/Crossprobe-AI/crossprobe-core/issues/90)) ([ddd9271](https://github.com/Crossprobe-AI/crossprobe-core/commit/ddd92715a14f744c5fea1bee65b6f17ca1d134e9))
* the side panels collapse and resize ([#88](https://github.com/Crossprobe-AI/crossprobe-core/issues/88)) ([5edc9ef](https://github.com/Crossprobe-AI/crossprobe-core/commit/5edc9ef1253a0d0f2ebc404390d49deaa0d3078f))


### Bug Fixes

* a drag ends where the pointer is released; released right after the last ([dcd0899](https://github.com/Crossprobe-AI/crossprobe-core/commit/dcd0899569b53ed9a266810f098ad2a7d51666a4))
* a drag ends where the pointer is released; released right after the last ([f76e14b](https://github.com/Crossprobe-AI/crossprobe-core/commit/f76e14b734ece051c86277db6264bea2e88e3f4a))
* a group's box takes in its footprints' texts and the items not modelled here ([#63](https://github.com/Crossprobe-AI/crossprobe-core/issues/63)) ([0d157a3](https://github.com/Crossprobe-AI/crossprobe-core/commit/0d157a3cd27e6fc5d5fd3df5585c4ca7cdf225cd)), closes [#62](https://github.com/Crossprobe-AI/crossprobe-core/issues/62)
* an arc track's place in an array is its centre, as KiCad's GetPosition ([111122b](https://github.com/Crossprobe-AI/crossprobe-core/commit/111122b19100d9fd078edd8b29326e44f1613ff2))
* board dialogs hold keys back, menus stay in view, KiCad 6/7 duplicates selected ([#75](https://github.com/Crossprobe-AI/crossprobe-core/issues/75)) ([802d657](https://github.com/Crossprobe-AI/crossprobe-core/commit/802d657b75cd5bf781bfef5e661f55a2e543c50d))
* board dialogs keep Ctrl keys from the browser; new sheets go next to their parent sheet ([#82](https://github.com/Crossprobe-AI/crossprobe-core/issues/82)) ([ac5368d](https://github.com/Crossprobe-AI/crossprobe-core/commit/ac5368d0fe38829f6f84220be250cbc6871f99be))
* connection width rules see A and B either way round, copper graphics at necks, faster unfracture ([#93](https://github.com/Crossprobe-AI/crossprobe-core/issues/93)) ([452fddc](https://github.com/Crossprobe-AI/crossprobe-core/commit/452fddc73d049816c2f23ab08fb372e68ad0716e))
* drawing sheet paths as KiCad resolves them, for the schematic and the board ([#64](https://github.com/Crossprobe-AI/crossprobe-core/issues/64)) ([91cf442](https://github.com/Crossprobe-AI/crossprobe-core/commit/91cf44205e6e2651f16c28e301ab1055043aa419)), closes [#59](https://github.com/Crossprobe-AI/crossprobe-core/issues/59)
* ERC exclusions KiCad matches, borderless table selection, tables in design blocks ([#60](https://github.com/Crossprobe-AI/crossprobe-core/issues/60)) ([#65](https://github.com/Crossprobe-AI/crossprobe-core/issues/65)) ([2e64e80](https://github.com/Crossprobe-AI/crossprobe-core/commit/2e64e80220919c70f8f8000bd753b9f9aa5ca556))
* failed logos keep no redraws waiting; a sheet path back into the project warns "not found" ([#74](https://github.com/Crossprobe-AI/crossprobe-core/issues/74)) ([1a9e3f2](https://github.com/Crossprobe-AI/crossprobe-core/commit/1a9e3f2261056e37baa047f6b0222d9aee542d12))
* groups turn, align and move by Position Relative as one, unmodelled and locked members included ([#55](https://github.com/Crossprobe-AI/crossprobe-core/issues/55)) ([f4e07e7](https://github.com/Crossprobe-AI/crossprobe-core/commit/f4e07e73c0c69da5d378e729a4bbec81876dd779))
* groups with unmodelled members select, move and ungroup whole; L unlocks parts in a group ([#44](https://github.com/Crossprobe-AI/crossprobe-core/issues/44)) ([a82c90d](https://github.com/Crossprobe-AI/crossprobe-core/commit/a82c90d3773122b2817b0274edf18b6525e95170)), closes [#37](https://github.com/Crossprobe-AI/crossprobe-core/issues/37)
* hatch holes dropped only around a ring's outer edge; nested group boxes as KiCad's ([#73](https://github.com/Crossprobe-AI/crossprobe-core/issues/73)) ([c91f080](https://github.com/Crossprobe-AI/crossprobe-core/commit/c91f080dd00a98a439a9f24353a173ddf4240383)), closes [#68](https://github.com/Crossprobe-AI/crossprobe-core/issues/68)
* hatched zones add their thermal rings back, and relieve same-net vias ([#66](https://github.com/Crossprobe-AI/crossprobe-core/issues/66)) ([6509f65](https://github.com/Crossprobe-AI/crossprobe-core/commit/6509f655693705d5108d4bf9fde4b5bbcc87e5fb)), closes [#61](https://github.com/Crossprobe-AI/crossprobe-core/issues/61)
* hatched zones get KiCad's thermal rings, and fill faster ([#53](https://github.com/Crossprobe-AI/crossprobe-core/issues/53)) ([2217d9f](https://github.com/Crossprobe-AI/crossprobe-core/commit/2217d9f02791119a682f08c34ad7fbabf2deb664)), closes [#51](https://github.com/Crossprobe-AI/crossprobe-core/issues/51)
* inspector ⋯ menu keeps the focus; Save control's borders match; UI tests type-checked ([#83](https://github.com/Crossprobe-AI/crossprobe-core/issues/83)) ([5006dd2](https://github.com/Crossprobe-AI/crossprobe-core/commit/5006dd23cfbc7808728e30534878bc155c39f504)), closes [#80](https://github.com/Crossprobe-AI/crossprobe-core/issues/80)
* items removed by Cleanup Tracks, length tuning or Update from Schematic leave their groups ([#20](https://github.com/Crossprobe-AI/crossprobe-core/issues/20)) ([d0253a0](https://github.com/Crossprobe-AI/crossprobe-core/commit/d0253a053b4f56f926b48ff1f85cc3aa9fb4a6d2))
* one base for what floats over the canvas, and one control in every bar ([#91](https://github.com/Crossprobe-AI/crossprobe-core/issues/91)) ([87268d1](https://github.com/Crossprobe-AI/crossprobe-core/commit/87268d1ac9689e9adcf7555c92457d7296fd41e4))
* plain buttons and fields get the app's look; text without figure-wide punctuation; panels fit their fields ([#87](https://github.com/Crossprobe-AI/crossprobe-core/issues/87)) ([fd35b76](https://github.com/Crossprobe-AI/crossprobe-core/commit/fd35b766b975f5ba37be330aaf1a4984876be744))
* review follow-ups to [#43](https://github.com/Crossprobe-AI/crossprobe-core/issues/43) ([#47](https://github.com/Crossprobe-AI/crossprobe-core/issues/47)) and stacked power pins ([#46](https://github.com/Crossprobe-AI/crossprobe-core/issues/46)) ([#56](https://github.com/Crossprobe-AI/crossprobe-core/issues/56)) ([9385cf5](https://github.com/Crossprobe-AI/crossprobe-core/commit/9385cf50424764b4ac6a07e1ed88cf1de9c89da3))
* Route all frees a pad shut in by an earlier route; renumber e2e waits for each click ([#77](https://github.com/Crossprobe-AI/crossprobe-core/issues/77)) ([6494e25](https://github.com/Crossprobe-AI/crossprobe-core/commit/6494e25ebd36598aefc2b1b85df9d57559c1c3c1)), closes [#72](https://github.com/Crossprobe-AI/crossprobe-core/issues/72)
* schematic follow-ups from [#67](https://github.com/Crossprobe-AI/crossprobe-core/issues/67) and [#71](https://github.com/Crossprobe-AI/crossprobe-core/issues/71) ([#76](https://github.com/Crossprobe-AI/crossprobe-core/issues/76)) ([cda6ba2](https://github.com/Crossprobe-AI/crossprobe-core/commit/cda6ba222af9c7b4a66a692ea3a553c0ba0e17fd))
* schematic review follow-ups ([#31](https://github.com/Crossprobe-AI/crossprobe-core/issues/31), [#33](https://github.com/Crossprobe-AI/crossprobe-core/issues/33), [#35](https://github.com/Crossprobe-AI/crossprobe-core/issues/35), [#36](https://github.com/Crossprobe-AI/crossprobe-core/issues/36), [#38](https://github.com/Crossprobe-AI/crossprobe-core/issues/38), [#39](https://github.com/Crossprobe-AI/crossprobe-core/issues/39)) ([#43](https://github.com/Crossprobe-AI/crossprobe-core/issues/43)) ([4ba9b33](https://github.com/Crossprobe-AI/crossprobe-core/commit/4ba9b33cdb349e5935da0dec9f7ada39ef9cde54))
* skew rules with within_diff_pairs measure within each pair ([#42](https://github.com/Crossprobe-AI/crossprobe-core/issues/42)) ([4747a60](https://github.com/Crossprobe-AI/crossprobe-core/commit/4747a601e2c53f90cd90dd87fb70965fec0d37c8)), closes [#34](https://github.com/Crossprobe-AI/crossprobe-core/issues/34)
* the board frame shows the project's text variables ([#57](https://github.com/Crossprobe-AI/crossprobe-core/issues/57)) ([462946a](https://github.com/Crossprobe-AI/crossprobe-core/commit/462946a9765a6d907e3d405da2b81cba0f282014))
* the README's demo opens the Tools menu for Route all ([#92](https://github.com/Crossprobe-AI/crossprobe-core/issues/92)) ([10d88fb](https://github.com/Crossprobe-AI/crossprobe-core/commit/10d88fb2980aebacc9fbd4d1ebae8b3ee6fb9c8d))
* top bar menus, the inspector's tab bar and Save, with component tests in a browser ([#78](https://github.com/Crossprobe-AI/crossprobe-core/issues/78)) ([c7a60e5](https://github.com/Crossprobe-AI/crossprobe-core/commit/c7a60e5509b0e1f705dd956ed83d0d754eb41816))
* UI review of the past week's editor changes ([#69](https://github.com/Crossprobe-AI/crossprobe-core/issues/69)) ([ec833de](https://github.com/Crossprobe-AI/crossprobe-core/commit/ec833de62e81075ebe8484439e6e7d916bd6c3d8))

## [0.1.1](https://github.com/Crossprobe-AI/crossprobe-core/compare/v0.1.0...v0.1.1) (2026-11-16)


### Bug Fixes

* IPC-2581 gives a part on the back KiCad's angle ([e00d5c6](https://github.com/Crossprobe-AI/crossprobe-core/commit/e00d5c64df0ae68478aee8864e02e2cd76257793))
* IPC-D-356 pad angles and holes without plating as KiCad writes them ([31cce36](https://github.com/Crossprobe-AI/crossprobe-core/commit/31cce364352670133b17f8c75c7949d8591ec359))
* KiCad 6 schematics keep their references and power nets ([8637d9d](https://github.com/Crossprobe-AI/crossprobe-core/commit/8637d9debf440ce75ca6e6adfcb6514d2efdc4c4))
* netlists match KiCad's on the edge cases in its test data ([0a7eeb2](https://github.com/Crossprobe-AI/crossprobe-core/commit/0a7eeb2e42fae7ef20bc93c25788b2ca0751222a))
* silkscreen that only touches a round pad is not over it ([a8fcded](https://github.com/Crossprobe-AI/crossprobe-core/commit/a8fcdedea4427aa8d500e7e885c73baa2b0a45a7))
