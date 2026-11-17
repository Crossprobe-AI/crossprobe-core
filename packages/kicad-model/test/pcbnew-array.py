# Oracle for the array tests: copies of footprints made by KiCad's pcbnew, each
# moved and then turned about its new position as KiCad's array tool does.
# usage: python3 pcbnew-array.py in.kicad_pcb out.kicad_pcb '[{"ref":"R1","newref":"R9","dx":..,"dy":..,"rot":..}, ...]'
import json, sys
import pcbnew

src, out, copies = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
board = pcbnew.LoadBoard(src)
for c in copies:
    fp = board.FindFootprintByReference(c["ref"])
    dup = pcbnew.FOOTPRINT(fp)
    board.Add(dup)
    dup.SetReference(c["newref"])
    dup.Move(pcbnew.VECTOR2I(pcbnew.FromMM(c["dx"]), pcbnew.FromMM(c["dy"])))
    if c["rot"]:
        dup.Rotate(dup.GetPosition(), pcbnew.EDA_ANGLE(c["rot"], pcbnew.DEGREES_T))
board.Save(out)
