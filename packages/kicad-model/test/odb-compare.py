# Compare two ODB++ trees by what CAM tools read from them (not by formatting): the matrix's
# signal and drill layers, each copper layer's pads (positions) and line/arc/surface counts,
# drill holes (position, size, kind), component placements, each net's pins (from eda/data and
# the component files) and the profile's extent. Prints a JSON report.
import json, os, re, sys

def features(path):
    out = {'P': [], 'L': 0, 'A': 0, 'S': 0}
    syms = {}
    if not os.path.exists(path): return out, syms
    for line in open(path, encoding='latin1'):
        if line.startswith('$'):
            i, name = line[1:].split(None, 1); syms[int(i)] = name.strip()
        elif line.startswith('P '):
            p = line.split(); out['P'].append((round(float(p[1]), 2), round(float(p[2]), 2), syms.get(int(p[3]), p[3])))
        elif line[:2] in ('L ', 'A ', 'S '): out[line[0]] += 1
    return out, syms

def read(root):
    matrix = open(f'{root}/matrix/matrix').read()
    rows = [dict(re.findall(r'(\w+)=(.*)', b)) for b in re.findall(r'LAYER \{(.*?)\}', matrix, re.S)]
    signal = sorted(r['NAME'].lower() for r in rows if r.get('TYPE') == 'SIGNAL')
    drills = sorted((r['NAME'].lower(), r.get('START_NAME', '').lower(), r.get('END_NAME', '').lower()) for r in rows if r.get('TYPE') == 'DRILL')
    copper = {}
    for l in signal:
        fe, _ = features(f'{root}/steps/pcb/layers/{l}/features')
        copper[l] = {'pads': sorted((x, y) for x, y, _ in fe['P']), 'L': fe['L'], 'A': fe['A'], 'S': fe['S']}
    holes = []
    for name, _, _ in drills:
        fe, _ = features(f'{root}/steps/pcb/layers/{name}/features')
        # Slots (oval holes) are left out: KiCad's ODB++ export doesn't write them.
        holes += [(x, y, s) for x, y, s in fe['P'] if not s.startswith('oval')]
    comps, pins = {}, {}
    for side in ('top', 'bot'):
        p = f'{root}/steps/pcb/layers/comp_+_{side}/components'
        if not os.path.exists(p): continue
        cur = None; idx = -1
        for line in open(p, encoding='latin1'):
            if line.startswith('CMP '):
                t = line.split(); idx += 1
                cur = t[6]; comps[f'{side}:{cur}#{idx}'] = (round(float(t[2]), 2), round(float(t[3]), 2), round(float(t[4]) % 360, 1), t[5])
                pins[(side, idx)] = (cur, {})
            elif line.startswith('TOP '):
                t = line.split(); pins[(side, idx)][1][int(t[1])] = t[8] if len(t) > 8 else t[1]
    nets = {}
    cur = None
    for line in open(f'{root}/steps/pcb/eda/data', encoding='latin1'):
        if line.startswith('NET '):
            cur = line[4:].strip()
        elif line.startswith('SNT TOP') and cur is not None:
            t = line.split(); side = 'top' if t[2] == 'T' else 'bot'
            ref, ps = pins.get((side, int(t[3])), ('?', {}))
            nets.setdefault(cur, set()).add(f'{ref}.{ps.get(int(t[4]), t[4])}')
    xs, ys = [], []
    for line in open(f'{root}/steps/pcb/profile'):
        if line[:2] in ('OB', 'OS'):
            p = line.split(); xs.append(float(p[1])); ys.append(float(p[2]))
    box = [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)] if xs else None
    return dict(signal=signal, drills=[d[1:] for d in drills], copper=copper, holes=sorted(holes), comps=comps, nets=nets, box=box)

def unmatched(xs, ys, tol=0.011):
    """Items of xs with no item of ys within tol in x and y (and equal in the rest), one-to-one."""
    pool = sorted(ys); used = [False] * len(pool); out = []
    import bisect
    keys = [p[0] for p in pool]
    for x in sorted(xs):
        i = bisect.bisect_left(keys, x[0] - tol); hit = False
        while i < len(pool) and pool[i][0] <= x[0] + tol:
            if not used[i] and abs(pool[i][1] - x[1]) <= tol and pool[i][2:] == x[2:]:
                used[i] = True; hit = True; break
            i += 1
        if not hit: out.append(x)
    return out

a, b = read(sys.argv[1]), read(sys.argv[2])
rep = {'signal': [a['signal'], b['signal']], 'drillSpans': [sorted(set(a['drills'])), sorted(set(b['drills']))]}
rep['copper'] = {l: {'pads': [len(a['copper'].get(l, {}).get('pads', [])), len(b['copper'].get(l, {}).get('pads', []))], 'padsOnly': [unmatched(a['copper'].get(l, {}).get('pads', []), b['copper'].get(l, {}).get('pads', []))[:3], unmatched(b['copper'].get(l, {}).get('pads', []), a['copper'].get(l, {}).get('pads', []))[:3]], 'L': [a['copper'].get(l, {}).get('L'), b['copper'].get(l, {}).get('L')], 'A': [a['copper'].get(l, {}).get('A'), b['copper'].get(l, {}).get('A')], 'S': [a['copper'].get(l, {}).get('S'), b['copper'].get(l, {}).get('S')]} for l in a['signal']}
ha = [(x, y) for x, y, _ in a['holes']]; hb = [(x, y) for x, y, _ in b['holes']]
oa, ob = unmatched(a['holes'], b['holes']), unmatched(b['holes'], a['holes'])
rep['holes'] = {'count': [len(ha), len(hb)], 'nOnly': [len(oa), len(ob)], 'onlyA': oa[:3], 'onlyB': ob[:3]}
ca = {k.split('#')[0]: v for k, v in a['comps'].items()}; cb = {k.split('#')[0]: v for k, v in b['comps'].items()}
near = lambda u, v: u is not None and v is not None and abs(u[0] - v[0]) <= 0.011 and abs(u[1] - v[1]) <= 0.011 and abs((u[2] - v[2] + 180) % 360 - 180) < 0.05 and u[3] == v[3]
cd = sorted(k for k in set(ca) | set(cb) if not near(ca.get(k), cb.get(k)))
rep['components'] = {'count': [len(a['comps']), len(b['comps'])], 'differ': cd[:6], 'examples': {k: [ca.get(k), cb.get(k)] for k in cd[:3]}}
nd = sorted(n for n in set(a['nets']) | set(b['nets']) if a['nets'].get(n, set()) != b['nets'].get(n, set()))
rep['nets'] = {'count': [len(a['nets']), len(b['nets'])], 'differ': len(nd), 'examples': {n: [sorted(a['nets'].get(n, set()) - b['nets'].get(n, set()))[:3], sorted(b['nets'].get(n, set()) - a['nets'].get(n, set()))[:3]] for n in nd[:3]}}
rep['profile'] = [a['box'], b['box']]
print(json.dumps(rep, ensure_ascii=False))
