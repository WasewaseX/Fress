#!/usr/bin/env node
// CSP verification harness: serves dist/ with the given CSP injected as a
// meta tag, mimicking how Tauri injects app.security.csp into served HTML.
// Usage: node scripts/csp-test-server.mjs <port> [--oldcsp]
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const port = Number(process.argv[2] || 4173);
const useOldCsp = process.argv.includes('--oldcsp');
const dist = join(process.cwd(), 'dist');

const NEW_CSP =
  "default-src 'self'; script-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://api.github.com https://github.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'";
const OLD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://api.github.com https://github.com https://f-droid.org; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'";

const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml',
};

// Runs as a same-origin (script-src 'self') page script, so every probe below
// is governed by the page CSP exactly like the app code is.
const PROBE_JS = `
window.__CSP_PROBES = {};
try { Object.freeze(Object.prototype); } catch (e) {}
(async () => {
  if (!document.body) await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  const P = window.__CSP_PROBES;
  try { new Function('return 1')(); P.eval = 'ALLOWED'; } catch (e) { P.eval = 'BLOCKED ' + e.name; }
  try {
    const s = document.createElement('style'); s.textContent = '.csp-probe-elem{color:rgb(1,2,3)}'; document.head.appendChild(s);
    const d = document.createElement('div'); d.className = 'csp-probe-elem'; document.body.appendChild(d);
    P.styleElem = getComputedStyle(d).color === 'rgb(1, 2, 3)' ? 'APPLIED' : 'BLOCKED';
    d.remove(); s.remove();
  } catch (e) { P.styleElem = 'ERR ' + e.message; }
  try {
    const d = document.createElement('div'); document.body.appendChild(d);
    d.setAttribute('style', 'color: rgb(4, 5, 6)');
    P.styleAttr = getComputedStyle(d).color === 'rgb(4, 5, 6)' ? 'APPLIED' : 'BLOCKED';
    d.remove();
  } catch (e) { P.styleAttr = 'ERR ' + e.message; }
  try { await fetch('https://f-droid.org/api/v1/packages/fdroid'); P.fetchFdroid = 'ALLOWED'; } catch (e) { P.fetchFdroid = 'BLOCKED ' + (e.message || '').slice(0, 40); }
  try { const r = await fetch('https://api.github.com/rate_limit'); P.fetchGithubApi = r.ok ? 'ALLOWED' : 'HTTP ' + r.status; } catch (e) { P.fetchGithubApi = 'BLOCKED ' + (e.message || '').slice(0, 40); }
  try { const r = await fetch('https://github.com/WasewaseX/Fress/releases/download/v1.0.2-beta/SHA256SUMS.txt'); const t = await r.text(); P.fetchGhReleaseRedirect = 'HTTP ' + r.status + (r.redirected ? ' (redirect followed, ' + t.length + ' bytes)' : ''); } catch (e) { P.fetchGhReleaseRedirect = 'BLOCKED ' + (e.message || '').slice(0, 40); }
  try { const r = await fetch('https://github.com/WasewaseX/Fress/releases.atom'); P.fetchGhAtom = r.ok ? 'HTTP ' + r.status : 'HTTP ' + r.status; } catch (e) { P.fetchGhAtom = 'BLOCKED ' + (e.message || '').slice(0, 40); }
  P.dataImg = await new Promise((res) => { const i = new Image(); i.onload = () => res('LOADED ' + i.naturalWidth); i.onerror = () => res('BLOCKED'); i.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; });
})();
`;

createServer((req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  let file = join(dist, path);
  if (!existsSync(file)) file = join(dist, 'index.html');
  const ext = extname(file);
  res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
  let body = readFileSync(file);
  if (file.endsWith('index.html')) {
    const csp = useOldCsp ? OLD_CSP : NEW_CSP;
    const html = body.toString('utf8').replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">\n    <script src="/csp-probe.js"></script>`
    );
    body = Buffer.from(html, 'utf8');
  }
  if (path === '/csp-probe.js') {
    body = Buffer.from(PROBE_JS, 'utf8');
  }
  res.end(body);
}).listen(port, () => console.log(`serving dist/ on http://localhost:${port} with ${useOldCsp ? 'OLD' : 'NEW'} CSP`));
