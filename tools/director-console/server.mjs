#!/usr/bin/env node
// Director console: one local page to read and steer the workflow (runner questions, judge drafts,
// triage, memory modes and records, pilots, playbook, scorecard). Listens on 127.0.0.1 only, checks
// the Host header (no DNS rebinding) and wants the session token on every /api call; actions are
// POST with a JSON body and run only the allowlisted CLIs in lib.mjs.
//   node ~/.agents/tools/director-console/server.mjs [--port 7792]
// Env: CONSOLE_PORT, CONSOLE_TOKEN (default: the .token file, made once), plus the CONSOLE_* paths in lib.mjs.
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
  '/api/overview': () => ({ projects: lib.projects(), pending: lib.pending(), host: os.hostname(), at: new Date().toISOString() }),
  '/api/pending': () => lib.pending(),
  '/api/project': (q) => lib.projectDetail(q.get('id')),
  '/api/memory': () => lib.memory(),
  '/api/records': (q) => lib.searchRecords(q.get('q') ?? '', q.get('project') ?? ''),
  '/api/record': (q) => lib.record(q.get('id')),
  '/api/pilot': (q) => lib.pilotReport(q.get('project')),
  '/api/playbook': () => lib.playbook(),
  '/api/recipe': (q) => ({ path: q.get('path'), text: lib.recipeText(q.get('path')) }),
  '/api/actions': () => ({ actions: lib.ACTION_NAMES, log: lib.actionLog() }),
};

const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'bad host' });
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(path.join(HERE, 'public', 'index.html')), 'text/html; charset=utf-8');
    const tokenOk = (req.headers['x-console-token'] ?? url.searchParams.get('t')) === TOKEN;
    if (url.pathname === '/scorecard') {
      if (!tokenOk) return send(res, 401, { error: 'token' });
      return fs.existsSync(SCORECARD) ? send(res, 200, fs.readFileSync(SCORECARD), 'text/html; charset=utf-8') : send(res, 404, 'no scorecard dashboard yet', 'text/plain');
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.headers['x-console-token'] !== TOKEN) return send(res, 401, { error: 'token' });
    if (req.method === 'GET' && GET[url.pathname]) return send(res, 200, GET[url.pathname](url.searchParams));
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
