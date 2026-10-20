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
import zlib from 'node:zlib';
import { execFileSync, execFile } from 'node:child_process';
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

/* ---------- Simulação dos comandos de "Adicionar aplicativo" (installedPrograms, pickFile, pickFolder, inspectProgram, droppedFiles, findExe) ----------
   Por padrão nada toca o disco do PC: tudo é inventado a partir do que a tela manda. Modos de teste: GET /__sim?programs=ok|many|empty|error|slow|old&pickFile=ok|cancel|error
   &pickFolder=one|many|none|cancel|error&findExe=on|off&saveFail=on|off  (GET /__sim sem parâmetros mostra o estado; "old" imita um app antigo sem os comandos novos).

   DADOS REAIS (opcional): R3D_NATIVE_EXE=<caminho do ApolloConfig.exe compilado> faz installedPrograms, inspectProgram e findExe rodarem o C# DE VERDADE pelas flags
   --programs / --inspect / --find-exe (sem abrir janela, sem executar nenhum programa do PC; só lê o disco). As caixas do Windows continuam simuladas, mas podem devolver um
   caminho real: /__sim?pickFilePath=<arquivo>&pickFolderPath=<pasta>&dropPaths=<caminho1>|<caminho2> (com pickFolderPath, os candidatos vêm do C# real). Esvazie com o valor vazio.
     $env:R3D_NATIVE_EXE="$env:TEMP\r3d-integ-build\ApolloConfig.exe"; node tools/ApolloConfig/dev/devserver.mjs --port=5260 */
const SIM = { programs: 'ok', pickFile: 'ok', pickFolder: 'one', findExe: 'on', saveFail: 'off', pickFilePath: '', pickFolderPath: '', dropPaths: '' };
const NATIVE_EXE = process.env.R3D_NATIVE_EXE || '';
let nativeSeq = 0;
/** Roda o app nativo pela flag de diagnóstico e devolve o JSON gravado. Nunca lança. */
function nativeFlag(args) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `r3d-dev-${process.pid}-${++nativeSeq}.json`);
    execFile(NATIVE_EXE, [...args, out], { windowsHide: true, timeout: 40000 }, () => {
      try { resolve(JSON.parse(fs.readFileSync(out, 'utf8'))); } catch (e) { resolve({ error: `o app nativo não gravou a resposta (${e.message})` }); } finally { try { fs.rmSync(out, { force: true }); } catch { /* ok */ } }
    });
  });
}
const nativeCommand = (m) => {
  if (m.cmd === 'installedPrograms') return nativeFlag(['--programs']);
  if (m.cmd === 'inspectProgram') return nativeFlag(['--inspect', String(m.path ?? '')]);
  return nativeFlag(['--find-exe', String(m.folder ?? '')]);   // findExe
};
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** PNG 32x32 de uma cor só com cantos arredondados (ícone de mentira), em base64 sem prefixo. */
function fakeIcon(r, g, b) {
  const W = 32;
  const raw = Buffer.alloc((W * 4 + 1) * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = Math.min(x, W - 1 - x);
      const dy = Math.min(y, W - 1 - y);
      const inside = !(dx < 5 && dy < 5 && (5 - dx) ** 2 + (5 - dy) ** 2 > 25);
      const o = y * (W * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = inside ? 255 : 0;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return png.toString('base64');
}
const prog = (name, exe, source = 'startmenu', icon = null, args = '') => ({ name, exe, args, dir: exe.slice(0, exe.lastIndexOf('\\')), source, icon });
const FAKE_PROGRAMS = [
  prog('7-Zip File Manager', 'C:\\Program Files\\7-Zip\\7zFM.exe'),
  prog('Ação Total Racing', 'C:\\Jogos\\Ação Total\\racing.exe', 'registry', fakeIcon(230, 80, 40)),
  prog('Blender 4.2', 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender-launcher.exe', 'startmenu', fakeIcon(240, 140, 30)),
  prog('Counter-Strike 2', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe', 'apppaths'),
  prog('Discord', 'C:\\Users\\Teste\\AppData\\Local\\Discord\\Update.exe', 'startmenu', fakeIcon(88, 101, 242), '--processStart Discord.exe'),
  prog('DOSBox-X', 'C:\\Emuladores\\DOSBox-X\\dosbox-x.exe'),
  prog('Euro Truck Simulator 2', 'C:\\Jogos\\Euro Truck Simulator 2\\bin\\win_x64\\eurotrucks2.exe', 'registry'),
  prog('Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'startmenu', fakeIcon(66, 133, 244)),
  prog('Hades', 'C:\\Jogos\\Hades\\Hades.exe', 'registry', fakeIcon(200, 30, 60)),
  prog('Minecraft Launcher', 'C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe'),
  prog('Mozilla Firefox', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'startmenu', fakeIcon(255, 113, 57)),
  prog('Notepad++', 'C:\\Program Files\\Notepad++\\notepad++.exe'),
  prog('OBS Studio', 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', 'startmenu', fakeIcon(60, 60, 70)),
  prog('RetroArch', 'D:\\Games\\RetroArch\\retroarch.exe', 'registry'),
  prog('Spotify', 'C:\\Users\\Teste\\AppData\\Roaming\\Spotify\\Spotify.exe', 'startmenu', fakeIcon(30, 215, 96)),
  prog('Visual Studio Code', 'C:\\Users\\Teste\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'),
  prog('VLC media player', 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'),
  // linhas inválidas de propósito: a tela tem de ignorá-las sem quebrar
  { name: '', exe: 'C:\\Sem nome\\x.exe', args: '', dir: '', source: 'startmenu', icon: null },
  { name: 'Sem caminho', args: '', dir: '', source: 'startmenu', icon: null },
  { name: 'Caminho errado', exe: 42, args: '', dir: '', source: 'startmenu', icon: null },
  { name: 'Biblioteca', exe: 'C:\\Windows\\lib.dll', args: '', dir: '', source: 'startmenu', icon: null },
  { name: 'Google Chrome (de novo)', exe: 'c:/program files/google/chrome/application/CHROME.EXE', args: '', dir: '', source: 'registry', icon: null },
  null,
];
const fileBase = (p) => { const n = p.slice(p.lastIndexOf('\\') + 1); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i) : n; };
const dirOfWin = (p) => p.slice(0, Math.max(0, p.lastIndexOf('\\')));
const titleCase = (t) => t.replace(/[_-]+/g, ' ').replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
/** inspectProgram de mentira: deduz tudo do texto do caminho. "naoexiste" no caminho = arquivo que não existe; atalho terminado em "-semexe" não aponta para um programa. */
function fakeInspect(p) {
  const path = String(p || '').replace(/\//g, '\\');
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!path) return { ok: false, error: 'Nenhum arquivo foi escolhido.' };
  // pasta (como o app nativo diz): sem extensão, ou filho direto de C:\Jogos ("Dr.Mario" tem cara de arquivo, mas é uma pasta)
  if (!/naoexiste/i.test(path) && !['exe', 'lnk', 'bat', 'cmd'].includes(ext) && (!ext || /^[A-Za-z]:\\Jogos\\[^\\]+$/i.test(path))) {
    return { ok: false, isFolder: true, error: 'Isso é uma pasta, e não um programa. Escolha o arquivo do programa (.exe) que fica dentro dela.' };
  }
  if (/naoexiste/i.test(path) || !ext) return { ok: false, error: 'Não encontrei esse arquivo no computador. Ele pode ter sido movido ou apagado.' };
  const base = fileBase(path);
  if (ext === 'lnk') {
    if (/-semexe$/i.test(base)) return { ok: false, error: 'Esse atalho não abre um programa (.exe). Escolha o arquivo do jogo.' };
    const target = `C:\\Jogos\\${titleCase(base)}\\${base.replace(/\s+/g, '')}.exe`;
    return { ok: true, kind: 'lnk', path: target, args: '', dir: dirOfWin(target), name: titleCase(base), product: titleCase(base), description: '', company: '', version: '1.0.0.0', icon: fakeIcon(120, 90, 200) };
  }
  if (ext === 'bat' || ext === 'cmd') return { ok: true, kind: 'bat', path, args: '', dir: dirOfWin(path), name: titleCase(base), product: '', description: '', company: '', version: '', icon: null };
  if (ext === 'exe') {
    const generic = /^(game|jogo|unity)$/i.test(base);
    return { ok: true, kind: 'exe', path, args: '', dir: dirOfWin(path), name: generic ? 'Unity' : titleCase(base), product: generic ? 'Unity' : titleCase(base), description: titleCase(base), company: 'Empresa de Teste', version: '1.0.0.0', icon: /hades|chrome|spotify/i.test(base) ? fakeIcon(200, 30, 60) : null };
  }
  return { ok: true, kind: 'other', path, args: '', dir: dirOfWin(path), name: '', product: '', description: '', company: '', version: '', icon: null };
}
function fakeCandidates(folder) {
  if (!folder) return [];
  const n = folder.slice(folder.lastIndexOf('\\') + 1);
  if (/vazia/i.test(n)) return [];
  return [{ path: `${folder}\\${n.replace(/\s+/g, '')}.exe`, name: `${n.replace(/\s+/g, '')}.exe`, size: 52428800 }];
}
async function simulate(m) {
  const delay = (ms) => new Promise((ok) => setTimeout(ok, ms));
  if (SIM.programs === 'old' && ['installedPrograms', 'pickFile', 'pickFolder', 'inspectProgram', 'droppedFiles', 'findExe'].includes(m.cmd)) return { error: 'comando desconhecido' };
  if (NATIVE_EXE && ['installedPrograms', 'inspectProgram'].includes(m.cmd)) return nativeCommand(m);   // dados reais do C#
  if (NATIVE_EXE && m.cmd === 'findExe' && SIM.findExe !== 'off') return nativeCommand(m);
  if (m.cmd === 'pickFile' && SIM.pickFilePath) return { path: SIM.pickFilePath };
  if (m.cmd === 'pickFolder' && SIM.pickFolderPath && SIM.pickFolder !== 'cancel' && SIM.pickFolder !== 'error') {
    return NATIVE_EXE ? nativeFlag(['--find-exe', SIM.pickFolderPath]) : { folder: SIM.pickFolderPath, candidates: fakeCandidates(SIM.pickFolderPath) };
  }
  if (m.cmd === 'droppedFiles' && SIM.dropPaths) return { paths: SIM.dropPaths.split('|').filter(Boolean) };
  switch (m.cmd) {
    case 'installedPrograms':
      await delay(SIM.programs === 'slow' ? 2500 : 400);
      if (SIM.programs === 'error') return { error: 'Não consegui ler a lista de programas instalados.' };
      if (SIM.programs === 'many') {   // lista grande (a tela desenha só as primeiras linhas e manda usar a busca)
        const mais = Array.from({ length: 640 }, (_, i) => prog(`Programa de teste ${String(i + 1).padStart(3, '0')}`, `C:\\Program Files\\Teste ${i + 1}\\teste${i + 1}.exe`, 'registry'));
        return { programs: [...FAKE_PROGRAMS, ...mais], scannedMs: 1800 };
      }
      return { programs: SIM.programs === 'empty' ? [] : FAKE_PROGRAMS, scannedMs: 380 };
    case 'pickFile':
      await delay(300);
      if (SIM.pickFile === 'cancel') return { cancelled: true };
      if (SIM.pickFile === 'error') return { error: 'Não consegui abrir a janela de escolha de arquivos.' };
      return { path: 'C:\\Jogos\\Hades\\Hades.exe' };
    case 'pickFolder':
      await delay(300);
      if (SIM.pickFolder === 'cancel') return { cancelled: true };
      if (SIM.pickFolder === 'error') return { error: 'Não consegui abrir a janela de escolha de pastas.' };
      if (SIM.pickFolder === 'none') return { folder: 'C:\\Jogos\\Pasta Vazia', candidates: [] };
      if (SIM.pickFolder === 'many') {
        const folder = 'C:\\Jogos\\Euro Truck Simulator 2';
        return { folder, candidates: [
          { path: `${folder}\\bin\\win_x64\\eurotrucks2.exe`, name: 'eurotrucks2.exe', size: 39845888 },
          { path: `${folder}\\bin\\win_x86\\eurotrucks2.exe`, name: 'eurotrucks2.exe', size: 31457280 },
          { path: `${folder}\\Launcher.exe`, name: 'Launcher.exe', size: 2097152 }] };
      }
      return { folder: 'C:\\Jogos\\Hades', candidates: [{ path: 'C:\\Jogos\\Hades\\Hades.exe', name: 'Hades.exe', size: 52428800 }] };
    case 'cover':   // (só para testar a capa achada sozinha: qualquer nome com "capa teste" devolve uma imagem; o resto continua sem capa)
      if (/capa teste/i.test(String(m.name || ''))) { await delay(500); return { data: fakeIcon(40, 120, 200) }; }
      return undefined;
    case 'api':   // (só para testar o erro ao salvar: o servidor "responde com erro" ao gravar um aplicativo)
      if (SIM.saveFail === 'on' && m.method === 'POST' && String(m.path).split('?')[0] === '/api/apps') return { status: 500, body: 'erro simulado' };
      return undefined;
    case 'inspectProgram': await delay(120); return fakeInspect(m.path);
    case 'findExe':   // (fora do contrato: uma pasta solta na janela; o app nativo pode ainda não ter este comando)
      if (SIM.findExe === 'off') return { error: 'comando desconhecido' };
      return { candidates: fakeCandidates(String(m.folder || '')) };
    case 'droppedFiles': {   // o SHIM manda só os nomes dos arquivos soltos (o navegador não revela o caminho)
      const names = Array.isArray(m.__files) ? m.__files.map((x) => x.name) : null;
      if (!names) return { error: 'Este ambiente não entrega o caminho dos arquivos soltos.' };
      // (o navegador não distingue pasta de arquivo: o teste marca a pasta com o tipo "x-folder")
      const folders = new Set(m.__files.filter((x) => x.type === 'x-folder').map((x) => x.name));
      return { paths: names.map((n) => (n.includes('.') && !folders.has(n) ? `C:\\Users\\Teste\\Downloads\\${n}` : `C:\\Jogos\\${n}`)) };
    }
    default: return undefined;
  }
}

async function bridge(m) {
  const sim = await simulate(m);
  if (sim !== undefined) return sim;
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
    postMessageWithAdditionalObjects(m, files) { return window.chrome.webview.postMessage({ ...m, __files: Array.from(files || []).map((f) => ({ name: f.name, size: f.size, type: f.type })) }); },
    postMessage(m) { fetch('/__bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) })
      .then((r) => r.text()).then((t) => ls.forEach((f) => f({ data: t })))
      .catch((e) => ls.forEach((f) => f({ data: JSON.stringify({ id: m.id, error: String(e) }) }))); } }; })();`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  if (url.pathname === '/__shim.js') return send(200, SHIM, MIME['.js']);
  if (url.pathname === '/__mutations') return send(200, JSON.stringify({ dry: DRY, mutations }, null, 1));
  if (url.pathname === '/__sim') {
    for (const [k, v] of url.searchParams) if (k in SIM) SIM[k] = v;
    return send(200, JSON.stringify(SIM));
  }
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
