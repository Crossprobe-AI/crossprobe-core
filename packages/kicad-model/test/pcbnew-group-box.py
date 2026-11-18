# Oracle for the group box test: KiCad's boxes of every group (PCB_GROUP::GetBoundingBox) and
# footprint (with its texts), in mm, one per line: "<uuid> x0 y0 x1 y1".
# usage: python3 pcbnew-group-box.py in.kicad_pcb
import sys
import pcbnew

board = pcbnew.LoadBoard(sys.argv[1])
mm = pcbnew.ToMM
def out(uuid, b):
    print(uuid, mm(b.GetLeft()), mm(b.GetTop()), mm(b.GetRight()), mm(b.GetBottom()))
for g in board.Groups():
    out(g.m_Uuid.AsString(), g.GetBoundingBox())
for f in board.GetFootprints():
    out(f.m_Uuid.AsString(), f.GetBoundingBox(True))
