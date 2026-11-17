# Oracle for the dimension rotation test: each dimension as KiCad's pcbnew reads it, optionally
# after pcbnew turns every dimension by an angle about a point (PCB_DIMENSION::Rotate).
# usage: python3 pcbnew-dims.py in.kicad_pcb out.json [deg cx cy]
# pcbnew can crash on exit: the caller reads out.json and ignores the status.
import json, sys
import pcbnew

board = pcbnew.LoadBoard(sys.argv[1])
dims = [d for d in board.GetDrawings() if isinstance(d, pcbnew.PCB_DIMENSION_BASE)]
if len(sys.argv) > 3:
    deg, cx, cy = float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
    for d in dims:
        d.Rotate(pcbnew.VECTOR2I(pcbnew.FromMM(cx), pcbnew.FromMM(cy)), pcbnew.EDA_ANGLE(deg, pcbnew.DEGREES_T))
out = {}
for d in dims:
    e = {
        "start": [d.GetStart().x / 1e6, d.GetStart().y / 1e6],
        "end": [d.GetEnd().x / 1e6, d.GetEnd().y / 1e6],
        "textAngle": d.GetTextAngle().AsDegrees(),
    }
    if isinstance(d, pcbnew.PCB_DIM_ALIGNED):
        e["height"] = d.GetHeight() / 1e6
    if isinstance(d, pcbnew.PCB_DIM_ORTHOGONAL):
        e["vertical"] = int(d.GetOrientation()) == 1
    out[d.m_Uuid.AsString()] = e
with open(sys.argv[2], "w") as f:
    json.dump(out, f)
