# Oracle for the text box tests: a board of text boxes made by KiCad's pcbnew
# (wrapping, every justification, bold, quarter-turned and rotated, mirrored on
# the back, with and without a border).
# usage: python3 pcbnew-textbox.py out.kicad_pcb
# pcbnew can crash on exit: the caller reads out.kicad_pcb and ignores the status.
import sys
import pcbnew

b = pcbnew.BOARD()
mm = pcbnew.FromMM
H = {"left": pcbnew.GR_TEXT_H_ALIGN_LEFT, "center": pcbnew.GR_TEXT_H_ALIGN_CENTER, "right": pcbnew.GR_TEXT_H_ALIGN_RIGHT}
V = {"top": pcbnew.GR_TEXT_V_ALIGN_TOP, "center": pcbnew.GR_TEXT_V_ALIGN_CENTER, "bottom": pcbnew.GR_TEXT_V_ALIGN_BOTTOM}


def box(x, y, w, h, text, layer=pcbnew.F_SilkS, hj="left", vj="top", size=1.27, width=None, thick=0, bold=False, border=True, angle=0, mirror=False, stroke=0.1):
    t = pcbnew.PCB_TEXTBOX(b)
    t.SetLayer(layer)
    t.SetStart(pcbnew.VECTOR2I(mm(x), mm(y)))
    t.SetEnd(pcbnew.VECTOR2I(mm(x + w), mm(y + h)))
    t.SetText(text)
    t.SetTextSize(pcbnew.VECTOR2I(mm(width or size), mm(size)))
    if thick:
        t.SetTextThickness(mm(thick))
    t.SetBold(bold)
    t.SetHorizJustify(H[hj])
    t.SetVertJustify(V[vj])
    t.SetBorderEnabled(border)
    t.SetWidth(mm(stroke))
    t.SetMirrored(mirror)
    b.Add(t)
    if angle:
        t.Rotate(t.GetCenter(), pcbnew.EDA_ANGLE(angle, pcbnew.DEGREES_T))
    return t


box(10, 10, 30, 14, "The quick brown fox jumps over the lazy dog, then again, and again")
box(50, 10, 30, 14, "Centred\ntwo lines", hj="center", vj="center", border=False)
box(90, 10, 20, 14, "Right bottom bold", hj="right", vj="bottom", bold=True, stroke=0.2)
box(10, 40, 30, 14, "Quarter turned box with words", angle=90)
box(50, 40, 30, 14, "Turned thirty degrees with some words", angle=30)
box(90, 40, 30, 14, "Back side, mirrored text", layer=pcbnew.B_SilkS, mirror=True)
box(10, 70, 40, 12, "Thick text in a wide box", size=2, width=1.2, thick=0.3, stroke=0.25)
box(60, 70, 20, 12, "Upside down", hj="center", angle=180)
b.Save(sys.argv[1])
