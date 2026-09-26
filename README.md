# Talk to the Worm

A live website running the published wiring diagram of a three-day-old marine worm larva (*Platynereis dumerilii*): 2,675 cells and cell fragments, 14,066 connections, 26,881 synapses. **There is one worm and everyone on the site sees it.** Visitors type messages, which scroll past the worm's eyes as light, or tap its body to poke it, and watch the activity spread through its nervous system.

## Run it locally

```bash
npm install
npm start            # http://localhost:3000
npm test             # all tests
```

Node 20 or newer.

## Deploy

It needs a host that runs a long-lived Node process with WebSockets. Serverless platforms (Vercel, Netlify functions) won't work. Run **exactly one instance**: the worm lives in the server's memory.

**Render** (simplest): push this repo to GitHub → Render dashboard → New → Blueprint → pick the repo. `render.yaml` sets everything up, including a generated `ADMIN_TOKEN`. Use a paid instance (Starter) so the worm doesn't go to sleep; free instances stop after 15 idle minutes and the worm restarts from rest.

**Railway**: New project → Deploy from GitHub repo. Add the variable `TRUST_PROXY=1` (and `ADMIN_TOKEN`). It detects `npm start` by itself.

**Anything with Docker** (Fly.io, a VPS): `docker build -t worm . && docker run -p 3000:3000 -e ADMIN_TOKEN=... worm`.

Then point your domain at it and set `ALLOWED_ORIGINS=https://yourdomain` so other sites can't embed the live connection.

## Settings

All optional, as environment variables (see `.env.example`).

| Variable | What it does |
|---|---|
| `PORT` | Port to listen on (default 3000) |
| `TRUST_PROXY` | Set to `1` behind Render/Railway/Fly/Cloudflare so rate limits see real visitor addresses |
| `ADMIN_TOKEN` | Enables the admin endpoints below |
| `ALLOWED_ORIGINS` | Comma-separated page origins allowed to open the live connection |
| `SITE_TICKER` | Shown in the header, e.g. `$WORM` |
| `SITE_CONTRACT` | Official contract address, shown in the header with a copy button |
| `SITE_LINKS` | `Label|https://url,Label|https://url` links in the header |
| `MSG_PER_MIN`, `POKES_PER_SEC`, `MAX_QUEUE`, `MAX_CONN_PER_IP`, `FEED_SIZE` | Limits |
| `LOG_DIR` | Where event logs go (default `var/`) |

## Chat safety

- Links of any kind and wallet/contract addresses are refused, so nobody can post a fake contract address or phishing link in the feed.
- Common profanity is replaced with asterisks.
- `config/blocklist.txt` rejects extra phrases (starts with common scam lines). Edit it, then reload it without restarting.
- Per-address rate limits on messages, pokes and connections.

Admin endpoints (send `Authorization: Bearer $ADMIN_TOKEN`):

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://yoursite/admin/clear                 # empty the feed
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "https://yoursite/admin/hide?id=m1a2b3"      # remove one item
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://yoursite/admin/reload-blocklist
```

## Checking it's real

Every message and poke is written to a public log at `/log/current.jsonl` with the exact simulation step it hit the worm. The simulation is deterministic, so anyone can re-run it:

```bash
npm run replay -- https://yoursite/log/current.jsonl
# Run 1: 214 messages and pokes, 214/214 summaries reproduced exactly
```

## What is real and what is simplified

This is stated on the site too.

- **Real:** every cell, every connection and every synapse count comes from the published connectome. 1,199 cells are drawn at soma positions from the lab's 3D cell-type reconstructions; 1,009 without a published position are placed in their correct body segment and side; 467 fragments are simulated but not drawn.
- **Simplified:** each cell is a firing-rate unit. Transmitter identity is unknown for most cells, so every synapse is treated as excitatory. One global gain (2.2) and slow per-cell fatigue. Nothing is trained.
- **Our choices:** how the message maps onto the 26 eye photoreceptors (left half of the view to left eyes, right half to right eyes), that the 4 non-directional light sensors only respond to a mostly bright view, and which cells a poke activates (the touch sensors nearest the tap).

## Data and licence

Wiring data: Verasztó C, Jasek S, Gühmann M, Bezares-Calderón LA, Williams EA, Shahidi R, Jékely G. *Whole-body connectome of a segmented annelid larva.* eLife (2025). https://elifesciences.org/articles/97964 · https://github.com/JekelyLab/Platynereis_3D_connectome_2024 · licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: positions derived from the lab's 3D viewer files, re-encoded for the browser, simulation added. Not affiliated with or endorsed by the authors.

Rebuild `data/wiring.json` from the source repository (reproduces the committed file byte-for-byte):

```bash
git clone --depth 1 https://github.com/JekelyLab/Platynereis_3D_connectome_2024 plat
pip install numpy
python3 scripts/build-data/build_wiring.py plat data/wiring.json
```

Pixel font: rasterised from Poppins Bold (SIL Open Font License) by `scripts/build-data/make_glyphs.py`.
