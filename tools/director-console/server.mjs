#!/usr/bin/env node
// Director console: one local page to read and steer the workflow (runner questions, judge drafts,
// triage, memory modes and records, pilots, playbook, scorecard). Listens on 127.0.0.1 only, checks
// the Host header (no DNS rebinding) and wants the session token on every /api call; actions are
// POST with a JSON body and run only the allowlisted CLIs in lib.mjs.
// Tailnet access goes through `tailscale serve` (HTTPS proxy to 127.0.0.1, never funnel). A request
// that came through it (the tailnet Host, or any Tailscale-User-Login header) must also carry a
// Tailscale-User-Login in CONSOLE_TAILNET_USERS.
//   node ~/.agents/tools/director-console/server.mjs [--port 7792]
// Env: CONSOLE_PORT, CONSOLE_TOKEN (default: the .token file, made once), CONSOLE_TAILNET_HOST
// (e.g. mac.tailXXXX.ts.net), CONSOLE_TAILNET_USERS (comma-separated logins), plus the CONSOLE_*
// paths in lib.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.CONSOLE_PORT ?? 7792);
// one token per install (0600 file next to the server), so the bookmarked URL survives restarts
const TOKEN_FILE = path.join(HERE, '.token');
const TOKEN = process.env.CONSOLE_TOKEN ?? (() => {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  const t = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
})();
const SCORECARD = path.join(lib.CFG.logs, 'scorecard-dashboard.html');
// the page's own files only; scripts never inline, so the page CSP can forbid inline script
const ASSETS = new Set(['app.css', 'app.js', 'graph.js']);
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "frame-src 'self' http://127.0.0.1:* http://localhost:*", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
const TAILNET_HOST = (process.env.CONSOLE_TAILNET_HOST ?? '').toLowerCase().replace(/\.$/, '');
const TAILNET_USERS = new Set((process.env.CONSOLE_TAILNET_USERS ?? '').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean));

/** null when the request may proceed, else why not. */
function refuse(req) {
  const host = (req.headers.host ?? '').toLowerCase();
  const local = host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
  const tailnet = !!TAILNET_HOST && (host === TAILNET_HOST || host === `${TAILNET_HOST}:443`);
  if (!local && !tailnet) return 'bad host';
  const login = req.headers['tailscale-user-login'];
  if (tailnet || login !== undefined) {
    // through tailscale serve: only the listed tailnet users, never a tagged or shared node
    if (!login || !TAILNET_USERS.has(String(login).toLowerCase())) return 'tailnet user not allowed';
  }
  return null;
}

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 1_000_000) reject(Object.assign(new Error('body too large'), { status: 413 }));
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('body is not JSON'), { status: 400 })); }
    });
  });
}

const GET = {
  '/api/overview': () => {
    const projects = lib.projects();
    const pending = lib.pending(projects);
    return { projects, pending, attention: lib.attention(projects, pending).items, memory: lib.memorySummary(), host: os.hostname(), at: new Date().toISOString() };
  },
  '/api/pending': () => lib.pending(),
  // what a hidden tab polls for notifications: no archive load, unlike the overview
  '/api/attention': () => lib.attention(),
  '/api/project': (q) => lib.projectDetail(q.get('id')),
  '/api/memory': () => lib.memory(),
  '/api/records': (q) => lib.searchRecords(q.get('q') ?? '', q.get('project') ?? ''),
  '/api/record': (q) => lib.record(q.get('id')),
  '/api/pilot': (q) => lib.pilotReport(q.get('project')),
  '/api/playbook': () => lib.playbook(),
  '/api/recipe': (q) => ({ path: q.get('path'), text: lib.recipeText(q.get('path')) }),
  '/api/actions': () => ({ actions: lib.ACTION_NAMES, log: lib.actionLog() }),
  '/api/resources': () => lib.resources(),
  '/api/previews': () => lib.previews(),
  '/api/quota': (q) => lib.quota({ force: q.get('force') === '1' }),
};

const server = http.createServer(async (req, res) => {
  try {
    const why = refuse(req);
    if (why) return send(res, 403, { error: why });
    const url = new URL(req.url, 'http://console.local');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.setHeader('content-security-policy', CSP);
      return send(res, 200, fs.readFileSync(path.join(HERE, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    const asset = url.pathname.match(/^\/assets\/([a-z0-9-]+\.(css|js))$/);
    if (asset && ASSETS.has(asset[1])) return send(res, 200, fs.readFileSync(path.join(HERE, 'public', asset[1])), asset[2] === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
    const tokenOk = (req.headers['x-console-token'] ?? url.searchParams.get('t')) === TOKEN;
    if (url.pathname === '/scorecard') {
      if (!tokenOk) return send(res, 401, { error: 'token' });
      return fs.existsSync(SCORECARD) ? send(res, 200, fs.readFileSync(SCORECARD), 'text/html; charset=utf-8') : send(res, 404, 'no scorecard dashboard yet', 'text/plain');
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.headers['x-console-token'] !== TOKEN) return send(res, 401, { error: 'token' });
    if (req.method === 'GET' && GET[url.pathname]) return send(res, 200, await GET[url.pathname](url.searchParams));
    const m = url.pathname.match(/^\/api\/action\/([a-z.]+)$/);
    if (req.method === 'POST' && m) {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      const body = await readBody(req);
      return send(res, 200, lib.runAction(m[1], body));
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, e.status ?? 400, { error: e.message });
  }
});

server.on('error', (e) => {
  console.error(JSON.stringify({ error: e.code === 'EADDRINUSE' ? `port ${PORT} is in use: pass --port <n> or CONSOLE_PORT` : e.message }));
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${PORT}/?t=${TOKEN}`, pid: process.pid }));
});
