// Servidor de desenvolvimento do painel R3D PLAY: serve a pasta ui/ em http://127.0.0.1:5173 e imita a ponte do app nativo
// (window.chrome.webview) falando com o servidor real (https://localhost:47990) com a sessão e o login guardados em %LOCALAPPDATA%\ApolloConfig\cred.dat.
//
// MODO SECO (padrão, R3D_DRY=1): leituras (GET) vão ao servidor real; gravações (POST) NÃO são enviadas: ficam numa sobreposição em memória
// (a tela "salva" e relê o que gravou) e cada uma é registrada em /__mutations. Nada muda no PC, não reinicia o serviço, não abre jogos.
// MODO REAL (R3D_DRY=0): tudo passa ao servidor. Só use com o usuário pedindo.
//
//   node tools/ApolloConfig/dev/devserver.mjs [--port=5181]   → http://127.0.0.1:5173/index.html (porta padrão 5173)
//   GET /__mutations  → gravações pedidas pela tela (JSON)       GET /__reset → apaga a sobreposição e o registro
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '..', 'ui');
const argPort = process.argv.find((a) => a.startsWith('--port='))?.slice(7);   // --port=5181 (aparece na linha de comando: dá para achar e parar só esta instância)
const PORT = Number(argPort || process.env.R3D_DEV_PORT || 5173);
const BASE = process.env.R3D_URL || 'https://localhost:47990';
const DRY = process.env.R3D_DRY !== '0';
const CRED = path.join(process.env.LOCALAPPDATA || '', 'ApolloConfig', 'cred.dat');

/* ---------- Login guardado (DPAPI do usuário atual, igual ao app nativo) ---------- */
function loadCreds() {
  try {
    const ps = `Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${CRED}'), $null, 'CurrentUser'))`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
    const a = JSON.parse(out);
    return Array.isArray(a) && a.length === 2 ? a : null;
  } catch { return null; }
}
let creds = loadCreds();
// Cookie compartilhado entre instâncias do dev (o servidor só aceita UMA sessão por vez: se cada instância entrasse sozinha, uma derrubaria a outra).
const SHARED = path.join(HERE, '.session');
const readShared = () => { try { return fs.readFileSync(SHARED, 'utf8').trim(); } catch { return ''; } };
let cookie = readShared();

/* ---------- Chamadas ao servidor real ---------- */
function rawRequest(method, url, body, headers = {}, timeout = 15000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, rejectUnauthorized: false, timeout, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, headers: {}, raw: Buffer.from(String(e.message)) }));
    if (body != null) req.write(body);
    req.end();
  });
}
/** O servidor declara windows-1252 no log mas grava UTF-8: igual ao app nativo, decodifica como UTF-8 e só cai em Latin-1 se inválido. */
function decode(raw) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return raw.toString('latin1'); }
}
async function login(user, pass) {
  const r = await rawRequest('POST', BASE + '/api/login', JSON.stringify({ username: user, password: pass }), { 'Content-Type': 'application/json' });
  const sc = r.headers['set-cookie'];
  if (r.status >= 200 && r.status < 300 && sc) {
    cookie = sc.map((c) => c.split(';')[0]).join('; ');
    try { fs.writeFileSync(SHARED, cookie); } catch { /* sem cache compartilhado */ }
    return true;
  }
  return false;
}
/** Renova a sessão: primeiro tenta o cookie que outra instância já renovou; senão entra de novo (uma vez por vez neste processo). */
let renewing = null;
function renew(stale) {
  renewing ??= (async () => {
    try {
      const shared = readShared();
      if (shared && shared !== stale) { cookie = shared; return true; }
      return creds ? await login(creds[0], creds[1]) : false;
    } finally { setTimeout(() => { renewing = null; }, 300); }
  })();
  return renewing;
}
async function realApi(method, p, body, retry = 4) {
  const headers = {};
  const used = cookie;
  if (used) headers.Cookie = used;
  if (body == null && method !== 'GET' && method !== 'HEAD') body = '{}';
  if (body != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  const r = await rawRequest(method, BASE + p, body, headers);
  if (r.status === 401 && retry > 0 && creds) {
    await new Promise((ok) => setTimeout(ok, 100 + Math.random() * 400));
    if (cookie !== used || (await renew(used))) return realApi(method, p, body, retry - 1);
  }
  return { status: r.status, body: decode(r.raw) };
}

/* ---------- Modo seco: sobreposição em memória das gravações ---------- */
const overlay = { config: null, apps: null, clients: null };
const mutations = [];
let seqUuid = 0;
const fakeUuid = () => `00000000-0000-4000-8000-${String(++seqUuid).padStart(12, '0')}`;
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const asText = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

async function dryApi(method, p, body) {
  const route = p.split('?')[0];
  const data = parse(body) ?? {};
  if (method === 'GET') {
    const r = await realApi('GET', p, null);
    if (r.status !== 200) return r;
    if (route === '/api/config' && overlay.config) {
      const real = parse(r.body) ?? {};
      const meta = {};
      for (const k of ['status', 'platform', 'version', 'vdisplayStatus']) if (k in real) meta[k] = real[k];
      const out = { ...meta };
      for (const [k, v] of Object.entries(overlay.config)) out[k] = asText(v);
      return { status: 200, body: JSON.stringify(out) };
    }
    if (route === '/api/apps') {
      const real = parse(r.body) ?? {};
      if (!overlay.apps) overlay.apps = real.apps || [];
      return { status: 200, body: JSON.stringify({ ...real, apps: overlay.apps }) };
    }
    if (route === '/api/clients/list' && overlay.clients) {
      return { status: 200, body: JSON.stringify({ ...(parse(r.body) ?? {}), named_certs: overlay.clients }) };
    }
    return r;
  }
  mutations.push({ n: mutations.length + 1, method, path: p, body: data });
  const ok = (extra = {}) => ({ status: 200, body: JSON.stringify({ status: true, ...extra }) });
  switch (route) {
    case '/api/config': overlay.config = Object.fromEntries(Object.entries(data)); return ok();
    case '/api/apps': {
      if (!overlay.apps) overlay.apps = parse((await realApi('GET', '/api/apps', null)).body)?.apps || [];
      const app = { ...data };
      if (!app.uuid) app.uuid = fakeUuid();
      const i = overlay.apps.findIndex((a) => a.uuid === app.uuid);
      if (i >= 0) overlay.apps[i] = app; else overlay.apps.push(app);
      return ok();
    }
    case '/api/apps/delete':
      if (!overlay.apps) overlay.apps = parse((await realApi('GET', '/api/apps', null)).body)?.apps || [];
      overlay.apps = overlay.apps.filter((a) => a.uuid !== data.uuid);
      return ok();
    case '/api/apps/reorder': {   // { order: [uuid, ...] }
      if (!overlay.apps) overlay.apps = parse((await realApi('GET', '/api/apps', null)).body)?.apps || [];
      const pos = new Map((data.order || []).map((u, i) => [u, i]));
      overlay.apps = [...overlay.apps].sort((x, y) => (pos.get(x.uuid) ?? 1e9) - (pos.get(y.uuid) ?? 1e9));
      return ok();
    }
    case '/api/clients/update': case '/api/clients/unpair': case '/api/clients/unpair-all': {
      if (!overlay.clients) overlay.clients = parse((await realApi('GET', '/api/clients/list', null)).body)?.named_certs || [];
      if (route === '/api/clients/update') overlay.clients = overlay.clients.map((c) => (c.uuid === data.uuid ? { ...c, ...data } : c));
      else if (route === '/api/clients/unpair') overlay.clients = overlay.clients.filter((c) => c.uuid !== data.uuid);
      else overlay.clients = [];
      return ok();
    }
    case '/api/otp': return ok({ otp: '4821', ip: '192.168.0.10', name: 'DEV-PC' });
    case '/api/covers/upload': return ok({ path: `C:\\dev\\covers\\${data.key || 'x'}.png` });
    case '/api/restart': return { status: 0, body: 'dry-run: reiniciaria o servidor' };   // o servidor real derruba a conexão ao reiniciar
    default: return ok();
  }
}

/* ---------- Ponte (mesmos comandos do app nativo) ---------- */
const FAKE_GAMES = [
  { source: 'steam', id: '220', name: 'Half-Life 2 (dev)', uuid: 'DEV-0001' },
  { source: 'epic', id: 'fn', name: 'Jogo de teste Epic (dev)', uuid: 'DEV-0002' },
].map((g) => ({ ...g, app: { name: g.name, uuid: g.uuid, cmd: '', detached: [`steam://rungameid/${g.id}`], 'terminate-on-pause': true, 'virtual-display': true } }));

async function bridge(m) {
  switch (m.cmd) {
    case 'api': return DRY ? dryApi(m.method, m.path, m.body) : realApi(m.method, m.path, m.body);
    case 'login': {
      const ok = await login(m.user, m.pass);
      if (ok) creds = [m.user, m.pass];
      return { ok };
    }
    case 'logout': creds = null; cookie = ''; return { ok: true };
    case 'hasCreds': return { ok: !!creds };
    case 'scan': return { games: FAKE_GAMES };
    case 'cover': case 'readCover': return { data: null };
    case 'log': console.log('[ui.log]', m.text); return { ok: true };
    case 'advanced': return { ok: true };
    case 'info': {
      const ips = [];
      for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) ips.push({ name, ip: a.address, kind: /wi-?fi|wlan|wireless/i.test(name) ? 'wifi' : 'lan' });
      }
      return { host: os.hostname(), ips, url: BASE };
    }
    case 'stats': {
      const r = await rawRequest('GET', `http://localhost:${m.port || 47989}/r3d/stats`, null, {}, 4000);
      return r.status === 200 ? { ok: true, body: decode(r.raw) } : { ok: false, error: `HTTP ${r.status}` };
    }
    default: return { error: 'comando desconhecido' };
  }
}

/* ---------- Arquivos estáticos ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8' };
const SHIM = `(() => { const ls = []; window.chrome = window.chrome || {};
  window.chrome.webview = { addEventListener(t, f) { if (t === 'message') ls.push(f); },
    postMessage(m) { fetch('/__bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) })
      .then((r) => r.text()).then((t) => ls.forEach((f) => f({ data: t })))
      .catch((e) => ls.forEach((f) => f({ data: JSON.stringify({ id: m.id, error: String(e) }) }))); } }; })();`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  if (url.pathname === '/__shim.js') return send(200, SHIM, MIME['.js']);
  if (url.pathname === '/__mutations') return send(200, JSON.stringify({ dry: DRY, mutations }, null, 1));
  if (url.pathname === '/__reset') { overlay.config = overlay.apps = overlay.clients = null; mutations.length = 0; return send(200, '{"ok":true}'); }
  if (url.pathname === '/__bridge' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let m = {};
      try { m = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* corpo inválido */ }
      let result;
      try { result = (await bridge(m)) ?? {}; } catch (e) { result = { error: String(e) }; }
      send(200, JSON.stringify({ ...result, id: m.id }));
    });
    return;
  }
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.resolve(UI, '.' + rel);
  if (!file.startsWith(UI + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, 'não encontrado', 'text/plain; charset=utf-8');
  let data = fs.readFileSync(file);
  if (rel === '/index.html') data = Buffer.from(data.toString('utf8').replace('<script type="module"', '<script src="/__shim.js"></script>\n<script type="module"'));
  send(200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`R3D PLAY dev: http://127.0.0.1:${PORT}/index.html  (${DRY ? 'MODO SECO: gravações não são enviadas' : 'MODO REAL'}; login guardado: ${creds ? 'sim' : 'NÃO'})`);
});
