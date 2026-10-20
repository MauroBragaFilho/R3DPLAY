// Lógica pura da escolha de programas para "Adicionar aplicativo": busca sem acento, comparação de caminhos, montar/ler o comando,
// nome sugerido, executável principal de uma pasta, arquivos soltos e criação do aplicativo a partir de um programa.
// Nada aqui toca DOM, rede nem a ponte nativa: tudo é testável com `node --test` (dev/tests/games-programs*.test.mjs).
//
// Contrato com o app nativo (comandos novos de native()):
//   installedPrograms {}          -> { programs: Program[], scannedMs }   Program = { name, exe, args, dir, source, icon }
//   pickFile { title? }           -> { cancelled: true } | { path }
//   pickFolder { title? }         -> { cancelled: true } | { folder, candidates: [{ path, name, size }] }   (candidates: do mais para o menos provável)
//   findExe { folder }            -> { folder, candidates }   (o mesmo, sem caixa: pasta solta na janela)
//   inspectProgram { path }       -> { ok: true, kind, path, args, dir, name, product, description, company, version, icon, shortcutName? } | { ok: false, error, isFolder? }
//   droppedFiles (nativeFiles)    -> { paths: string[] }
// Qualquer falha chega como { error: "mensagem em português" }.
'use strict';
import * as M from './appmodel.js';

/** Extensões que a pessoa pode escolher (o .lnk é resolvido para o .exe de destino pelo app nativo). */
export const PROGRAM_EXTS = ['exe', 'lnk', 'bat', 'cmd'];
/** O que o servidor consegue executar direto. */
export const RUN_EXTS = ['exe', 'bat', 'cmd', 'com'];
/** Limite da lista do app nativo (ele já corta em 800; aqui é só defesa). */
export const MAX_PROGRAMS = 800;
/** Quantas linhas desenhar de uma vez na lista de programas instalados (o resto aparece ao digitar na busca). */
export const MAX_ROWS = 150;

/* ---------- Caminhos do Windows ---------- */
const unquote = (s) => String(s ?? '').trim().replace(/^"+|"+$/g, '').trim();
export const isAbsolutePath = (p) => /^[A-Za-z]:[\\/]/.test(String(p || '')) || /^\\\\[^\\]/.test(String(p || ''));

/**
 * Caminho limpo (mantém maiúsculas): sem aspas, só "\", sem barras repetidas, sem "." e "..", sem barra no fim (exceto "C:\").
 * Prefixo \\?\ some. Variáveis como %USERPROFILE% ficam como estão.
 */
export function cleanPath(p) {
  let s = unquote(p).replace(/\//g, '\\');
  if (!s) return '';
  s = s.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  const lead = s.startsWith('\\\\') ? '\\\\' : s.startsWith('\\') ? '\\' : '';
  const out = [];
  for (const seg of s.slice(lead.length).split('\\')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..' && !/^[A-Za-z]:$/.test(out[out.length - 1])) out.pop(); else if (!lead && !/^[A-Za-z]:$/.test(out[0] || '')) out.push(seg); continue; }
    out.push(seg);
  }
  let r = lead + out.join('\\');
  if (/^[A-Za-z]:$/.test(r) && /^[A-Za-z]:[\\/]/.test(unquote(p))) r += '\\';   // raiz de unidade
  return r;
}
/** Chave para comparar caminhos: o Windows não diferencia maiúsculas, aceita "/" e ignora aspas e barras repetidas. */
export const pathKey = (p) => cleanPath(p).toLowerCase();
export const samePath = (a, b) => { const x = pathKey(a); return x !== '' && x === pathKey(b); };
export const fileNameOf = (p) => cleanPath(p).split('\\').pop() || '';
export function extOf(p) { const n = fileNameOf(p); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; }
export function baseNameOf(p) { const n = fileNameOf(p); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i) : n; }
/** Pasta que contém o item ('' se não houver). */
export function dirOf(p) {
  const c = cleanPath(p);
  const i = c.lastIndexOf('\\');
  if (i < 0) return '';
  if (i === 2 && /^[A-Za-z]:/.test(c)) return c.slice(0, 3);
  if (i === 0 || c.startsWith('\\\\') && i < 2) return '';
  return c.slice(0, i);
}
/** Caminho de um item dentro de uma pasta, sem a parte da pasta ("bin\win64\jogo.exe"). */
export function relativeTo(p, folder) {
  const c = cleanPath(p);
  const f = cleanPath(folder).replace(/\\$/, '');
  if (f && c.toLowerCase().startsWith(`${f.toLowerCase()}\\`)) return c.slice(f.length + 1);
  return c;
}
/** Encurta um caminho no meio para caber numa linha: "C:\…\Pasta\jogo.exe". O caminho completo deve ir no title. */
export function ellipsizePath(p, max = 64) {
  const c = cleanPath(p);
  if (c.length <= max) return c;
  const segs = c.split('\\');
  const head = /^[A-Za-z]:$/.test(segs[0]) ? `${segs[0]}\\` : '';
  const budget = max - head.length - 2;   // espaço de "…\"
  const tail = [];
  let len = 0;
  for (let i = segs.length - 1; i >= (head ? 1 : 0); i--) {
    const add = segs[i].length + (tail.length ? 1 : 0);
    if (len + add > budget) break;
    tail.unshift(segs[i]);
    len += add;
  }
  if (!tail.length) return `${head}…\\…${segs[segs.length - 1].slice(-Math.max(4, budget - 1))}`;
  return `${head}…\\${tail.join('\\')}`;
}
/** Corta um texto qualquer (comando, link) no fim: "steam://rungameid/22…". Diferente de ellipsizePath, não mexe nas barras nem nas aspas. */
export function ellipsizeText(t, max = 90) {
  const s = M.cleanText(t);
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
/** "850 KB", "1,2 MB", "3,4 GB" (vírgula decimal, como no Brasil). */
export function humanSize(bytes) {
  let n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  const v = n >= 10 || i === 0 ? String(Math.round(n)) : n.toFixed(1).replace('.', ',');
  return `${v} ${u[i]}`;
}

/* ---------- $ nos comandos ----------
   O servidor expande $(VAR) e transforma "$$" em "$" ao carregar o apps.json. Um caminho de verdade nunca pode ser interpretado:
   todo "$" vindo de um programa é gravado como "$$" e desfeito ao ler o comando de volta. */
export const escapeDollar = (s) => String(s ?? '').replace(/\$/g, '$$$$');
export const unescapeDollar = (s) => String(s ?? '').replace(/\$\$/g, '$');

/* ---------- Comando (campo "cmd") ---------- */
const UNQUOTED_PATH = /^((?:[A-Za-z]:|\\\\)[^"|<>?*]*?\.(?:exe|bat|cmd|com|lnk))(?=\s|$)/i;
/**
 * Lê o comando: { exe, args, kind }. kind = 'empty' | 'path' (caminho completo ou %VAR%\…) | 'url' (steam://…) | 'command' (cmd, powershell, notepad…).
 * Entende aspas, argumentos, caminho sem aspas com espaços ("C:\Program Files\X\x.exe -a"), "…exe"/flag sem espaço e aspas sem fechar.
 * exe e args voltam sem o "$$" de proteção (ver escapeDollar).
 */
export function parseCommand(cmd) {
  const s = M.cleanText(cmd);
  if (!s) return { exe: '', args: '', kind: 'empty' };
  let exe;
  let rest;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end === -1) { exe = s.slice(1); rest = ''; } else { exe = s.slice(1, end); rest = s.slice(end + 1); }
  } else {
    const m = s.match(UNQUOTED_PATH);
    if (m) { exe = m[1]; rest = s.slice(m[1].length); } else {
      const sp = s.search(/\s/);
      exe = sp === -1 ? s : s.slice(0, sp);
      rest = sp === -1 ? '' : s.slice(sp);
    }
  }
  exe = unescapeDollar(exe.trim());
  const args = unescapeDollar(rest.trim());
  let kind = 'command';
  if (!exe) kind = 'empty';
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(exe)) kind = 'url';
  else if (isAbsolutePath(exe) || /^%[^%]+%[\\/]/.test(exe)) kind = 'path';
  return { exe, args, kind };
}
/** Monta o comando do aplicativo: caminho SEMPRE entre aspas, depois os argumentos ("C:\Pasta (x86)\jogo.exe" -janela). */
export function buildCommand(exe, args = '') {
  const e = escapeDollar(String(exe ?? '').replace(/"/g, '').trim());
  if (!e) return '';
  const a = escapeDollar(M.cleanText(args));
  return a ? `"${e}" ${a}` : `"${e}"`;
}
/** Programa que um comando abre, se for um caminho de arquivo (senão null). */
export function exeOfCommand(cmd) {
  const p = parseCommand(cmd);
  return p.kind === 'path' ? p.exe : null;
}

/* ---------- Programas já usados pela lista ---------- */
/** Argumentos para comparar: sem espaços repetidos nem maiúsculas. */
const argsKey = (a) => M.cleanText(a).replace(/\s+/g, ' ').toLowerCase();
/**
 * Chave de um programa: o .exe MAIS os argumentos. O mesmo .exe aparece várias vezes na lista do Windows com argumentos diferentes
 * (OneNote e "Sticky Notes" usam o ONENOTE.EXE; Database Compare e Spreadsheet Compare, o AppVLP.exe; vários jogos, o mesmo launcher):
 * são programas diferentes, e cada um precisa da sua linha na lista.
 */
export const programKey = (exe, args = '') => `${pathKey(exe)}|${argsKey(args)}`;
function eachCommand(apps, fn) {
  for (const a of Array.isArray(apps) ? apps : []) {
    if (!M.isObj(a)) continue;
    const cmds = [a.cmd, ...(Array.isArray(a.detached) ? a.detached : [])];
    for (const c of cmds) {
      if (typeof c !== 'string') continue;
      const p = parseCommand(c);
      if (p.kind !== 'path' || p.exe.includes('$(')) continue;
      fn(a, p);
    }
  }
}
/** Mapa pathKey -> nome do primeiro aplicativo que abre esse programa (pelo comando ou pelos comandos desvinculados), com quaisquer argumentos. */
export function usedExes(apps) {
  const map = new Map();
  eachCommand(apps, (a, p) => {
    const k = pathKey(p.exe);
    if (k && !map.has(k)) map.set(k, String(a.name || 'um aplicativo'));
  });
  return map;
}
/** Como usedExes, mas a chave é programKey (exe + argumentos). */
export function usedPrograms(apps) {
  const map = new Map();
  eachCommand(apps, (a, p) => {
    const k = pathKey(p.exe) && programKey(p.exe, p.args);
    if (k && !map.has(k)) map.set(k, String(a.name || 'um aplicativo'));
  });
  return map;
}
/**
 * Nome do aplicativo (diferente de exceptUuid) que já abre este programa, ou ''.
 * Sem `args` (undefined) compara só o .exe; com `args` (mesmo vazio) compara o .exe e os argumentos.
 */
export function findAppUsingExe(apps, exe, exceptUuid = '', args = undefined) {
  const k = pathKey(exe);
  if (!k) return '';
  const others = (Array.isArray(apps) ? apps : []).filter((a) => !exceptUuid || a?.uuid !== exceptUuid);
  return (args === undefined ? usedExes(others).get(k) : usedPrograms(others).get(programKey(exe, args))) || '';
}
/** Acrescenta used/usedBy a cada programa da lista (compara o .exe e os argumentos, sem diferenciar maiúsculas, "/" e aspas). */
export function markUsed(programs, apps) {
  const used = usedPrograms(apps);
  return programs.map((p) => {
    const by = used.get(programKey(p.exe, p.args));
    return { ...p, used: by !== undefined, usedBy: by ?? '' };
  });
}

/* ---------- Lista do app nativo ---------- */
const ICON_RE = /^[A-Za-z0-9+/=]+$/;
/** Aceita só PNG em base64 de tamanho razoável; qualquer outra coisa vira null. */
export const cleanIcon = (v) => (typeof v === 'string' && v.length > 20 && v.length < 300000 && ICON_RE.test(v) ? v : null);
/**
 * Defesa contra linhas inválidas da lista: descarta o que não tem nome ou caminho de programa, repete o mesmo programa (mesmo .exe E mesmos
 * argumentos: fica o primeiro; o mesmo .exe com argumentos diferentes são programas diferentes), limpa ícone e pasta, corta em MAX_PROGRAMS.
 * Devolve programas no formato { name, exe, args, dir, source, icon }.
 */
export function sanitizePrograms(list) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    if (!M.isObj(p) || typeof p.name !== 'string' || typeof p.exe !== 'string') continue;
    const name = M.cleanText(p.name);
    const exe = cleanPath(p.exe);
    if (!name || !exe || !isAbsolutePath(exe) || !RUN_EXTS.includes(extOf(exe))) continue;
    const args = typeof p.args === 'string' ? M.cleanText(p.args) : '';
    const key = programKey(exe, args);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name, exe,
      args,
      dir: typeof p.dir === 'string' && cleanPath(p.dir) ? cleanPath(p.dir) : dirOf(exe),
      source: typeof p.source === 'string' ? p.source : '',
      icon: cleanIcon(p.icon),
    });
    if (out.length >= MAX_PROGRAMS) break;
  }
  return out;
}

/* ---------- Busca ---------- */
/**
 * Filtra por qualquer parte do nome (ou do nome do arquivo), sem diferenciar acento nem maiúsculas; várias palavras = todas precisam aparecer.
 * Quem começa com o que foi digitado vem primeiro; fora isso mantém a ordem original (já alfabética).
 */
export function searchPrograms(programs, query) {
  const q = M.norm(query);
  if (!q) return [...programs];
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];
  programs.forEach((p, i) => {
    const name = M.norm(p.name);
    const file = M.norm(baseNameOf(p.exe));
    let score;
    if (tokens.every((t) => name.includes(t))) {
      if (name.startsWith(q)) score = 0;
      else if (name.split(/[\s\-_.()]+/).some((w) => w.startsWith(tokens[0]))) score = 1;
      else score = name.includes(q) ? 2 : 3;
    } else if (tokens.every((t) => name.includes(t) || file.includes(t))) score = 4;
    else return;
    scored.push([score, i, p]);
  });
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

/* ---------- Nome sugerido ---------- */
const GENERIC_NAMES = new Set(['application', 'aplicativo', 'game', 'jogo', 'launcher', 'unity', 'unity player', 'unreal engine', 'unrealengine', 'ue4', 'ue5',
  'setup', 'installer', 'instalador', 'win32 application', 'program', 'programa', 'app', 'client', 'cliente', 'main', 'start', 'run', 'shell',
  'microsoft windows', 'windows', 'sistema operacional microsoft windows', 'microsoft windows operating system', 'godot engine', 'electron', 'nw js', 'exe', 'executable',
  // nomes de pastas de compilação (a pasta do .exe quase nunca é o nome do jogo)
  'bin', 'binaries', 'win', 'x64', 'x86', 'release', 'debug', 'build', 'dist', 'output', 'program files', 'programas', 'jogos', 'games',
  // pastas que só guardam coisas de outros programas (a lista do app nativo, ContainerFolders, tem as mesmas): nunca são o nome de um programa
  'program files x86', 'system32', 'syswow64', 'downloads', 'transferencias', 'desktop', 'area de trabalho', 'documents', 'documentos', 'my documents', 'tools', 'ferramentas',
  'content', 'microsoft', 'local', 'locallow', 'roaming', 'appdata', 'users', 'usuarios', 'public', 'temp', 'tmp', 'common', 'steamapps', 'apps', 'applications', 'aplicativos',
  'server', 'servers']);
/** Nomes que, para um ATALHO do Menu Iniciar, são nomes de verdade (quem criou o atalho escolheu o nome): o editor da Unity, por exemplo. */
const PRODUCT_NAMES = new Set(['unity', 'unity player', 'unreal engine', 'unrealengine', 'ue4', 'ue5', 'godot engine', 'electron', 'nw js']);
// Pastas de compilação e de plataforma, em qualquer combinação: Win64, Win32, x86_64, WindowsNoEditor, WindowsClient, Binaries\Win64, Shipping, Retail…
// (o nome já chega sem acento, em minúsculas e sem pontuação: "x86_64" vira "x86 64")
const BUILD_FOLDER = /^(?:(?:win(?:dows)?|bin(?:aries)?|linux|mac(?:os)?)(?: ?(?:no ?editor|client|server))?|x ?86|x ?64|amd ?64|shipping|retail|development|release|debug)(?: ?(?:32|64|x ?86|x ?64|86 ?64))*(?: (?:shipping|retail|development|release|debug))*$/;
const genericKey = (name) => M.norm(name).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
/** Nome que não diz nada ("Unity", "Application", "game", "Win64"…), ou sem letras, ou parecendo um código (ou um nome de assembly: "Application.NDI.Bridge.UI"). */
export function isGenericName(name) {
  const raw = M.norm(name).trim();
  const n = genericKey(name);
  return n.length < 2 || GENERIC_NAMES.has(n) || BUILD_FOLDER.test(n) || !/\p{L}/u.test(n) || /^[0-9a-f-]{20,}$/.test(raw)
    || /^[^\s.]+(?:\.[^\s.]+){2,}$/.test(raw) || /^application\.[^\s.]+$/.test(raw);
}
/** Como isGenericName, mas para o nome de um atalho: "Unity" e "Godot Engine" são nomes de verdade (a pessoa vê esse nome no Menu Iniciar). */
export const isGenericShortcutName = (name) => !PRODUCT_NAMES.has(genericKey(name)) && isGenericName(name);
/** Quantos parênteses/colchetes estão abertos na posição idx do texto. */
function parenDepth(s, idx) {
  let d = 0;
  for (let i = 0; i < idx; i++) { const c = s[i]; if (c === '(' || c === '[') d++; else if ((c === ')' || c === ']') && d > 0) d--; }
  return d;
}
/**
 * Limpa um nome vindo de programa: sem ®/™, versão ("v1.2", "4.2"), "x64"/"(64-bit)", "-Win64-Shipping" e "Launcher" sobrando (quando resta algo).
 * fromFile (nome de arquivo ou pasta): troca "_" por espaço, separa "HorizonZeroDawn" em palavras e põe a inicial em maiúscula se estiver tudo minúsculo.
 */
export function cleanProgramName(raw, { fromFile = false } = {}) {
  // ("Â" solto: alguns .exe da Microsoft trazem "MicrosoftÂ® WindowsÂ®" no recurso de versão, que ficou com a codificação errada)
  let s = M.cleanText(raw).normalize('NFC').replace(/Â(?=[®™©\s]|$)/g, '').replace(/[®™©]/g, '').replace(/\.(?:exe|lnk|bat|cmd)$/i, '');
  if (fromFile) s = s.replace(/_+/g, ' ');
  s = s.replace(/[(\[]\s*(?:x?(?:86|64)|(?:32|64)[\s-]?bit|win(?:32|64)|v?\d+(?:\.\d+)*|beta|release)\s*[)\]]/gi, ' ');
  // versão e arquitetura só saem FORA de parênteses: "IDLE (Python 3.12 64-bit)" não pode virar "IDLE (Python 64-bit)"
  const outside = (re, fn) => { s = s.replace(re, (...a) => (parenDepth(s, a.at(-2)) > 0 ? a[0] : fn(...a))); };
  outside(/(^|[\s\-_])v(?:er(?:s(?:[aã]o|ion))?\.?\s*)?\d+(?:\.\d+)*(?=$|[\s\-_])/gi, (m, a) => `${a} `);
  outside(/(^|\s)\d+(?:\.\d+)+(?=$|[\s\-_])/g, (m, a) => `${a} `);
  outside(/[\s\-_.]+(?:win(?:32|64)|x86[\s\-_]?64|x64|x86|amd64|64[\s-]?bit|32[\s-]?bit)(?=$|[\s\-_.])/gi, () => ' ');
  s = s.replace(/[\s\-_.]+(?:shipping|retail)$/i, '');
  s = s.replace(/\s+/g, ' ').replace(/^[\s\-_.:,]+|[\s\-_.:,]+$/g, '');
  const semLauncher = s.replace(/[\s\-_.]+(?:game\s+)?launcher$/i, '').replace(/^[\s\-_.:,]+|[\s\-_.:,]+$/g, '');
  if (semLauncher !== s && semLauncher.length >= 2 && /\p{L}/u.test(semLauncher)) s = semLauncher;
  if (fromFile && s) {
    if (!/[\s\-]/.test(s) && /^[A-Z][a-z]+(?:[A-Z][a-z]*\d*|\d+)+$/.test(s) && /[a-z][A-Z]/.test(s)) s = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2');
    if (s === s.toLowerCase() && /\p{L}/u.test(s)) s = s.replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }
  return s;
}
const FOLDER_NOISE = /^(?:v?\d+|desktop|app|application|client|win32|win64|x64|x86|portable|release|beta|stable)*$/;
/**
 * Escolhe o nome do aplicativo. Ordem: nome sugerido pelo app nativo (`name`: ele já escolheu entre produto e descrição, o que mais lembra o arquivo:
 * WINWORD.EXE é "Microsoft Word" e não "Microsoft Office") > nome do produto > descrição > nome da pasta > o que sobrou do nome/descrição > nome do arquivo,
 * sempre pulando o que não diz nada ("Unity", "Application", "System32", "Application.NDI.Bridge.UI"…). Nome ou descrição IGUAL ao nome do arquivo é palpite
 * fraco ("eurotrucks2"): a pasta ("Euro Truck Simulator 2") vem antes, a não ser que a pasta seja só o nome com enfeite ("Stremio-5").
 * Se o nome e o produto têm as mesmas letras ("Ho Yo Play" e "HoYoPlay"), vale a grafia do produto. Se tudo for genérico, usa o primeiro que não esteja vazio.
 * Pronto para o campo "Nome" (sem "$(" quebrado).
 */
export function suggestName({ name, product, description, folder, file } = {}) {
  const fileKey = alnum(file);
  const clean = (raw, fromFile = false) => cleanProgramName(raw, { fromFile });
  const [p, n, d, f, fl] = [clean(product), clean(name), clean(description), clean(folder, true), clean(file, true)];
  const good = (x) => (x && !isGenericName(x) ? x : '');
  const strong = (x) => (good(x) && !(fileKey && alnum(x) === fileKey) ? x : '');
  // pasta que é só o nome do programa com enfeite de versão ou de sistema ("Stremio-5", "Stremio Desktop", "Hades x64"): não acrescenta nada ao nome.
  // ("Hades II" acrescenta: o "II" faz parte do nome do jogo.)
  const folderAdds = (x) => {
    if (!good(f)) return false;
    const a = alnum(x);
    return !(a.length >= 4 && alnum(f).includes(a) && FOLDER_NOISE.test(alnum(f).replace(a, '')));
  };
  const named = strong(n) && good(p) && alnum(n) === alnum(p) ? p : strong(n);
  const pick = [named, good(p), strong(d), folderAdds(n || d) ? f : '', good(n), good(d), good(f), good(fl)].find(Boolean) || [p, n, d, f, fl].find(Boolean) || '';
  return M.safeInterpolation(pick.slice(0, 80).trim());
}

/* ---------- Programa (o que a interface guarda) ---------- */
/**
 * Nome de um atalho do Menu Iniciar (o que a pessoa vê na lista) pronto para o campo "Nome", ou '' se não serve ("Atalho", "Win64"…).
 * O nome que a pessoa (ou o instalador) deu ao atalho manda: "Word" continua "Word" (o produto do .exe é "Microsoft Office"), "Unity" continua "Unity".
 */
function shortcutName(raw, fromFile = false) {
  const s = cleanProgramName(raw, { fromFile });
  return s && !isGenericShortcutName(s) ? M.safeInterpolation(s.slice(0, 80).trim()) : '';
}
/** Programa da lista de instalados -> programa da interface. */
export function programFromList(p) {
  const exe = cleanPath(p.exe);
  return {
    exe, args: M.cleanText(p.args), dir: cleanPath(p.dir) || dirOf(exe), icon: cleanIcon(p.icon), kind: extOf(exe) === 'exe' ? 'exe' : 'bat',
    name: shortcutName(p.name) || suggestName({ product: p.name, file: baseNameOf(exe), folder: fileNameOf(dirOf(exe)) }), fileName: fileNameOf(exe),   // o nome do atalho do Menu Iniciar manda
  };
}
/**
 * Resposta de inspectProgram -> programa da interface. hints.folderName = nome da pasta que a pessoa escolheu (usado se o nome do programa for genérico).
 * Atalho (.lnk): o nome do atalho (info.shortcutName; info.name já vem igual a ele) manda sobre o produto do .exe de destino. Arquivo .bat: o nome do arquivo.
 */
export function programFromInspect(info, { folderName = '' } = {}) {
  const exe = cleanPath(info.path);
  const dir = cleanPath(info.dir) || dirOf(exe);
  const kind = ['exe', 'lnk', 'bat'].includes(info.kind) ? info.kind : 'exe';
  const own = kind === 'lnk' && M.cleanText(info.shortcutName) ? shortcutName(info.name || info.shortcutName)
    : kind === 'bat' ? shortcutName(info.name, true) : '';
  return {
    exe, args: M.cleanText(info.args), dir, icon: cleanIcon(info.icon), kind,
    name: own || suggestName({ name: info.name, product: info.product, description: info.description, folder: folderName || fileNameOf(dir), file: baseNameOf(exe) }),
    fileName: fileNameOf(exe),
  };
}
/** Campos do aplicativo que dependem do programa: comando (caminho entre aspas + argumentos) e pasta de trabalho. */
export function programFields(program) {
  const exe = cleanPath(program.exe ?? program.path);
  const dir = cleanPath(program.dir) || dirOf(exe);
  const out = { cmd: buildCommand(exe, program.args) };
  if (dir) out['working-dir'] = escapeDollar(dir);
  return out;
}
/** O que o R3D PLAY liga em todo programa escolhido: tela virtual no tamanho do celular e fechar o programa ao sair da transmissão. */
export const PROGRAM_POLICY = Object.freeze({ 'virtual-display': true, 'terminate-on-pause': true });
/** Aplicativo novo a partir de um programa: política acima + comando e pasta do programa + padrões do schema. */
export function appFromProgram(program, schema, { name } = {}) {
  const app = M.newApp(schema);
  Object.assign(app, PROGRAM_POLICY, programFields(program));
  app.name = M.safeInterpolation(M.cleanText(name ?? program.name));
  return M.normalizeApp(app, schema);
}
/** Valores que o R3D PLAY define sozinho (referência do selo "N personalizados" ao editar um aplicativo existente). */
export function policyBaseline(schema) {
  return M.normalizeApp({ ...M.newApp(schema), ...PROGRAM_POLICY }, schema);
}
const NOT_COUNTED = new Set(['uuid', 'name', 'image-path', 'cmd', 'working-dir']);
/**
 * Quantas opções avançadas estão diferentes do que o R3D PLAY define sozinho (base). Nome, capa, comando e pasta não contam:
 * aparecem fora das opções avançadas (ou são o próprio programa).
 */
export function customOptionCount(app, schema, { platform = 'windows', base = null } = {}) {
  const cur = M.normalizeApp(app, schema);
  const ref = M.normalizeApp(base ?? M.newApp(schema), schema);
  let n = 0;
  for (const f of schema.fields) {
    if (NOT_COUNTED.has(f.key) || !M.fieldVisible(f, cur, platform)) continue;
    if (!M.deepEqual(cur[f.key], ref[f.key])) n++;
  }
  return n;
}

/* ---------- Executáveis de uma pasta ---------- */
const MAINTENANCE = /(launcher|config|setup|install|unins|crash|redist|helper|updat|patch|benchmark|editor|server|dedicated|anticheat|easyanti|vc_?redist|dxsetup|report|bootstrap|cef|webhelper)/i;
const alnum = (s) => M.norm(s).replace(/[^a-z0-9]/g, '');
/**
 * Ordena os executáveis de uma pasta do mais para o menos provável de ser o jogo.
 * Pontua: nome parecido com o da pasta, nome de manutenção (launcher, config, crash…), tamanho e profundidade. Mantém a ordem original no empate.
 * trustOrder: a lista já vem ordenada pelo app nativo (candidates do pickFolder/findExe: "a mais provável primeiro", com as regras dele de
 * ferramentas, desinstaladores e pastas fundas): a ordem é mantida e a pontuação só decide `confident`. Com dados reais, reordenar pela
 * pontuação daqui colocava ferramentas na frente do jogo (Half-Life 2: elementviewer.exe no lugar de hl2.exe).
 * Devolve { list, recommended, confident }: recommended = o primeiro; confident = ele é claramente o melhor (não é só um palpite).
 */
export function rankCandidates(candidates, { folder = '', trustOrder = false } = {}) {
  const fk = alnum(fileNameOf(folder));
  const rows = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => M.isObj(c) && typeof c.path === 'string' && c.path.trim())
    .map((c, i) => {
      const path = cleanPath(c.path);
      const base = alnum(baseNameOf(path));
      let score = 0;
      if (fk && base) {
        if (base === fk) score += 100;
        else if (base.length >= 3 && fk.length >= 3 && (fk.includes(base) || base.includes(fk))) score += 60;
        else if (fk.slice(0, 4) && base.startsWith(fk.slice(0, 4))) score += 30;
      }
      if (MAINTENANCE.test(fileNameOf(path))) score -= 60;
      const size = Number(c.size) > 0 ? Number(c.size) : 0;
      score += Math.min(30, Math.log2(size / 1048576 + 1) * 3);
      if (/(?:^|[\\_.-])(?:win_?)?x?64(?:$|[\\_.-])/i.test(relativeTo(path, folder))) score += 2;   // na dúvida, a versão de 64 bits
      if (folder) score -= 3 * Math.max(0, relativeTo(path, folder).split('\\').length - 1);
      return { ...c, path, name: typeof c.name === 'string' && c.name ? c.name : fileNameOf(path), size, score, _i: i };
    });
  if (!trustOrder) rows.sort((a, b) => b.score - a.score || a._i - b._i);
  const list = rows.map(({ _i, ...c }) => c);
  const top = list[0];
  const rest = list.slice(1).reduce((m, c) => Math.max(m, c.score), -Infinity);   // (sem reordenar, o melhor dos outros pode não ser o segundo)
  const confident = !!top && top.score >= 60 && (list.length === 1 || top.score - rest >= 25);
  return { list, recommended: top || null, confident };
}
/** O executável principal quando ele é claramente um só; null se for preciso perguntar à pessoa. */
export function pickMainExe(candidates, opts) {
  const r = rankCandidates(candidates, opts);
  return r.confident ? r.recommended : null;
}
/** Texto da linha de um candidato: nome sem extensão. */
export const candidateTitle = (c) => baseNameOf(c.path || c.name) || String(c.name || '');

/* ---------- Arquivos soltos ---------- */
// Extensões de arquivos comuns que nunca são programa nem pasta (imagem, documento, áudio, vídeo, compactado, biblioteca, configuração…).
const COMMON_FILE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'tif', 'tiff', 'psd', 'txt', 'md', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'pdf', 'odt', 'csv', 'log', 'ini', 'cfg', 'conf', 'json', 'xml', 'yaml', 'yml', 'dat', 'db', 'sav', 'bin', 'dll', 'sys', 'msi', 'zip', 'rar', '7z', 'tar', 'gz', 'iso', 'img',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'ttf', 'otf', 'js', 'ts', 'py', 'html', 'htm', 'css', 'cs', 'cpp', 'jar', 'apk', 'lua', 'ps1', 'vbs']);
/**
 * 'exe' | 'lnk' | 'bat' | 'url' (atalho de loja) | 'file' (arquivo comum, que não serve) | 'folder' (sem extensão: provavelmente uma pasta)
 * | 'unknown' (tem um sufixo curto que não conhecemos: "Dr.Mario" tanto pode ser uma pasta quanto um arquivo) | 'invalid'.
 * Quem recebe 'folder' ou 'unknown' deve confirmar com a ponte (inspectProgram diz isFolder): só o texto do caminho não basta.
 */
export function classifyPath(p) {
  const c = cleanPath(p);
  if (!c) return 'invalid';
  const ext = extOf(c);
  if (ext === 'exe' || ext === 'lnk') return ext;
  if (ext === 'bat' || ext === 'cmd') return 'bat';
  if (ext === 'url') return 'url';
  if (COMMON_FILE_EXTS.has(ext)) return 'file';
  if (!ext || /^\d+$/.test(ext) || ext.length > 5 || /[^a-z0-9]/.test(ext)) return 'folder';
  return 'unknown';
}
export const DROP_MESSAGES = {
  url: 'Esse atalho abre o jogo por uma loja (como a Steam). Use "Detectar jogos" para o R3D PLAY encontrar sozinho os jogos da Steam, Epic, GOG e Ubisoft.',
  file: 'Esse tipo de arquivo não abre como programa. Escolha um arquivo .exe, um atalho (.lnk), um arquivo .bat ou a pasta do jogo.',
  unknown: 'Não reconheci o que foi solto como programa nem como pasta. Escolha um arquivo .exe, um atalho (.lnk), um arquivo .bat ou a pasta do jogo.',
  invalid: 'Não consegui ler o que foi solto. Tente de novo ou use "Escolher o arquivo do jogo".',
};
/**
 * Escolhe o que usar entre os caminhos soltos: o primeiro programa/atalho/.bat; senão a primeira pasta (provável); senão o primeiro item incerto.
 * { ok: true, path, kind, extra } (extra = quantos itens ficaram de fora; kind 'folder' e 'unknown' ainda precisam ser confirmados com judgeDropped)
 * ou { ok: false, kind, message }.
 */
export function pickDropped(paths) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && cleanPath(p));
  if (!list.length) return { ok: false, kind: 'invalid', message: DROP_MESSAGES.invalid };
  const kinds = list.map(classifyPath);
  let i = kinds.findIndex((k) => ['exe', 'lnk', 'bat'].includes(k));
  if (i < 0) i = kinds.indexOf('folder');
  if (i < 0) i = kinds.indexOf('unknown');
  if (i < 0) { const k = kinds.includes('url') ? 'url' : 'file'; return { ok: false, kind: k, message: DROP_MESSAGES[k] }; }
  return { ok: true, path: cleanPath(list[i]), kind: kinds[i], extra: list.length - 1 };
}
/**
 * O que um item solto de tipo incerto ('folder' ou 'unknown' de classifyPath) realmente é, pela resposta do inspectProgram:
 * 'folder' (isFolder: true) | 'program' (leu como programa) | 'other' (arquivo que não abre como programa) | 'error' (não existe ou não foi possível ler).
 * Se a ponte não soube responder (app antigo), o palpite do texto vale para 'folder'; 'unknown' vira 'other' (melhor recusar que adivinhar).
 */
export function judgeDropped(guess, r) {
  if (r?.isFolder === true) return 'folder';
  if (r?.ok === true) return r.kind === 'other' || typeof r.path !== 'string' || !r.path.trim() ? 'other' : 'program';
  if (r?.ok === false) return 'error';
  return guess === 'folder' ? 'folder' : 'other';
}

/* ---------- Jogo de loja escolhido pelo .exe ---------- */
/**
 * A loja de onde o .exe parece vir ('steam' | 'epic' | 'gog' | 'ubisoft'), pela pasta em que está instalado; '' se não parece de nenhuma.
 * Um jogo aberto direto pelo arquivo costuma falhar sem a loja aberta: "Detectar jogos" o liga pela loja, do jeito certo.
 */
export function storeOfPath(p) {
  const c = `\\${cleanPath(p).toLowerCase()}`;
  if (c.includes('\\steamapps\\common\\')) return 'steam';
  if (c.includes('\\epic games\\') && !c.includes('\\epic games\\launcher\\')) return 'epic';
  if (c.includes('\\gog games\\') || c.includes('\\gog galaxy\\games\\')) return 'gog';
  if (c.includes('\\ubisoft game launcher\\games\\')) return 'ubisoft';
  return '';
}

/** O arrasto traz arquivos do Windows (e não, por exemplo, uma capa da própria grade sendo reordenada)? */
export const hasFiles = (e) => Array.from(e?.dataTransfer?.types || []).includes('Files');

/* ---------- Erros da ponte ---------- */
const TECHNICAL = /Exception|System\.|Could not|Object reference|Access to the path|denied|\bnull\b|Unable to|Invalid |Illegal|\bat \w+\./i;
/** Mensagem da ponte pronta para a pessoa: comando desconhecido -> versão antiga; texto técnico em inglês -> fallback. */
export function describeBridgeError(r, fallback) {
  const e = r && typeof r.error === 'string' ? r.error.trim() : '';
  if (!e) return fallback;
  if (/comando desconhecido/i.test(e)) return 'Esta versão do aplicativo ainda não tem esta função. Atualize o R3D PLAY ou use "Preencher tudo manualmente".';
  return TECHNICAL.test(e) ? fallback : e;
}
