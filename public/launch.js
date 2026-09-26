// The /launch page: public status and proof of the launch moment, plus the owner's controls.
// Signing uses the Wallet Standard (Phantom, Solflare, Backpack...): the server prepares the
// transaction with the new mint's signature in it, and the owner's wallet adds its own and sends it.
import { pixelWordmark } from '/pixel.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
$('lpmark').append(pixelWordmark([{ text: 'BRAIN', cls: 'ink' }, { text: 'WORM', cls: 'amber', glow: true }]));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; }
  return s;
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const log = (line) => { const p = $('lplog'); p.textContent = (p.textContent + '\n' + line).trim().split('\n').slice(-14).join('\n'); };
const fmtTime = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/* ---------- public status ---------- */
async function refresh() {
  const s = await fetch('/launch/status.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (!s) return;
  const set = (k, on, text) => { const li = document.querySelector(`[data-k="${k}"]`); li.classList.toggle('on', !!on); $('st-' + k).textContent = text; };
  set('armed', s.armed, s.armed ? `Armed at step ${s.armed.step.toLocaleString('en-US')} (${fmtTime(s.armed.at)}). Rule: the ${s.armed.rule}.` : 'Not armed yet.');
  set('moment', s.moment, s.moment ? `Step ${s.moment.step.toLocaleString('en-US')}: ${s.moment.nAct.toLocaleString('en-US')} cells firing, startle level ${s.moment.startle}.` : s.armed ? 'Armed. Waiting for the first full-body startle.' : 'Waiting for the launch to be armed.');
  set('metadata', s.metadata, s.metadata ? `Uploaded: ${s.metadata.uri}` : 'Uploaded to IPFS after the moment.');
  set('launched', s.launched, s.launched ? `Mint ${s.launched.mint}` : 'Created on pump.fun from the moment.');
  if (s.launched) {
    const p = $('st-launched'); p.replaceChildren(`Mint ${s.launched.mint} · `);
    const a = el('a', null, 'transaction'); a.href = 'https://solscan.io/tx/' + s.launched.signature; a.target = '_blank'; a.rel = 'noopener'; p.append(a);
  }
  if (s.moment) {
    $('lpmoment').hidden = false;
    $('lpimg').src = '/launch/moment.png?' + s.moment.imageSha256.slice(0, 8);
    const kv = $('lpkv'); kv.replaceChildren();
    const row = (k, v) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); kv.append(d); };
    row('Step', s.moment.step.toLocaleString('en-US'));
    row('State SHA-256', s.moment.stateSha256);
    row('Image SHA-256', s.moment.imageSha256);
    row('Captured', fmtTime(s.moment.capturedAt));
    $('lpdesc').textContent = 'Token description: ' + s.description;
  }
}
refresh(); setInterval(refresh, 5000);

/* ---------- owner controls ---------- */
let token = sessionStorage.getItem('wormAdminToken') || '';
async function admin(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`/admin/launch/${path}${q ? '?' + q : ''}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 404) { lock(); throw new Error('Wrong or expired token.'); }
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Failed.');
  return j;
}
function lock() { token = ''; sessionStorage.removeItem('wormAdminToken'); $('lpcontrols').hidden = true; $('lplock').hidden = false; }
async function unlock() {
  const r = await fetch('/admin/state', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) { lock(); log('That token is not right.'); return; }
  sessionStorage.setItem('wormAdminToken', token);
  $('lplock').hidden = true; $('lpcontrols').hidden = false;
}
$('lplock').addEventListener('submit', (e) => { e.preventDefault(); token = $('lptoken').value.trim(); unlock(); });
if (token) unlock();
const act = (btn, fn) => $(btn).addEventListener('click', async () => {
  $(btn).disabled = true;
  try { await fn(); } catch (e) { log('✗ ' + e.message); } finally { $(btn).disabled = false; refresh(); }
});
act('lparm', async () => { await admin('arm'); log('Armed. The first full-body startle from now is the moment.'); });
act('lpdisarm', async () => { await admin('disarm'); log('Disarmed.'); });
act('lpmeta', async () => {
  if (!confirm('Upload the moment image and metadata to pump.fun\'s IPFS? This publishes them.')) return;
  const j = await admin('metadata', { twitter: $('lptw').value.trim(), telegram: $('lptg').value.trim() });
  log('✓ Metadata: ' + j.metadata.uri);
});

/* ---------- wallets (Wallet Standard) ---------- */
const wallets = [];
const registry = { register(...ws) { for (const w of ws) if (!wallets.includes(w)) wallets.push(w); return () => {}; } };
addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(registry); } catch { /* bad wallet */ } });
dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registry }));
let wallet = null, account = null, prepared = null;
act('lpwallet', async () => {
  const usable = wallets.filter((w) => w.features['solana:signAndSendTransaction'] && w.features['standard:connect'] && (w.chains || []).some((c) => c.startsWith('solana:mainnet')));
  if (!usable.length) throw new Error('No Solana wallet found in this browser (Phantom, Solflare, Backpack).');
  wallet = usable.length === 1 ? usable[0] : usable.find((w) => /phantom/i.test(w.name)) || usable[0];
  const { accounts } = await wallet.features['standard:connect'].connect();
  account = accounts[0];
  log(`Connected ${wallet.name}: ${account.address}`);
});
act('lpprep', async () => {
  if (!account) throw new Error('Connect a wallet first.');
  const amountSol = String(Math.max(0, Number($('lpbuy').value) || 0));
  const j = await admin('prepare', { creator: account.address, amountSol });
  prepared = j;
  log(`Prepared. Mint ${j.mint}`);
  log(`Fee payer ${j.summary.feePayer} · signers ${j.summary.signers.join(', ')}`);
  log(`Programs ${j.summary.programIds.join(', ')}`);
  log('Nothing has been sent. "Sign and launch" asks your wallet to approve it.');
  $('lpsign').disabled = false;
});
act('lpsign', async () => {
  if (!prepared || !account) throw new Error('Prepare the transaction first.');
  if (!confirm(`Launch $BRAINWORM now? Your wallet will show the transaction and its cost. This cannot be undone.\n\nMint: ${prepared.mint}`)) return;
  const [out] = await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({ account, chain: 'solana:mainnet', transaction: fromB64(prepared.tx) });
  const signature = b58(out.signature);
  log('Sent: ' + signature);
  $('lpsign').disabled = true;
  for (let k = 0; k < 20; k++) {
    await new Promise((r) => setTimeout(r, 3000));
    const c = await admin('confirm', { signature }).catch((e) => ({ ok: false, error: e.message }));
    if (c.ok) { log('✓ Launched. Trades now reach the worm.'); return; }
    log('Waiting for confirmation…');
  }
  log('Not confirmed yet. Check the transaction on Solscan, then press Sign again only if it failed.');
});
