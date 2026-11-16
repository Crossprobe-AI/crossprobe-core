# KiCad's own routed length (tracks + vias through the stackup) per net, from pcbnew's
# BOARD.GetTrackLength: it runs KiCad's length calculation (the Net Inspector's, with its path
# optimisations) over the copper connected to a track. SWIG hands the C++ tuple back as an opaque
# pointer, so its fields are read with ctypes (libc++ lays tuple<int, double x4> out in order).
# Writes {net: [length of each connected cluster]} to the file named second (a cluster is told
# apart by its item count and length: every track of it reports the same).
import ctypes, json, sys
import pcbnew

board = pcbnew.LoadBoard(sys.argv[1])
clusters = {}
for t in board.GetTracks():
    if t.GetClass() == "PCB_VIA" or not t.GetNetname():
        continue
    r = int(board.GetTrackLength(t))
    count = ctypes.c_int.from_address(r).value
    length = ctypes.c_double.from_address(r + 8).value / 1e6
    clusters.setdefault(t.GetNetname(), {})[(count, round(length, 6))] = length
open(sys.argv[2], "w").write(json.dumps({net: list(c.values()) for net, c in clusters.items()}))
