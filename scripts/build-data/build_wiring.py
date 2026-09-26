"""Rebuild data/wiring.json from the Jékely lab's published repository.

    git clone --depth 1 https://github.com/JekelyLab/Platynereis_3D_connectome_2024 plat
    python3 scripts/build-data/build_wiring.py plat data/wiring.json

Inputs (all from that repository, CC BY 4.0):
  supplements/connectome_graph.txt                      the connectome graph: cells, classes, sides, segments, edges, synapse counts
  data/neuronal_celltypes_table.csv                      cell type of each neuron (by CATMAID skeleton id)
  supplements/celltype_compendium_website/.../celltype_RGLs/*.html
                                                         the lab's 3D viewer files; each cell body is drawn as a sphere,
                                                         which gives real soma positions per cell type

Output node layout: [name, class, side, segment, typeLabel, [x,y,z]|null, roles, approxPosition]
  positions are in a body frame: x = left(-)/right(+), y = tail(-)/head(+), z = dorsoventral; head end scaled to ~1.
Soma -> cell: a viewer page lists its type's cells in ascending CATMAID skeleton id, as the CSV does. Where a page has one
  soma per skeleton id listed for its type and every node of the type is among those ids, each node gets its own soma
  (the k-th soma is the k-th id). Types whose counts differ (printed when the script runs) fall back to a side split:
  somata with x above/below the median go to left/right nodes. Untyped nodes are placed near a random placed cell of
  their segment and side (approxPosition = 1).
Requires: numpy.
"""
import sys, os, re, json, csv, math, struct, base64, random, collections, statistics as st
import numpy as np

REPO = sys.argv[1] if len(sys.argv) > 1 else 'plat'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'data/wiring.json'
RGL = os.path.join(REPO, 'supplements/celltype_compendium_website/celltype_compendium/celltype_RGLs')

# ---------- 1. soma spheres from the 3D viewer files ----------
def spheres(f):
    s = open(os.path.join(RGL, f)).read()
    m = re.search(r'<script type="application/json" data-for="[^"]+">(.*?)</script>', s, re.S)
    x = json.loads(m.group(1))['x']
    raw = base64.b64decode(x['buffer']['buffers'][0]['bytes'])
    def floats(ai):
        a = x['buffer']['accessors'][ai]; bv = x['buffer']['bufferViews'][a['bufferView']]
        n = a['count'] * {'VEC3': 3, 'SCALAR': 1, 'VEC4': 4, 'VEC2': 2}[a['type']]
        return struct.unpack_from('<%df' % n, raw, bv['byteOffset'] + a.get('byteOffset', 0))
    out = []
    for k in sorted(x['objects'], key=int):
        o = x['objects'][k]
        if o.get('type') == 'spheres' and o.get('vertices') is not None:
            v = floats(int(o['vertices']))
            out.append([list(v[i:i + 3]) for i in range(0, len(v), 3)][0])
    return out
R = {f[:-5]: spheres(f) for f in sorted(os.listdir(RGL)) if f.startswith('celltype') and f.endswith('.html')}

# ---------- 2. the connectome graph ----------
s = open(os.path.join(REPO, 'supplements/connectome_graph.txt')).read()
def vec(name):
    i = s.find(name + ' = c('); j = i + len(name + ' = c('); depth = 1; k = j
    while depth:
        if s[k] == '(': depth += 1
        elif s[k] == ')': depth -= 1
        k += 1
    return [a if a else b for a, b in re.findall(r'"((?:[^"\\]|\\.)*)"|([-0-9.eE+]+|NA|TRUE|FALSE)', s[j:k - 1])]
G = {n: vec(n) for n in ['skids', 'celltype_annotation', 'class', 'segment', 'side']}
i0 = s.find('names = c('); j0 = s.find('celltype_annotation = c(')
nmap = dict(re.findall(r'`(\d+)` = "((?:[^"\\]|\\.)*)"', s[i0:j0]))
nodes = [dict(skid=G['skids'][i], name=nmap.get(G['skids'][i]), ct=G['celltype_annotation'][i], cls=G['class'][i],
              seg=G['segment'][i], side=G['side'][i]) for i in range(len(G['skids']))]
fr = [int(x) - 1 for x in vec('from')]; to = [int(x) - 1 for x in vec('to')]; w = [int(float(x)) for x in vec('weight')]

# ---------- 3. cell types for neurons ----------
ctname, ctskids, last = {}, {}, None
for r in csv.DictReader(open(os.path.join(REPO, 'data/neuronal_celltypes_table.csv'))):
    ann = (r.get('CATMAID annotation') or '').strip(); ctname[ann] = r['name of cell type']
    if r.get('CATMAID annotation') is None and last and re.fullmatch(r'[\d\s]+', r['name of cell type'] or ''):
        ctskids[last] += r['name of cell type'].split()   # a skid list the file breaks across lines (used for somata only)
    else:
        last = ann; ctskids[ann] = (r.get('CATMAID skids') or '').split()
    for sk in (r.get('CATMAID skids') or '').split():
        for n in nodes:
            if n['skid'] == sk: n['ct'] = ann

# ---------- 4. positions ----------
random.seed(7)
allc = [c for v in R.values() for c in v]
MID = st.median(c[0] for c in allc)
pos = {}
bytype = collections.defaultdict(list)
for i, n in enumerate(nodes): bytype[n['ct']].append(i)
own, claimed, fallback = {}, set(), {}            # each node's own soma; somata known to belong to a particular cell
for ct, sp in R.items():
    idx = bytype.get(ct, [])
    ids = sorted(ctskids.get(ct, []), key=int)
    if len(ids) == len(sp) and all(nodes[i]['skid'] in ids for i in idx):
        k = {s: j for j, s in enumerate(ids)}
        own.update({i: sp[k[nodes[i]['skid']]] for i in idx}); claimed.update(tuple(c) for c in sp)
for ct, idx in bytype.items():
    if ct not in R or ct == 'not_celltype': continue
    sp = [c for c in R[ct] if tuple(c) not in claimed]
    if any(i not in own for i in idx): fallback[ct] = len(idx)
    hi = sorted([c for c in sp if c[0] >= MID], key=lambda c: (c[2], c[1]))
    lo = sorted([c for c in sp if c[0] < MID], key=lambda c: (c[2], c[1]))
    pools = {'left_side': hi, 'right_side': lo}      # which x-half is "left" only mirrors the picture
    rest = []
    for i in sorted(idx, key=lambda i: nodes[i]['name'] or ''):
        if i in own: pos[i] = own[i]; continue
        p = pools.get(nodes[i]['side'])
        if p: pos[i] = p.pop(0)
        else: rest.append(i)
    left = sorted(hi + lo, key=lambda c: abs(c[0] - MID))
    for i in rest:
        if left: pos[i] = left.pop(0)
pool = collections.defaultdict(list)
for i, p in pos.items(): pool[(nodes[i]['seg'], nodes[i]['side'])].append(p)
approx = set()
for i, n in enumerate(nodes):
    if i in pos or n['cls'] == 'fragmentum': continue
    pl = pool.get((n['seg'], n['side'])) or pool.get((n['seg'], 'left_side'))
    if not pl: continue
    b = random.choice(pl)
    pos[i] = [b[0] + random.uniform(-2500, 2500), b[1] + random.uniform(-2500, 2500), b[2] + random.uniform(-2500, 2500)]
    approx.add(i)

P = np.array(list(pos.values()), dtype=float); mu = P.mean(0)
ev, evec = np.linalg.eigh(np.cov((P - mu).T)); ap = evec[:, np.argmax(ev)]
head = np.array([pos[i] for i, n in enumerate(nodes) if n['seg'] == 'episphere' and i in pos]).mean(0)
if np.dot(head - mu, ap) < 0: ap = -ap
lr = np.array([1.0, 0, 0]); lr = lr - np.dot(lr, ap) * ap; lr /= np.linalg.norm(lr)
lefts = np.array([pos[i] for i, n in enumerate(nodes) if n['side'] == 'left_side' and i in pos]).mean(0)
if np.dot(lefts - mu, lr) > 0: lr = -lr
dv = np.cross(ap, lr); scale = np.abs((P - mu) @ ap).max()
def tf(p):
    q = np.array(p) - mu
    return [round(float(q @ lr / scale), 4), round(float(q @ ap / scale), 4), round(float(q @ dv / scale), 4)]

# ---------- 5. roles and output ----------
CLS = {'Sensory neuron': 0, 'interneuron': 1, 'motorneuron': 2, 'effector': 3, 'other': 4, 'fragmentum': 5}
SIDE = {'left_side': 0, 'right_side': 1}
SEGS = ['episphere', 'segment_0', 'segment_1', 'segment_2', 'segment_3', 'pygidium', 'fragment']
def roles(n):
    nm = n['name'] or ''; r = 0
    if n['cls'] == 'Sensory neuron':
        if nm.startswith('PRC') or nm.startswith('eyespot-PRC'): r |= 1      # eye photoreceptors
        if nm.startswith('cPRC'): r |= 2                                     # ciliary (non-directional) photoreceptors
        if re.search(r'CR|chaeMech', nm) and not r & 1: r |= 4              # collar receptors, chaeta mechanosensors (not eyespot-PRCR*)
    if n['cls'] == 'effector':
        if nm.startswith('MUSlong'): r |= 8 if n['side'] == 'left_side' else (16 if n['side'] == 'right_side' else 0)
        if re.match(r'MUS(chae|ac|ob)', nm): r |= 32                         # chaetal, acicular, oblique muscles
        if re.match(r'(prototroch|paratroch|metatroch|akrotroch)', nm): r |= 64  # ciliated swimming cells
    return r
def label(n):
    nm = n['name'] or ''
    if n['ct'] in ctname: return ctname[n['ct']]
    return re.split(r'[_ ;]', nm)[0] if nm else ''
out = {'n': [], 'e': [], 'segs': SEGS}
for i, n in enumerate(nodes):
    out['n'].append([n['name'] or '', CLS[n['cls']], SIDE.get(n['side'], 2), SEGS.index(n['seg']) if n['seg'] in SEGS else 6,
                     label(n), tf(pos[i]) if i in pos else None, roles(n), 1 if i in approx else 0])
agg = collections.Counter()
for a, b, c in zip(fr, to, w): agg[(a, b)] += c
for (a, b), c in agg.items(): out['e'] += [a, b, c]
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
print(f'{len(nodes)} cells, {len(agg)} connections, {sum(agg.values())} synapses, '
      f'{len(pos) - len(approx)} at published positions, {len(approx)} approximate -> {OUT}')
print(f'{len(own)} at their own soma; placed by side, for types whose page and skid counts differ: '
      + ', '.join(f'{ct} ({k} nodes)' for ct, k in sorted(fallback.items())))
