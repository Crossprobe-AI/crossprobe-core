# Compare two IPC-2581 files by what a fab's CAM reads from them (not by formatting): component
# placements, drill holes, each net's pins (pin references on its copper pads) and track length
# per layer, the profile's extent and the BOM's groups. Prints a JSON report of the differences.
import json, math, sys, xml.etree.ElementTree as ET

NS = '{http://webstds.ipc.org/2581}'

def read(path):
    r = ET.parse(path).getroot()
    step = r.find(f'.//{NS}Step')
    copper = {l.get('name') for l in r.iter(f'{NS}Layer') if l.get('layerFunction') in ('CONDUCTOR', 'PLANE', 'SIGNAL')}
    comps = {}
    for c in step.findall(f'{NS}Component'):
        loc, xf = c.find(f'{NS}Location'), c.find(f'{NS}Xform')
        rot = float(xf.get('rotation', 0)) % 360 if xf is not None else 0.0
        comps[c.get('refDes')] = (round(float(loc.get('x')), 3), round(float(loc.get('y')), 3), round(rot, 2), c.get('layerRef'))
    slots = sorted((round(float(sc.find(f'{NS}Location').get('x')), 3), round(float(sc.find(f'{NS}Location').get('y')), 3), round(float(sc.find(f'{NS}Oval').get('width')), 3), round(float(sc.find(f'{NS}Oval').get('height')), 3), round(float((sc.find(f'{NS}Xform').get('rotation') if sc.find(f'{NS}Xform') is not None else 0)) % 180, 1)) for sc in step.iter(f'{NS}SlotCavity'))
    holes = sorted((round(float(h.get('diameter')), 3), h.get('platingStatus'), round(float(h.get('x')), 3), round(float(h.get('y')), 3)) for h in step.iter(f'{NS}Hole'))
    pins, length = {}, {}
    for lf in step.findall(f'{NS}LayerFeature'):
        layer = lf.get('layerRef')
        if layer not in copper: continue
        for s in lf.findall(f'{NS}Set'):
            # Text strokes are drawing, not tracks (and split into lines however a writer likes).
            if s.get('geometryUsage') == 'TEXT': continue
            net = s.get('net', '')
            for pr in s.iter(f'{NS}PinRef'):
                pins.setdefault(net, set()).add(f"{pr.get('componentRef')}.{pr.get('pin')}")
            for ln in s.iter(f'{NS}Line'):
                L = math.hypot(float(ln.get('endX')) - float(ln.get('startX')), float(ln.get('endY')) - float(ln.get('startY')))
                length[(net, layer)] = length.get((net, layer), 0) + L
            for a in s.iter(f'{NS}Arc'):
                cx, cy = float(a.get('centerX')), float(a.get('centerY'))
                sx, sy, ex, ey = float(a.get('startX')), float(a.get('startY')), float(a.get('endX')), float(a.get('endY'))
                rad = math.hypot(sx - cx, sy - cy)
                a0, a1 = math.atan2(sy - cy, sx - cx), math.atan2(ey - cy, ex - cx)
                d = (a0 - a1) if a.get('clockwise') == 'true' else (a1 - a0)
                d %= 2 * math.pi
                if d == 0: d = 2 * math.pi
                length[(net, layer)] = length.get((net, layer), 0) + rad * d
    prof = step.find(f'{NS}Profile')
    xs, ys = [], []
    if prof is not None:
        for p in prof.iter():
            if p.get('x') is not None: xs.append(float(p.get('x'))); ys.append(float(p.get('y')))
    box = [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)] if xs else None
    bom = sorted(sorted(rd.get('name') for rd in bi.findall(f'{NS}RefDes')) for bi in r.iter(f'{NS}BomItem'))
    return dict(comps=comps, slots=slots, holes=holes, pins=pins, length=length, box=box, bom=bom)

a, b = read(sys.argv[1]), read(sys.argv[2])
rep = {}
cd = [k for k in set(a['comps']) | set(b['comps']) if a['comps'].get(k) is None or b['comps'].get(k) is None or a['comps'][k][:2] != b['comps'][k][:2] or abs((a['comps'][k][2] - b['comps'][k][2] + 180) % 360 - 180) > 0.01]
rep['components'] = {'count': [len(a['comps']), len(b['comps'])], 'differ': sorted(cd)[:8], 'examples': {k: [a['comps'].get(k), b['comps'].get(k)] for k in sorted(cd)[:3]}}
ha, hb = list(a['holes']), list(b['holes'])
onlyA = [h for h in ha if h not in hb]; onlyB = [h for h in hb if h not in ha]
rep['holes'] = {'count': [len(ha), len(hb)], 'onlyA': onlyA[:4], 'onlyB': onlyB[:4], 'nOnly': [len(onlyA), len(onlyB)]}
nets = set(a['pins']) | set(b['pins'])
pd = [n for n in nets if a['pins'].get(n, set()) != b['pins'].get(n, set())]
rep['nets'] = {'count': [len(a['pins']), len(b['pins'])], 'differ': len(pd), 'examples': {n: [sorted(a['pins'].get(n, set()) - b['pins'].get(n, set()))[:4], sorted(b['pins'].get(n, set()) - a['pins'].get(n, set()))[:4]] for n in sorted(pd)[:3]}}
keys = set(a['length']) | set(b['length'])
ld = [k for k in keys if abs(a['length'].get(k, 0) - b['length'].get(k, 0)) > 0.01]
rep['tracks'] = {'nets×layers': [len(a['length']), len(b['length'])], 'differ': len(ld), 'examples': {f'{k[0]}@{k[1]}': [round(a['length'].get(k, 0), 3), round(b['length'].get(k, 0), 3)] for k in sorted(ld)[:3]}}
rep['slots'] = {'count': [len(a['slots']), len(b['slots'])], 'same': a['slots'] == b['slots'], 'a': a['slots'][:2], 'b': b['slots'][:2]}
rep['profile'] = [a['box'], b['box']]
rep['bom'] = {'groups': [len(a['bom']), len(b['bom'])], 'same': a['bom'] == b['bom']}
print(json.dumps(rep, ensure_ascii=False))
