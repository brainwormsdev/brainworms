// Static files from memory: read once (re-read when the file changes), pre-compressed with
// brotli and gzip, ETags so repeat visits cost a 304. At launch-crowd scale this is most of the bandwidth.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.bin': 'application/octet-stream',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.webmanifest', '.bin']);

/**
 * @param {Record<string,string>} roots url prefix -> directory, longest prefix first
 * @param {(ext:string, text:string) => string} [transformHtml] applied to .html before caching
 */
export function createStatic(roots, { transformHtml = null, maxAge = {} } = {}) {
  const cache = new Map();   // file -> {mtimeMs, size, raw, br, gz, etag, type}
  const prefixes = Object.keys(roots).sort((a, b) => b.length - a.length);

  function resolve(p) {
    const prefix = prefixes.find((k) => p.startsWith(k));
    if (prefix === undefined) return null;
    const base = roots[prefix];
    let rel = p.slice(prefix.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(base, rel);
    return file.startsWith(base + path.sep) ? file : null;
  }

  function load(file, st) {
    let raw = fs.readFileSync(file);
    const ext = path.extname(file);
    if (ext === '.html' && transformHtml) raw = Buffer.from(transformHtml(raw.toString('utf8')));
    const entry = { mtimeMs: st.mtimeMs, size: st.size, raw, type: MIME[ext] || 'application/octet-stream', ext, etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20) + '"' };
    if (COMPRESSIBLE.has(ext) && raw.length > 512) {
      entry.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
      entry.gz = zlib.gzipSync(raw, { level: 9 });
    }
    cache.set(file, entry);
    return entry;
  }

  /** Serve `urlPath` if it maps to a file. Returns false when there's no such file. */
  function serve(req, res, urlPath, { cacheControl } = {}) {
    const file = resolve(urlPath);
    if (!file) return false;
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (!st.isFile()) return false;
    let e = cache.get(file);
    if (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size) e = load(file, st);
    const headers = {
      'Content-Type': e.type,
      // code and styles always revalidate (a cheap 304), so a deploy never mixes old and new files
      'Cache-Control': cacheControl || maxAge[e.ext] || (['.html', '.js', '.css'].includes(e.ext) ? 'no-cache' : 'public, max-age=300'),
      ETag: e.etag,
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, headers); res.end(); return true; }
    const ae = String(req.headers['accept-encoding'] || '');
    let body = e.raw;
    if (e.br && /\bbr\b/.test(ae)) { body = e.br; headers['Content-Encoding'] = 'br'; }
    else if (e.gz && /\bgzip\b/.test(ae)) { body = e.gz; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  return { serve, resolve };
}
