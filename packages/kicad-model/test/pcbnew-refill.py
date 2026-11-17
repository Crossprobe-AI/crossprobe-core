# Oracle for the hatched zone fill test: KiCad's pcbnew refills every zone of a board and saves it.
# usage: python3 pcbnew-refill.py in.kicad_pcb out.kicad_pcb
# pcbnew can crash on exit: the caller reads out.kicad_pcb and ignores the status.
import sys
import pcbnew

board = pcbnew.LoadBoard(sys.argv[1])
pcbnew.ZONE_FILLER(board).Fill(board.Zones())
board.Save(sys.argv[2])
