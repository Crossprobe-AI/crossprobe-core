# Oracle for the text box rotation test: every text box turned by an angle about
# a given point by KiCad's pcbnew.
# usage: python3 pcbnew-rotate-textboxes.py in.kicad_pcb out.kicad_pcb degrees x y
import sys
import pcbnew

b = pcbnew.LoadBoard(sys.argv[1])
c = pcbnew.VECTOR2I(pcbnew.FromMM(float(sys.argv[4])), pcbnew.FromMM(float(sys.argv[5])))
for d in b.GetDrawings():
    if d.Type() == pcbnew.PCB_TEXTBOX_T:
        d.Rotate(c, pcbnew.EDA_ANGLE(float(sys.argv[3]), pcbnew.DEGREES_T))
b.Save(sys.argv[2])
