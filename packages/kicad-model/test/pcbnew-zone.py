# Oracle for the zone property tests: each zone's properties as KiCad's pcbnew reads them.
# usage: python3 pcbnew-zone.py in.kicad_pcb out.json
# pcbnew can crash on exit: the caller reads out.json and ignores the status.
import json, sys
import pcbnew

board = pcbnew.LoadBoard(sys.argv[1])
out = {}
for z in board.Zones():
    lc = z.GetLocalClearance()
    out[z.m_Uuid.AsString()] = {
        "name": z.GetZoneName(),
        "priority": z.GetAssignedPriority(),
        "clearance": (lc.value() if hasattr(lc, "value") else lc) / 1e6 if lc is not None else None,
        "minThickness": z.GetMinThickness() / 1e6,
        "thermalGap": z.GetThermalReliefGap() / 1e6,
        "thermalWidth": z.GetThermalReliefSpokeWidth() / 1e6,
        "islandMode": int(z.GetIslandRemovalMode()),
        "islandAreaMin": z.GetMinIslandArea() / 1e12,
        "connect": int(z.GetPadConnection()),
    }
with open(sys.argv[2], "w") as f:
    json.dump(out, f)
