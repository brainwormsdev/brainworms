"""Build data/transmitters.json: the known small-molecule transmitter of each wiring node.

    python3 scripts/build-data/build_transmitters.py plat data/wiring.json data/transmitters.json

Input: data/neuronal_celltypes_table.csv from the Jékely lab's repository (column 'transmitter phenotype',
one row per cell type), matched to data/wiring.json nodes by cell type name (node field 4, which
build_wiring.py takes from the same table). Only the five small-molecule transmitters the table names are
kept; neuropeptides and 'dense cored vesicles' are listed there too but say nothing about a synapse's sign.
Most neurons have no entry: their transmitter is not known.
"""
import sys, os, csv, json

REPO = sys.argv[1] if len(sys.argv) > 1 else 'plat'
WIRING = sys.argv[2] if len(sys.argv) > 2 else 'data/wiring.json'
OUT = sys.argv[3] if len(sys.argv) > 3 else 'data/transmitters.json'
SMALL = ['cholinergic', 'glutamatergic', 'serotonergic', 'dopaminergic', 'adrenergic']

bytype = {}
for r in csv.DictReader(open(os.path.join(REPO, 'data/neuronal_celltypes_table.csv'), newline='')):
    name = (r.get('name of cell type') or '').strip()
    phen = (r.get('transmitter phenotype') or '').lower()
    found = [t for t in SMALL if t in phen]
    if name and found: bytype[name] = found

nodes = json.load(open(WIRING))['n']
cells = {str(i): bytype[x[4]] for i, x in enumerate(nodes) if x[4] in bytype}
counts = {t: sum(t in v for v in cells.values()) for t in SMALL}
out = {
    'source': 'JekelyLab/Platynereis_3D_connectome_2024, data/neuronal_celltypes_table.csv, column "transmitter phenotype" (CC BY 4.0)',
    'note': 'small-molecule transmitters only, by wiring node index; nodes not listed have no known transmitter',
    'counts': counts,
    'cells': cells,
}
with open(OUT, 'w') as f: json.dump(out, f, separators=(',', ':'), sort_keys=True)
print(f'{len(cells)} of {len(nodes)} nodes have a known transmitter: {counts} -> {OUT}')
