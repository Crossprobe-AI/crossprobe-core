# Oracle for the group tests: the board's groups as KiCad's pcbnew reads them.
# usage: python3 pcbnew-groups.py in.kicad_pcb out.json
# pcbnew can crash on exit: the caller reads out.json and ignores the status.
import json, sys
import pcbnew

board = pcbnew.LoadBoard(sys.argv[1])
out = {}
for g in board.Groups():
    out[g.m_Uuid.AsString()] = {
        "name": g.GetName(),
        "locked": bool(g.IsLocked()),
        "members": sorted(i.m_Uuid.AsString() for i in g.GetItems()),
    }
with open(sys.argv[2], "w") as f:
    json.dump(out, f)
