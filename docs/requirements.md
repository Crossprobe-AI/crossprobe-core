# Requirements verification

The engineer's requirements are stored as structured data next to the KiCad
project (`<project>.crossprobe-requirements.json`; KiCad files stay untouched)
and checked by rules, not by the model. Each result is `pass`, `fail` or
`unknown` (the rule could not decide, for example no board file), with the
numbers it used. Nothing falls back to a guess.

```json
{ "version": 1, "requirements": [
  { "id": "size",  "title": "Fits the enclosure", "kind": "board_size", "maxWidthMm": 50, "maxHeightMm": 40 },
  { "id": "usb",   "title": "USB data on J1", "kind": "connector_nets", "reference": "J1", "nets": ["USB_D+", "USB_D-"] },
  { "id": "5v",    "title": "5 V budget", "kind": "power_budget", "net": "+5V", "supplyMa": 500,
    "loads": [{ "reference": "U1", "maxMa": 300 }] }
] }
```

Kinds: `board_size`, `board_layers`, `net_present`, `connector_nets`,
`part_count`, `power_budget`, `min_track_width`. Malformed entries and
duplicate ids are dropped when the file is read.

`part_count` counts the parts that are not DNP, by `prefix` (the reference's
letters: `"D"` counts D1 and D12, not DS1) and/or `match`, a case-insensitive
regular expression tried on each part's reference, value, footprint, symbol and
symbol description one at a time (so `^10k$` is a value of exactly 10k). With
both, a part must meet both. `{ "prefix": "D", "match": "LED", "min": 1 }`
counts the LEDs.

The Requirements tab shows these results. Power-budget currents are
the engineer's numbers, not read from datasheets (yet).

Code: `apps/web/src/requirements/requirements.ts`; tests: `apps/web/test/requirements.test.ts`.

The Review tab has a Requirements section: live results and an add/remove editor. Next: checks backed by pinned datasheet
ratings (supply range vs. operating conditions).
