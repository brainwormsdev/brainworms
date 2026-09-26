"""Build data/morph.bin: the larva's real 3D anatomy, in the same body frame as data/wiring.json.

    git clone --depth 1 https://github.com/JekelyLab/Platynereis_3D_connectome_2024 plat
    python3 scripts/build-data/build_morph.py plat data/morph.bin [data/wiring.json]

Run from the project root (numpy required, under a minute). It first re-runs build_wiring.py on the same repository
into a temporary file and stops unless the result is byte-identical to data/wiring.json, so the body-frame transform
and the soma -> node mapping used here are exactly those of the committed wiring (the header records wiring.json's
sha1; rebuild morph.bin whenever wiring.json changes). The output is byte-identical with numpy 1.26 and 2.x.

Inputs (from that repository, CC BY 4.0):
  supplements/celltype_compendium_website/celltype_compendium/celltype_RGLs/celltype*.html
      the lab's rgl 3D viewer pages (the files build_wiring.py reads), coordinates in nm. Every page draws
        - each cell of its cell type: the CATMAID skeleton, smoothed by the lab (nat::smooth_neuron, sigma 6000 nm),
          as a linestrip whose NaN rows separate segments, immediately followed by the soma sphere (with radius)
        - the yolk (CATMAID volume 4; triangles, alpha 0.06)                               -> the yolk mesh
        - the 12 aciculae in grey (identical to the cells of type celltype_non_neuronal23) -> kept once, as those cells
        - 23 white "bounding_dots" that only fix the camera box                            -> ignored
      (see supplements/generate_RGL_files_for_celltype_compendium_website.R in the repository)
  supplements/connectome_graph.txt, data/neuronal_celltypes_table.csv (through build_wiring.py; type names)

What is stored
  cells    every distinct traced skeleton in the pages (neurons, muscles, ciliated, gland, epidermal and pigment cells,
           chaetae, aciculae, ...). A cell is matched when build_wiring.py put a wiring node exactly on its soma (every
           node with approxPosition = 0); its strips carry that node index, all other strips carry 0xFFFF. A skeleton
           that build_wiring.py gave to two nodes (one cell annotated with two cell types) is stored once per node.
           A page lists its somata in ascending CATMAID skeleton id; where build_wiring.py's own-soma rule holds for the
           page (as many somata as ids listed for its type, every node of the type among them) its cells get their id,
           and the build stops if a matched node's skeleton has an id other than the node's own. Skeletons
           are split into paths (root path first, following the larger subtree at each branch), terminal twigs shorter
           than PRUNE_UNITS are dropped (one pass), and every path is simplified with Ramer-Douglas-Peucker (RDP_UNITS)
           in body units. A cell's first strip starts at its soma centre.
  outline  DERIVED, not published (the pages contain no body-surface mesh): a closed envelope of all traced skeleton
           points plus the yolk surface: voxelise (VOXEL_UM), morphological closing (CLOSE_UM), hole fill, grow
           (GROW_UM), Gaussian blur (BLUR_UM), naive surface nets at 0.5, Taubin smoothing.
  yolk     the published yolk mesh, vertices de-duplicated, area-weighted vertex normals.

Binary layout (all little-endian)
  0      8 bytes  ASCII magic "BWMORPH1"
  8      uint32   H = byte length of the header JSON, including trailing space padding
  12     H bytes  header JSON (UTF-8); 12 + H is a multiple of 8
  12+H   sections, in this order, each at the absolute offset header.sections[name].offset (8-byte aligned, zero
         padding between them); header.sections[name] = {offset, byteLength, type, components, count}
           points            int16  x3  skeleton points, quantised (see below)
           stripStart        uint32     first point of each strip; strips are contiguous: start[k+1] = start[k] + length[k]
           stripLength       uint16     points in the strip (>= 2)
           stripCell         uint16     wiring.json node index (index into wiring.n) of the strip's cell, or 65535
           cellNode          uint16     per cell: wiring.json node index, or 65535 (header.noCell)
           cellType          uint16     per cell: index into header.types = [[page annotation, type name|null], ...]
           cellFirstStrip    uint32     per cell: its first strip (a cell's strips are consecutive)
           cellStripCount    uint16     per cell: number of strips
           cellSomaRadius    uint16     per cell: soma radius in nm as drawn by the lab (0 = none drawn); / frame.scaleNm -> units
           cellSoma          int16  x3  per cell: soma centre (= first point of its first strip), quantised
           cellSkid          uint32     per cell: CATMAID skeleton id where its page identifies it, else 0
           nodeSkid          uint32     per wiring.json node (wiring.n order): CATMAID skeleton id from the connectome graph
           outlinePositions  int16  x3
           outlineNormals    int8   x3  n = q / 127, outward
           outlineIndices    uint16 x3  triangles, counter-clockwise seen from outside (type uint32 if the header says so)
           yolkPositions     int16  x3
           yolkNormals       int8   x3
           yolkIndices       uint16 x3
  int16 positions: v[a] = header.quant.offset[a] + q[a] * header.quant.step[a], a = x, y, z.
  Cells are ordered: matched cells by node index, then the others by type (page order), in page order.
  Body frame (as data/wiring.json): x = left(-)/right(+), y = tail(-)/head(+), z = dorsal(-)/ventral(+),
  p = ((p_nm - mu) . lr, (p_nm - mu) . ap, (p_nm - mu) . dv) / scaleNm. (lr, ap, dv) is a left-handed triple.
"""
import sys, os, re, json, base64, hashlib, runpy, tempfile, contextlib, io, collections
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = sys.argv[1] if len(sys.argv) > 1 else 'plat'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'data/morph.bin'
WIRING = sys.argv[3] if len(sys.argv) > 3 else 'data/wiring.json'
RGL = os.path.join(REPO, 'supplements/celltype_compendium_website/celltype_compendium/celltype_RGLs')

PRUNE_UNITS = 0.01       # terminal twigs shorter than this are dropped (~1.1 um)
RDP_UNITS = 0.0025       # Ramer-Douglas-Peucker tolerance (~0.28 um)
VOXEL_UM, CLOSE_UM, GROW_UM, BLUR_UM, TAUBIN_ITERS, YOLK_SAMPLE_UM = 3.0, 9.0, 1.5, 3.0, 10, 1.0
NOCELL = 0xFFFF

# ---------- 1. rebuild the wiring: transform and the soma of every positioned node ----------
bw = os.path.join(HERE, 'build_wiring.py')
tmp = tempfile.NamedTemporaryFile(suffix='.json', delete=False); tmp.close()
argv, sys.argv = sys.argv, [bw, REPO, tmp.name]
try:
    with contextlib.redirect_stdout(io.StringIO()):
        g = runpy.run_path(bw, run_name='__main__')
finally:
    sys.argv = argv
rebuilt = open(tmp.name, 'rb').read(); os.unlink(tmp.name)
wiring_bytes = open(WIRING, 'rb').read()
if rebuilt != wiring_bytes:
    sys.exit(f'{WIRING} is not what build_wiring.py makes from {REPO}: rebuild it first (node order and positions must match).')
W = json.loads(wiring_bytes)
mu, lr, ap, dv, scale = g['mu'], g['lr'], g['ap'], g['dv'], float(g['scale'])
nodes, pos, approx, tf, ctname = g['nodes'], g['pos'], g['approx'], g['tf'], g['ctname']
UM = 1000.0 / scale                                   # body units per micrometre
def body(P):                                          # build_wiring's tf() without the rounding
    q = np.asarray(P, np.float64) - mu
    return np.stack([q @ lr, q @ ap, q @ dv], -1) / scale

# ---------- 2. the 3D viewer pages ----------
CT = {5126: '<f4', 5121: 'u1', 5123: '<u2', 5125: '<u4'}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
def page_objects(s):
    m = re.search(r'<script type="application/json" data-for="[^"]+">(.*?)</script>', s, re.S)
    x = json.loads(m.group(1))['x']
    raw = base64.b64decode(x['buffer']['buffers'][0]['bytes'])
    acc, bvs = x['buffer']['accessors'], x['buffer']['bufferViews']
    def arr(ref):
        if isinstance(ref, list): return np.array(ref, np.float32).reshape(-1, 3)
        a = acc[int(ref)]; bv = bvs[a['bufferView']]; nc = NC[a['type']]
        return np.frombuffer(raw, CT[a['componentType']], a['count'] * nc, bv['byteOffset'] + a.get('byteOffset', 0)).reshape(-1, nc)
    out = []
    for k in sorted(x['objects'], key=int):
        o = x['objects'][k]
        if o.get('type') in ('linestrip', 'spheres', 'triangles') and o.get('vertices') is not None:
            out.append(dict(type=o['type'], v=arr(o['vertices']), lwd=(o.get('material') or {}).get('lwd'),
                            radius=float(np.ravel(o['radii'])[0]) if o.get('radii') is not None else None))
    return out
def page_key(p):
    m = re.match(r'celltype(_non_neuronal)?(\d+)$', p)
    return (1 if m.group(1) else 0, int(m.group(2)))
pages = sorted((f[:-5] for f in os.listdir(RGL) if re.match(r'celltype(_non_neuronal)?\d+\.html$', f)), key=page_key)
cells, cell_of, yolk, scaffold, rgl_hash, page_somata = [], {}, None, None, hashlib.sha1(), {}
n_pairs = n_nosoma = 0
for p in pages:
    data = open(os.path.join(RGL, p + '.html'), 'rb').read(); rgl_hash.update(data)
    objs = page_objects(data.decode('utf-8'))
    tri = [o['v'] for o in objs if o['type'] == 'triangles']
    grey = [hashlib.sha1(o['v'].tobytes()).digest() for o in objs if o['type'] == 'linestrip' and o['lwd'] == 2]
    if len(tri) != 1: sys.exit(f'{p}: expected one yolk mesh, found {len(tri)}')
    if yolk is None: yolk, scaffold = tri[0], grey
    elif tri[0].tobytes() != yolk.tobytes() or grey != scaffold: sys.exit(f'{p}: background differs from the other pages')
    k_in_page = 0; page_somata[p] = []
    for i, o in enumerate(objs):
        if o['type'] == 'spheres' and not (i and objs[i - 1]['type'] == 'linestrip' and objs[i - 1]['lwd'] == 3):
            sys.exit(f'{p}: soma sphere without a skeleton before it')
        if o['type'] != 'linestrip' or o['lwd'] != 3: continue      # lwd 3 = cells, 2 = aciculae, none = bounding dots
        sph = objs[i + 1] if i + 1 < len(objs) and objs[i + 1]['type'] == 'spheres' else None
        v = o['v']; first = v[~np.isnan(v).any(1)][0]
        if sph is not None:
            if len(sph['v']) != 1 or not np.array_equal(sph['v'][0], first): sys.exit(f'{p}: soma is not the skeleton root')
            n_pairs += 1
        else:
            n_nosoma += 1
        key = hashlib.sha1(v.tobytes()).digest()
        if key not in cell_of:
            cell_of[key] = len(cells)
            cells.append(dict(v=v, pages=[], order=k_in_page, radius=sph['radius'] if sph else 0.0, skid=0,
                              centre=tuple(float(a) for a in first) if sph else None))
            k_in_page += 1
        cells[cell_of[key]]['pages'].append(p)
        if sph: page_somata[p].append(cell_of[key])
acicula_pages = sorted({cells[cell_of[h]]['pages'][0] for h in scaffold if h in cell_of})
# skeleton ids: a page lists its somata in ascending CATMAID skeleton id. Where its soma count equals the number of ids
# listed for its type and every node of the type is among them (build_wiring.py's own-soma rule), soma k is id k.
ctskids = g.get('ctskids', {})
type_skids = collections.defaultdict(list)
for n in nodes: type_skids[n['ct']].append(n['skid'])
id_pages = 0
for p in pages:
    ids = sorted(ctskids.get(p, []), key=int)
    if len(ids) != len(page_somata[p]) or not all(s in ids for s in type_skids[p]): continue
    id_pages += 1
    for ci, s in zip(page_somata[p], ids):
        if cells[ci]['skid'] not in (0, int(s)): sys.exit(f'{p}: a skeleton gets two ids')
        cells[ci]['skid'] = int(s)

# ---------- 3. match skeletons to wiring nodes (build_wiring put each positioned node on one soma) ----------
by_centre = collections.defaultdict(list)
for ci, c in enumerate(cells):
    if c['centre'] is not None: by_centre[c['centre']].append(ci)
shared = []                                           # skeletons annotated with two types can carry two nodes
for i in sorted(pos):
    if i in approx: continue
    hits = by_centre.get(tuple(float(a) for a in pos[i]), [])
    if len(hits) != 1: sys.exit(f'node {i} ({nodes[i]["name"]}): {len(hits)} skeletons at its soma')
    c = cells[hits[0]]
    if nodes[i]['ct'] not in c['pages']: sys.exit(f'node {i}: its skeleton is not in its cell type page')
    if W['n'][i][5] != tf(pos[i]) or W['n'][i][7] != 0: sys.exit(f'node {i}: position differs from {WIRING}')
    if 'node' in c:
        shared.append((c['node'], i)); c = dict(c); cells.append(c)
    c['node'], c['type'] = i, nodes[i]['ct']
for c in cells:
    c.setdefault('node', NOCELL); c.setdefault('type', c['pages'][0])
if any(c['node'] != NOCELL and c['skid'] and c['skid'] != int(nodes[c['node']]['skid']) for c in cells):
    sys.exit("a wiring node sits on another cell's identified soma")
own_soma = sum(1 for c in cells if c['node'] != NOCELL and c['skid'])
cells.sort(key=lambda c: (0, c['node']) if c['node'] != NOCELL else (1,) + page_key(c['type']) + (c['order'],))
labels = collections.defaultdict(collections.Counter)
for n in nodes: labels[n['ct']][g['label'](n)] += 1
types = [[p, ctname.get(p) or (labels[p].most_common(1)[0][0] if labels[p] else None)] for p in pages]
type_index = {p: k for k, (p, _) in enumerate(types)}

# ---------- 4. skeletons -> simplified strips ----------
def pieces_of(v):
    v = np.asarray(v, np.float64)
    parts = np.split(v, np.nonzero(np.isnan(v).any(1))[0])
    return [q for q in (s[~np.isnan(s).any(1)] for s in parts) if len(q)]
def paths_of(pieces, prune):
    """nat segments -> paths. A segment starts at the root or at the end (a branch point) of an earlier segment."""
    n = len(pieces)
    L = np.array([np.linalg.norm(np.diff(q, axis=0), axis=1).sum() for q in pieces])
    end_of = {}
    for i, q in enumerate(pieces): end_of.setdefault(tuple(q[-1]), i)
    root = tuple(pieces[0][0]); parent = [-1] * n; kids = [[] for _ in range(n)]; roots = []
    for i, q in enumerate(pieces):
        j = end_of.get(tuple(q[0]))
        if j is not None and j < i: parent[i] = j; kids[j].append(i)
        else: roots.append(i)
    alive = [bool(kids[i]) or L[i] >= prune or parent[i] == -1 for i in range(n)]
    kids = [[c for c in kids[i] if alive[c]] for i in range(n)]
    sub = L.copy()
    for i in range(n - 1, -1, -1):
        if parent[i] != -1 and alive[i]: sub[parent[i]] += sub[i]
    todo = sorted(roots, key=lambda r: (tuple(pieces[r][0]) != root, -sub[r]))
    out = []
    while todo:
        s = todo.pop(0); chain = [pieces[s]]
        while kids[s]:
            ks = sorted(kids[s], key=lambda c: -sub[c]); todo.extend(ks[1:]); s = ks[0]
            chain.append(pieces[s][1:])
        out.append(np.concatenate(chain))
    return out
def rdp(P, eps):
    n = len(P); keep = np.zeros(n, bool); keep[0] = keep[-1] = True; stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2: continue
        seg = P[b] - P[a]; L2 = seg @ seg; Q = P[a + 1:b] - P[a]
        R = Q if L2 == 0 else Q - np.clip(Q @ seg / L2, 0, 1)[:, None] * seg
        d2 = np.einsum('ij,ij->i', R, R); k = int(np.argmax(d2))
        if d2[k] > eps * eps: m = a + 1 + k; keep[m] = True; stack += [(a, m), (m, b)]
    return P[keep]
pts, s_start, s_len, s_cell, c_first, c_count = [], [], [], [], [], []
raw_points = raw_segments = npts = 0
for c in cells:
    pieces = pieces_of(c['v']); raw_points += sum(len(q) for q in pieces); raw_segments += len(pieces)
    c_first.append(len(s_start))
    for path in paths_of(pieces, PRUNE_UNITS * scale):
        q = rdp(body(path), RDP_UNITS)
        if len(q) < 2 or len(q) > 0xFFFF: sys.exit(f'bad strip length {len(q)}')
        pts.append(q); s_start.append(npts); s_len.append(len(q)); s_cell.append(c['node']); npts += len(q)
    c_count.append(len(s_start) - c_first[-1])
P = np.concatenate(pts)
soma = np.array([body(c['centre']) if c['centre'] else P[s_start[c_first[k]]] for k, c in enumerate(cells)])
unique_v = list({id(c['v']): c['v'] for c in cells}.values())
all_raw = body(np.concatenate([v[~np.isnan(v).any(1)] for v in unique_v]))

# ---------- 5. meshes ----------
def normals(V, F):
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]); N = np.zeros_like(V)
    for k in range(3): np.add.at(N, F[:, k], fn)
    return N / np.maximum(np.linalg.norm(N, axis=1), 1e-12)[:, None]
def mesh_check(V, F):
    e = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), 1)
    ue, cnt = np.unique(e, axis=0, return_counts=True)
    vol = np.einsum('ij,ij->i', V[F[:, 0]], np.cross(V[F[:, 1]], V[F[:, 2]])).sum() / 6
    return dict(edgesUsedTwice=int((cnt == 2).sum()), edgesOther=int((cnt != 2).sum()), boundaryEdges=int((cnt == 1).sum()),
                euler=int(len(V) - len(ue) + len(F)), volumeUm3=round(float(vol / UM ** 3)))
yolkV, inv = np.unique(body(yolk.astype(np.float64)), axis=0, return_inverse=True)
yolkF = inv.reshape(-1, 3)
if mesh_check(yolkV, yolkF)['volumeUm3'] < 0: yolkF = yolkF[:, ::-1]

def conv(a, k):                                       # circular FFT convolution with a small centred kernel
    K = np.zeros(a.shape); K[:k.shape[0], :k.shape[1], :k.shape[2]] = k
    K = np.roll(K, [-(s // 2) for s in k.shape], axis=(0, 1, 2))
    return np.fft.irfftn(np.fft.rfftn(a) * np.fft.rfftn(K), s=a.shape, axes=(0, 1, 2))
def ball(r):
    n = int(np.ceil(r)); X, Y, Z = np.meshgrid(*[np.arange(-n, n + 1)] * 3, indexing='ij')
    return (X * X + Y * Y + Z * Z <= r * r + 1e-9).astype(float)
def gauss(s):
    x = np.arange(-int(np.ceil(3 * s)), int(np.ceil(3 * s)) + 1); k = np.exp(-x * x / (2 * s * s)); k /= k.sum()
    return k[:, None, None] * k[None, :, None] * k[None, None, :]
def outside_of(solid):                                # flood fill from the grid border
    out = np.zeros_like(solid); out[[0, -1]] = True; out[:, [0, -1]] = True; out[:, :, [0, -1]] = True; out &= ~solid
    while True:
        n = out.copy(); n[1:] |= out[:-1]; n[:-1] |= out[1:]; n[:, 1:] |= out[:, :-1]; n[:, :-1] |= out[:, 1:]
        n[:, :, 1:] |= out[:, :, :-1]; n[:, :, :-1] |= out[:, :, 1:]; n &= ~solid
        if n.sum() == out.sum(): return out
        out = n
def unambiguous(F, iso):                              # fill grid faces with diagonal inside corners -> 2-manifold nets
    F = F.copy()
    while True:
        ins = F > iso; fix = np.zeros_like(ins)
        for a, b in ((0, 1), (1, 2), (0, 2)):
            def at(da, db):
                t = [slice(None)] * 3; t[a] = slice(da, ins.shape[a] - 1 + da); t[b] = slice(db, ins.shape[b] - 1 + db)
                return tuple(t)
            amb = (ins[at(0, 0)] == ins[at(1, 1)]) & (ins[at(1, 0)] == ins[at(0, 1)]) & (ins[at(0, 0)] != ins[at(1, 0)])
            for d in ((0, 0), (1, 1), (1, 0), (0, 1)): fix[at(*d)] |= amb & ~ins[at(*d)]
        if not fix.any(): return F
        F[fix] = iso + 1e-3
def surface_nets(F, iso, origin, h):
    ins = F > iso; nx, ny, nz = F.shape
    corners = [(i, j, k) for k in (0, 1) for j in (0, 1) for i in (0, 1)]
    C = np.stack([F[i:nx - 1 + i, j:ny - 1 + j, k:nz - 1 + k] for i, j, k in corners], -1)
    acc = np.zeros(C.shape[:3] + (3,)); cnt = np.zeros(C.shape[:3])
    for a in range(8):
        for b in range(a + 1, 8):
            if sum(abs(np.subtract(corners[a], corners[b]))) != 1: continue
            va, vb = C[..., a], C[..., b]; m = (va > iso) != (vb > iso)
            t = np.where(m, (iso - va) / np.where(m, vb - va, 1), 0)
            pa, pb = np.array(corners[a], float), np.array(corners[b], float)
            acc += m[..., None] * (pa + t[..., None] * (pb - pa)); cnt += m
    vid = -np.ones(C.shape[:3], np.int64); idx = np.nonzero(cnt > 0); vid[idx] = np.arange(len(idx[0]))
    V = origin + h * (np.stack(idx, 1) + acc[idx] / cnt[idx][:, None]); faces = []
    for a in range(3):                                # one quad per grid edge that crosses the surface
        b, c = (a + 1) % 3, (a + 2) % 3
        lo, hi = [slice(None)] * 3, [slice(None)] * 3; lo[a] = slice(0, -1); hi[a] = slice(1, None)
        s0 = ins[tuple(lo)]; E = np.argwhere(s0 != ins[tuple(hi)])
        def cube(db, dc):
            q = E.copy(); q[:, b] += db; q[:, c] += dc; return vid[q[:, 0], q[:, 1], q[:, 2]]
        quad = np.stack([cube(-1, -1), cube(0, -1), cube(0, 0), cube(-1, 0)], 1)
        flip = ~s0[tuple(E.T)]; quad[flip] = quad[flip][:, ::-1]
        faces += [quad[:, [0, 1, 2]], quad[:, [0, 2, 3]]]
    return V, np.concatenate(faces)
def taubin(V, F, iters, lam=0.5, mu_=-0.53):
    E = np.unique(np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), 1), axis=0)
    deg = np.bincount(E.ravel(), minlength=len(V)).astype(float)[:, None]
    for _ in range(iters):
        for f in (lam, mu_):
            S = np.zeros_like(V); np.add.at(S, E[:, 0], V[E[:, 1]]); np.add.at(S, E[:, 1], V[E[:, 0]])
            V = V + f * (S / deg - V)
    return V
def sample_triangles(V, F, spacing):
    out = []
    for t in V[F]:
        n = max(1, int(np.ceil(max(np.linalg.norm(t[1] - t[0]), np.linalg.norm(t[2] - t[0]), np.linalg.norm(t[2] - t[1])) / spacing)))
        i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing='ij'); m = i + j <= n
        out.append(t[0] + (i[m] / n)[:, None] * (t[1] - t[0]) + (j[m] / n)[:, None] * (t[2] - t[0]))
    return np.concatenate(out)
h = VOXEL_UM * UM
cloud = np.concatenate([all_raw, sample_triangles(yolkV, yolkF, YOLK_SAMPLE_UM * UM)])
pad = (CLOSE_UM + GROW_UM + 4 * BLUR_UM) * UM + 3.25 * h     # not a whole number of half voxels: no rounding ties
lo = cloud.min(0) - pad
grid = np.zeros(tuple(np.ceil((cloud.max(0) + pad - lo) / h).astype(int) + 1))
ii = np.round((cloud - lo) / h).astype(int); grid[ii[:, 0], ii[:, 1], ii[:, 2]] = 1
B = ball(CLOSE_UM * UM / h)
filled = ~outside_of(conv(grid, B) > 0.5)                              # dilate, fill
solid = conv(filled.astype(float), B) > B.sum() - 0.5                  # erode (closing)
solid = conv(solid.astype(float), ball(GROW_UM * UM / h)) > 0.5         # grow
field = unambiguous(conv(solid.astype(float), gauss(BLUR_UM * UM / h)), 0.5)
outV, outF = surface_nets(field, 0.5, lo, h)
outV = taubin(outV, outF, TAUBIN_ITERS)
fi = np.round((all_raw - lo) / h).astype(int)
inside_frac = float((field[fi[:, 0], fi[:, 1], fi[:, 2]] > 0.5).mean())

# ---------- 6. quantise and write ----------
everything = np.concatenate([P, soma, outV, yolkV])
bmin, bmax = everything.min(0), everything.max(0)
def r12(a): return [float(f'{x:.12g}') for x in np.ravel(a)]   # header floats: identical across numpy/BLAS builds
q_off = np.array(r12((bmin + bmax) / 2)); q_step = np.array(r12(np.maximum((bmax - bmin) / 65532, 1e-9)))
def quant(V): return np.clip(np.round((V - q_off) / q_step), -32767, 32767).astype('<i2')
def qn(N): return np.clip(np.round(N * 127), -127, 127).astype('i1')
def idx(F, nv): return F.astype('<u2' if nv <= 0x10000 else '<u4')
sections = [
    ('points', quant(P), 3), ('stripStart', np.array(s_start, '<u4'), 1), ('stripLength', np.array(s_len, '<u2'), 1),
    ('stripCell', np.array(s_cell, '<u2'), 1), ('cellNode', np.array([c['node'] for c in cells], '<u2'), 1),
    ('cellType', np.array([type_index[c['type']] for c in cells], '<u2'), 1), ('cellFirstStrip', np.array(c_first, '<u4'), 1),
    ('cellStripCount', np.array(c_count, '<u2'), 1),
    ('cellSomaRadius', np.array([min(round(c['radius']), 0xFFFF) for c in cells], '<u2'), 1), ('cellSoma', quant(soma), 3),
    ('cellSkid', np.array([c['skid'] for c in cells], '<u4'), 1), ('nodeSkid', np.array([int(n['skid']) for n in nodes], '<u4'), 1),
    ('outlinePositions', quant(outV), 3), ('outlineNormals', qn(normals(outV, outF)), 3), ('outlineIndices', idx(outF, len(outV)), 3),
    ('yolkPositions', quant(yolkV), 3), ('yolkNormals', qn(normals(yolkV, yolkF)), 3), ('yolkIndices', idx(yolkF, len(yolkV)), 3)]
DTYPE = {'<i2': 'int16', '<u2': 'uint16', '<u4': 'uint32', '|i1': 'int8'}
matched = [c for c in cells if c['node'] != NOCELL]
CLS = ['Sensory neuron', 'interneuron', 'motorneuron', 'effector', 'other', 'fragmentum']
header = dict(
    format='BWMORPH1', version=1, littleEndian=True,
    about='Real 3D morphology of the three-day-old Platynereis dumerilii larva: every traced cell skeleton in the Jekely lab '
          'cell-type 3D viewer pages, a derived body outline and the published yolk mesh, in the body frame of data/wiring.json. '
          'Byte layout: scripts/build-data/build_morph.py.',
    frame=dict(axes='x = left(-)/right(+), y = tail(-)/head(+), z = dorsal(-)/ventral(+); the frame of data/wiring.json positions',
               formula='p = ((p_nm - mu) . lr, (p_nm - mu) . ap, (p_nm - mu) . dv) / scaleNm, source coordinates in nm',
               handedness='(lr, ap, dv) is left-handed: a right-handed 3D renderer must negate one axis for correct depth order',
               mu=r12(mu), lr=r12(lr), ap=r12(ap), dv=r12(dv), scaleNm=r12(scale)[0], umPerUnit=r12(scale / 1000)[0]),
    quant=dict(offset=q_off.tolist(), step=q_step.tolist(), formula='v[a] = offset[a] + q[a] * step[a] for every int16 position; normals n = q / 127'),
    bounds=dict(min=r12(bmin), max=r12(bmax)),
    noCell=NOCELL,
    counts=dict(points=len(P), strips=len(s_start), cells=len(cells), matchedCells=len(matched), cellsWithoutSoma=n_nosoma,
                outlineVertices=len(outV), outlineTriangles=len(outF), yolkVertices=len(yolkV), yolkTriangles=len(yolkF)),
    sections={},
    types=types,
    simplification=dict(sourcePoints=raw_points, sourceSegments=raw_segments, pruneTwigsUnderUnits=PRUNE_UNITS,
                        pruneTwigsUnderUm=round(PRUNE_UNITS / UM, 3), rdpToleranceUnits=RDP_UNITS, rdpToleranceUm=round(RDP_UNITS / UM, 3),
                        note='the lab smoothed the skeletons (nat::smooth_neuron, sigma 6000 nm); paths follow the larger subtree at each branch'),
    outline=dict(source='derived', method=f'closed envelope of all traced skeleton points and the yolk surface: {VOXEL_UM} um voxels, '
                 f'{CLOSE_UM} um closing, hole fill, {GROW_UM} um growth, {BLUR_UM} um Gaussian blur, surface nets at 0.5, '
                 f'{TAUBIN_ITERS} Taubin iterations. Not a published mesh.', skeletonPointsInside=round(inside_frac, 4), **mesh_check(outV, outF)),
    yolk=dict(source='published', method='the yolk volume (CATMAID volume 4) drawn in every cell-type viewer page; vertices de-duplicated',
              **mesh_check(yolkV, yolkF)),
    scaffold='the grey reference strips of every viewer page are the 12 aciculae; they are the cells of type '
             f'{", ".join(acicula_pages) or "?"} and are stored once, as those cells',
    wiring=dict(file='data/wiring.json', sha1=hashlib.sha1(wiring_bytes).hexdigest(), nodes=len(W['n']),
                matchedByClass=dict(sorted(collections.Counter(CLS[W['n'][c['node']][1]] for c in matched).items())),
                ownSoma=own_soma, identifiedPages=id_pages,
                ownSomaNote="matched cells whose skeleton id (from page order) is the node's own; the other matched cells are "
                            'in types that build_wiring.py places by side because their page and skid counts differ',
                sideFallbackTypes=dict(sorted(g.get('fallback', {}).items())),
                sharedSkeletons=[list(p) for p in shared],
                sharedNote='node pairs that build_wiring.py placed on the same soma (one skeleton annotated with two cell '
                           'types); each node gets its own copy of the skeleton'),
    source=dict(repository='https://github.com/JekelyLab/Platynereis_3D_connectome_2024',
                files='supplements/celltype_compendium_website/celltype_compendium/celltype_RGLs/celltype*.html',
                pages=len(pages), rglSha1=rgl_hash.hexdigest(), skeletonSomaPairs=n_pairs),
    license='CC BY 4.0 (repository README: "Text, figures, code, data: CC-BY-4.0")',
    credit='Verasztó C, Jasek S, Gühmann M, Bezares-Calderón LA, Williams EA, Shahidi R, Jékely G. Whole-body connectome of a '
           'segmented annelid larva. eLife (2025). https://elifesciences.org/articles/97964. Changes: skeletons re-sampled '
           '(twig pruning + RDP), moved into this site\'s body frame and quantised; outline derived. Not affiliated with or '
           'endorsed by the authors.')
first = 16
while True:                                           # header size <-> section offsets
    off = first
    for name, a, comp in sections:
        header['sections'][name] = dict(offset=off, byteLength=int(a.nbytes), type=DTYPE[a.dtype.str], components=comp, count=len(a))
        off = (off + a.nbytes + 7) // 8 * 8
    hj = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode()
    need = (12 + len(hj) + 7) // 8 * 8
    if need <= first: break
    first = need
buf = bytearray(off)
buf[0:8] = b'BWMORPH1'; buf[8:12] = (first - 12).to_bytes(4, 'little'); buf[12:first] = hj.ljust(first - 12, b' ')
for name, a, comp in sections:
    o = header['sections'][name]['offset']; buf[o:o + a.nbytes] = np.ascontiguousarray(a).tobytes()
open(OUT, 'wb').write(bytes(buf))
print(f"{len(cells)} cells ({len(matched)} on wiring nodes, {own_soma} of them the node's own skeleton by id, "
      f'{len(shared)} skeletons shared by two nodes, {n_nosoma} without soma), '
      f'{len(s_start)} strips, {len(P)} points '
      f'(from {raw_points}), outline {len(outF)} triangles (derived), yolk {len(yolkF)} triangles, {len(buf)} bytes -> {OUT}')
