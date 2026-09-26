// All settings come from environment variables. See .env.example.
const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());

export const config = {
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  // Set when running behind a proxy/load balancer (Render, Railway, Fly, Cloudflare) so rate limits see real IPs.
  trustProxy: bool(env.TRUST_PROXY),
  // Bearer token for /admin endpoints. Admin is disabled when empty.
  adminToken: env.ADMIN_TOKEN || '',
  // Where event logs are written (one file per server start).
  logDir: env.LOG_DIR || 'var',
  blocklistFile: env.BLOCKLIST_FILE || 'config/blocklist.txt',
  // Comma-separated list of allowed page origins for the live connection, e.g. https://worm.example.com
  allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

  limits: {
    messagesPerMinutePerIp: num(env.MSG_PER_MIN, 12),
    pokesPerSecondPerIp: num(env.POKES_PER_SEC, 3),
    maxQueue: num(env.MAX_QUEUE, 12),
    maxConnectionsPerIp: num(env.MAX_CONN_PER_IP, 8),
    feedSize: num(env.FEED_SIZE, 40),
  },

  // Optional header links shown on the page. Leave empty to hide.
  site: {
    title: env.SITE_TITLE || 'Talk to the Worm',
    ticker: env.SITE_TICKER || '',
    contract: env.SITE_CONTRACT || '',
    // "Label|https://url,Label|https://url"
    links: (env.SITE_LINKS || '').split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
      const [label, url] = pair.split('|').map((s) => (s || '').trim());
      return /^https:\/\//.test(url || '') ? { label, url } : null;
    }).filter(Boolean),
  },
};
