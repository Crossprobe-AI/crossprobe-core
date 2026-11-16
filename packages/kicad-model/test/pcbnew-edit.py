# Oracle for board-edit tests: apply footprint operations with KiCad's pcbnew.
# usage: python3 pcbnew-edit.py in.kicad_pcb out.kicad_pcb '[{"ref":"R1","op":"flip"}, ...]'
import json, sys
import pcbnew

src, out, ops = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
board = pcbnew.LoadBoard(src)
for o in ops:
    fp = board.FindFootprintByReference(o["ref"])
    if o["op"] == "rotate":
        fp.Rotate(fp.GetPosition(), pcbnew.EDA_ANGLE(o["deg"], pcbnew.DEGREES_T))
    elif o["op"] == "flip":
        fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
    elif o["op"] == "move":
        fp.Move(pcbnew.VECTOR2I(pcbnew.FromMM(o["dx"]), pcbnew.FromMM(o["dy"])))
board.Save(out)
