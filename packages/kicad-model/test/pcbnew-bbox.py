# Oracle for the arrange tests: KiCad's bounding boxes, the ones its
# Align/Distribute tool works with (footprints without their text).
# usage: python3 pcbnew-bbox.py in.kicad_pcb out.json
# pcbnew can crash on exit: the caller reads out.json and ignores the status.
import json, sys
import pcbnew

board = pcbnew.LoadBoard(sys.argv[1])


def box(b):
    return [b.GetLeft(), b.GetTop(), b.GetRight(), b.GetBottom()]


out = {"footprints": {}, "tracks": {}, "vias": {}, "drawings": {}, "zones": {}, "texts": {}}
for fp in board.GetFootprints():
    out["footprints"][fp.m_Uuid.AsString()] = box(fp.GetBoundingBox(False))
for t in board.GetTracks():
    key = "vias" if t.Type() == pcbnew.PCB_VIA_T else "tracks"
    out[key][t.m_Uuid.AsString()] = box(t.GetBoundingBox())
for d in board.GetDrawings():
    if d.Type() == pcbnew.PCB_SHAPE_T:
        out["drawings"][d.m_Uuid.AsString()] = box(d.GetBoundingBox())
    elif d.Type() == pcbnew.PCB_TEXT_T:
        out["texts"][d.m_Uuid.AsString()] = box(d.GetBoundingBox())
for z in board.Zones():
    out["zones"][z.m_Uuid.AsString()] = box(z.GetBoundingBox())
with open(sys.argv[2], "w") as f:
    json.dump(out, f)
