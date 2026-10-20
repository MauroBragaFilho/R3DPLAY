// Confere, com o Node, a ponte nativa de programas do R3D PLAY (ProgramScanner.cs / FilePicker.cs) rodando o ApolloConfig.exe COMPILADO
// só com as flags de teste (nenhuma janela abre, nada é executado, nada é gravado fora da pasta temporária de teste):
//
//   dotnet build -c Release -o "%TEMP%\r3d-cs-build"        (a partir de tools/ApolloConfig)
//   node tools/ApolloConfig/dev/check-programs.mjs [caminho\ApolloConfig.exe] [--json saida.json] [--no-deep] [--wide]
//
// 1. --programs: formato do contrato, todo .exe existe, sem duplicados, nenhum nome/.exe de lixo (as MESMAS regras do C#, lidas de
//    ProgramScanner.cs entre as marcas PADROES-*), pasta de trabalho que não muda (nada de app-X.Y.Z, Menu Iniciar ou Área de Trabalho),
//    ícones PNG 32x32 válidos, ordem pt-BR, tempo medido.
// 2. (a menos que --no-deep) --inspect e --find-exe com arquivos reais e sintéticos (atalho, .bat, pasta, falso .exe, inexistente, \\?\, rede),
//    atalhos de teste varridos pela pasta extra R3D_PROGRAMS_EXTRA_LNK_DIR (Squirrel, pasta de versão, mesmo .exe com argumentos diferentes,
//    atalho para a rede que não pode atrasar a lista) e a heurística de pasta (raiz antes de subpasta, sem repetidos, game\bin\win64).
// --wide: confere também o inspectProgram de TODOS os programas da lista (versão só com números, texto sem caractere de controle, nome útil).
// Sai com código diferente de zero se houver qualquer violação.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CS_SOURCE = path.resolve(HERE, '..', 'ProgramScanner.cs');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const optValue = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--json');
const EXE = positional[0] || process.env.R3D_APOLLOCONFIG_EXE || path.join(os.tmpdir(), 'r3d-cs-build', 'ApolloConfig.exe');

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/* ---------- Regras de lixo: lidas do C# ---------- */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function readBlock(src, id) {
  const m = src.match(new RegExp(`//\\s*PADROES-${id}-INICIO([\\s\\S]*?)//\\s*PADROES-${id}-FIM`));
  if (!m) throw new Error(`bloco PADROES-${id} não encontrado em ProgramScanner.cs`);
  const rules = [];
  for (const line of m[1].split(/\r?\n/)) {
    const r = line.match(/^\s*@"((?:[^"]|"")*)"\s*,?\s*(?:\/\/.*)?$/);
    if (r) rules.push(r[1].replace(/""/g, '"'));
  }
  if (!rules.length) throw new Error(`bloco PADROES-${id} vazio`);
  return rules;
}
const src = fs.readFileSync(CS_SOURCE, 'utf8');
const nameRules = readBlock(src, 'NOME').map((r) => ({ r, rx: new RegExp(r, 'i') }));
const exeRules = readBlock(src, 'EXE').map((r) => ({ r, rx: new RegExp(r, 'i') }));
const pathFragments = readBlock(src, 'CAMINHO').map((f) => fold(f));
const WINDIR = fold(process.env.SystemRoot || 'C:\\Windows').replace(/[\\/]+$/, '') + '\\';
// Regras extras, escritas aqui de propósito (conferência independente do C#): nada disto pode aparecer na lista.
const HARD_NAME = /desinstal|uninstall|unins\d{3}|redistributable|vc_?redist|visual c\+\+|\.net (runtime|sdk|desktop)|directx|readme|leia-?me/i;
const HARD_EXE = /^(unins\d*|uninst\w*|setup\w*|vc_?redist\w*|dxsetup|crashpad_handler|update|updater)$/i;

const isJunkName = (name) => nameRules.find(({ rx }) => rx.test(fold(name)))?.r;
const isJunkExe = (exe) => exeRules.find(({ rx }) => rx.test(fold(path.win32.basename(exe).replace(/\.exe$/i, ''))))?.r;
const junkPath = (p) => {
  const f = fold(p).replace(/\//g, '\\');
  if (f.startsWith(WINDIR)) return 'pasta do Windows';
  return pathFragments.find((frag) => f.includes(frag));
};
const normArgs = (a) => String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const related = (a, b) => { const x = fold(a).trim(); const y = fold(b).trim(); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
// "Update.exe --processStart App.exe" é o comando do próprio atalho de um app Squirrel (continua valendo depois das atualizações): não é o atualizador.
const isSquirrelCommand = (exe, a) => /^update\.exe$/i.test(path.win32.basename(exe)) && /--process-?start/i.test(a ?? '');

/* ---------- Bateria das regras (não precisa do exe): o que TEM que passar e o que TEM que ser barrado ---------- */
const MUST_PASS_NAMES = [
  'Steam', 'Discord', 'OBS Studio', 'Epic Games Launcher', 'Rockstar Games Launcher', 'Notepad++', '7-Zip File Manager', 'VLC media player', 'Google Chrome',
  'Microsoft Edge', 'Microsoft Teams', 'Tomb Raider: Anniversary', 'The Sims 4', 'League of Legends', 'VALORANT', 'Riot Client', 'Ubisoft Connect', 'GOG GALAXY',
  'Heroic Games Launcher', 'Playnite', 'Minecraft Launcher', 'Cyberpunk 2077', 'Elden Ring', 'Adobe Photoshop 2026', 'Visual Studio Code', 'Intel® Graphics Software',
  'NVIDIA App', 'NVIDIA GeForce Experience', 'Radmin VPN', 'WinRAR', 'Wireshark', 'Windows Media Player Legacy', 'Stream Deck', 'Unity Hub', 'Android Studio',
  'Excel', 'Word', 'Battle.net', 'Paint.NET', 'Bethesda.net Launcher', 'Ghostrunner', 'Hades II', 'Counter-Strike 2', 'FNAF Help Wanted',
  // nomes de jogos que contêm palavras de lixo e não podem ser barrados:
  'Crash Bandicoot N. Sane Trilogy', 'Crash Team Racing Nitro-Fueled', 'Wizard of Legend', 'Bus Driver', 'Driver San Francisco', 'Helldivers 2', 'Microsoft Flight Simulator',
];
const MUST_BLOCK_NAMES = [
  'Uninstall HoYoPlay', 'Desinstalar a Tradução', 'Desinstalação HoYoPlay', 'Microsoft Visual C++ 2015-2022 Redistributable (x64)', 'Microsoft .NET Runtime - 8.0.22 (x64)',
  'Microsoft Windows Desktop Runtime - 8.0.22 (x64)', 'NVIDIA Graphics Driver 617.42', 'Intel(R) Wireless Bluetooth(R) Driver', 'Windows Software Development Kit - Windows 10.0.26100.7705',
  'DirectX Runtime', 'Ajuda do WinRAR', 'Manual do Console RAR', 'Leia-me', 'ReadMe', 'License Agreement', 'Release Notes', 'Documentation for Desktop Apps', 'EA app Updater',
  'Verificar Atualizações', 'Report a Problem with Unity', 'EA Error Reporter', 'Java Auto Updater', 'Python 3.12 Module Docs (64-bit)', 'Python 3.12 Manuals (64-bit)',
  'Reparar instalação', 'Microsoft Edge WebView2 Runtime', 'Epic Online Services', 'Adobe Genuine Service', 'Setup Wizard', 'Windows SDK Desktop Headers x64',
  'Microsoft ASP.NET Core 8.0.22 - Shared Framework (x64)', 'NVIDIA Telemetry Client', 'Corsair iCUE VHID Drivers v3.0.88.9', 'Microsoft Visual C++ 2022 X64 Minimum Runtime - 14.51.36247',
  'Qualcomm USB Drivers For Windows', 'spacedesk Windows DRIVER', 'Configurar Java', 'Sobre o Java', 'Microsoft Silverlight', 'Java(TM) SE Development Kit 21.0.10 (64-bit)',
  'Blackmagic RAW Common Components', 'ViGEm Bus Driver', 'Battlelog Web Plugins', 'Microsoft Update Health Tools', 'Visual Studio Installer', 'Microsoft Teams Machine-Wide Installer', 'NVIDIA PhysX System Software',
];
const MUST_PASS_EXES = [
  'Steam.exe', 'Discord.exe', 'obs64.exe', 'Code.exe', 'chrome.exe', 'firefox.exe', 'FL64.exe', 'CrashBandicootNSaneTrilogy.exe', 'Ghost.exe', 'GTA5_Enhanced.exe',
  'RiotClientServices.exe', 'EpicGamesLauncher.exe', 'Launcher.exe', 'LauncherPatcher.exe', 'cs2.exe', 'hl2.exe', 'Battle.net.exe', 'RocketLeague.exe', 'Terraria.exe',
  'Spotify.exe', 'notepad++.exe', '7zFM.exe', 'vlc.exe', 'python.exe', 'Hades.exe', 'Game-Win64-Shipping.exe',
];
const MUST_BLOCK_EXES = [
  'unins000.exe', 'uninstall.exe', 'Uninstall.exe', 'uninst.exe', 'setup.exe', 'Setup_x64.exe', 'vc_redist.x64.exe', 'vcredist_x86.exe', 'DXSETUP.exe', 'oalinst.exe',
  'dotNetFx40_Full_setup.exe', 'UnityCrashHandler64.exe', 'CrashReportClient.exe', 'crashpad_handler.exe', 'Update.exe', 'GoogleUpdate.exe', 'MicrosoftEdgeUpdate.exe',
  'EAUpdater.exe', 'ErrorReporter.exe', 'steamwebhelper.exe', 'notification_helper.exe', 'EasyAntiCheat_Setup.exe', 'BEService.exe', 'UE4PrereqSetup_x64.exe',
  'DSAServiceHelper.exe', 'msedgewebview2.exe', 'cmd.exe', 'rundll32.exe', 'windowsdesktop-runtime-8.0.22-win-x64.exe', 'SonarHost.exe', 'OneDrive.Sync.Service.exe',
  'sunshine.exe', 'ApolloConfig.exe', 'javaws.exe', 'SAMPUninstall.exe', 'OpenCut-Uninstall.exe',
];
for (const n of MUST_PASS_NAMES) { const r = isJunkName(n); if (r) fail(`regra de nome barrou um nome legítimo: ${JSON.stringify(n)} (regra ${r})`); }
for (const n of MUST_BLOCK_NAMES) if (!isJunkName(n)) fail(`regra de nome NÃO barrou o lixo: ${JSON.stringify(n)}`);
for (const e of MUST_PASS_EXES) { const r = isJunkExe(e); if (r) fail(`regra de .exe barrou um programa legítimo: ${e} (regra ${r})`); }
for (const e of MUST_BLOCK_EXES) if (!isJunkExe(e)) fail(`regra de .exe NÃO barrou o lixo: ${e}`);
for (const p of ['C:\\Windows\\System32\\notepad.exe', 'C:\\WINDOWS\\SysWOW64\\x.exe', 'C:\\Program Files\\Common Files\\Foo\\a.exe', 'C:\\ProgramData\\Package Cache\\{x}\\setup.exe',
  'C:\\Program Files\\WindowsApps\\X\\x.exe', 'D:\\Jogo\\_CommonRedist\\vcredist\\x.exe']) if (!junkPath(p)) fail(`regra de caminho NÃO barrou: ${p}`);
for (const p of ['C:\\Program Files\\Steam\\Steam.exe', 'D:\\Games\\Windows Game\\a.exe', 'C:\\Windows.old\\a.exe', 'D:\\Games\\Crash Bandicoot\\Crash.exe']) if (junkPath(p)) fail(`regra de caminho barrou um caminho legítimo: ${p} (${junkPath(p)})`);

/* ---------- Execução do exe ---------- */
function run(argv, env = {}, timeout = 90000) {
  const t0 = Date.now();
  const r = spawnSync(EXE, argv, { encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, ...env } });
  return { ms: Date.now() - t0, status: r.status, error: r.error, signal: r.signal };
}
function readJson(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) fail(`${path.basename(file)}: tem BOM (precisa ser UTF-8 sem BOM)`);
  return JSON.parse(buf.toString('utf8'));
}
function pngInfo(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { error: 'não é base64 puro (sem prefixo data:)' };
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 33 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { error: 'não é PNG' };
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return { error: 'PNG sem IHDR' };
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length };
}
/** Pastas do Windows que mudam ou não dizem nada sobre o programa (não podem ser a pasta de trabalho guardada). */
function volatileFolders() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Environment]::GetFolderPath('Programs'); [Environment]::GetFolderPath('CommonPrograms'); [Environment]::GetFolderPath('StartMenu'); [Environment]::GetFolderPath('CommonStartMenu'); [Environment]::GetFolderPath('DesktopDirectory'); [Environment]::GetFolderPath('CommonDesktopDirectory')"],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return (r.stdout || '').split(/\r?\n/).map((s) => s.trim().replace(/[\\/]+$/, '')).filter(Boolean);
}

if (!fs.existsSync(EXE)) {
  console.error(`ApolloConfig.exe não encontrado em ${EXE}\nCompile antes: dotnet build -c Release -o "%TEMP%\\r3d-cs-build"`);
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r3d-check-programs-'));
let testRoot = '';
const VOLATILE = volatileFolders();
const lower = (s) => String(s).toLowerCase();

/** Confere cada item do contrato de installedPrograms. Devolve as contagens por fonte e de ícones. */
function checkPrograms(programs, tag) {
  const seen = new Map();
  const bySource = {};
  let withIcon = 0;
  let tinyIcons = 0;
  const SOURCES = new Set(['startmenu', 'registry', 'apppaths']);
  programs.forEach((p, i) => {
    const where = `${tag}#${i} ${JSON.stringify(p.name)}`;
    const keys = Object.keys(p).sort().join(',');
    if (keys !== 'args,dir,exe,icon,name,source') fail(`${where}: campos inesperados (${keys})`);
    if (typeof p.name !== 'string' || !p.name.trim() || p.name !== p.name.trim() || /[\u0000-\u001f]/.test(p.name)) fail(`${where}: nome vazio, com espaços sobrando ou com caractere de controle`);
    if (typeof p.exe !== 'string' || !/^[A-Za-z]:\\/.test(p.exe) || !/\.exe$/i.test(p.exe)) fail(`${where}: exe não é um caminho completo terminado em .exe (${p.exe})`);
    else {
      if (!fs.existsSync(p.exe)) fail(`${where}: o exe não existe (${p.exe})`);
      const k = path.win32.normalize(p.exe).toLowerCase();
      const same = seen.get(k) ?? [];
      for (const o of same) {
        if (normArgs(o.args) === normArgs(p.args)) fail(`${where}: duplicado de ${JSON.stringify(o.name)} (mesmo exe e mesmos argumentos: ${p.exe})`);
        else if (related(o.name, p.name)) fail(`${where}: mesmo exe de ${JSON.stringify(o.name)} com nome parecido (era para ser um só)`);
      }
      same.push(p);
      seen.set(k, same);
    }
    if (typeof p.args !== 'string') fail(`${where}: args não é texto`);
    if (typeof p.dir !== 'string' || !p.dir) fail(`${where}: dir vazio`);
    else {
      if (!fs.existsSync(p.dir) || !fs.statSync(p.dir).isDirectory()) fail(`${where}: a pasta de trabalho não existe (${p.dir})`);
      if (/\\app-\d+(\.\d+)+/i.test(p.dir) && !/\\app-\d/i.test(p.exe)) fail(`${where}: pasta de trabalho de versão (muda a cada atualização): ${p.dir}`);
      const d = lower(p.dir.replace(/[\\/]+$/, ''));
      const v = VOLATILE.find((f) => d === lower(f) || d.startsWith(lower(f) + '\\'));
      if (v) fail(`${where}: pasta de trabalho dentro do Menu Iniciar/Área de Trabalho (${p.dir})`);
    }
    if (!SOURCES.has(p.source)) fail(`${where}: source inválida (${p.source})`);
    bySource[p.source] = (bySource[p.source] || 0) + 1;
    // lixo
    const nr = isJunkName(p.name); if (nr) fail(`${where}: nome de lixo (regra ${nr})`);
    if (HARD_NAME.test(p.name)) fail(`${where}: nome de lixo (regra independente)`);
    if (!isSquirrelCommand(p.exe, p.args)) {
      const er = isJunkExe(p.exe); if (er) fail(`${where}: exe de lixo ${path.win32.basename(p.exe)} (regra ${er})`);
      if (HARD_EXE.test(path.win32.basename(p.exe, '.exe'))) fail(`${where}: exe de lixo ${path.win32.basename(p.exe)} (regra independente)`);
    }
    const jp = junkPath(p.exe); if (jp) fail(`${where}: exe em lugar de lixo (${jp}): ${p.exe}`);
    // ícone
    if (p.icon !== null) {
      const info = pngInfo(p.icon);
      if (info.error) fail(`${where}: ícone inválido, ${info.error}`);
      else if (info.w !== 32 || info.h !== 32) fail(`${where}: ícone ${info.w}x${info.h} (precisa ser 32x32)`);
      else { withIcon++; if (info.bytes < 200) tinyIcons++; }
    }
  });
  return { bySource, withIcon, tinyIcons };
}

try {
  /* ========== 1. --programs ========== */
  const outFile = optValue('--json') || path.join(tmp, 'programs.json');
  const res = run(['--programs', outFile]);
  if (res.error || res.status !== 0) fail(`--programs terminou com erro (status ${res.status}, ${res.error?.message ?? res.signal ?? 'sem detalhes'})`);
  if (!fs.existsSync(outFile)) { fail('--programs não gerou o arquivo'); throw new Error('sem saída'); }
  const data = readJson(outFile);
  if (data.error) fail(`--programs devolveu erro: ${data.error}`);
  const programs = Array.isArray(data.programs) ? data.programs : (fail('"programs" não é uma lista'), []);
  if (typeof data.scannedMs !== 'number') fail('"scannedMs" não é número');
  if (programs.length > 800) fail(`mais de 800 programas (${programs.length})`);
  if (programs.length === 0) fail('nenhum programa encontrado (impossível neste PC)');

  const { bySource, withIcon, tinyIcons } = checkPrograms(programs, '');
  if (programs.length && withIcon / programs.length < 0.6) warn(`só ${withIcon} de ${programs.length} programas têm ícone`);
  if (tinyIcons > programs.length * 0.1) warn(`${tinyIcons} ícones minúsculos (talvez transparentes)`);

  // ordem pt-BR
  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', ignorePunctuation: true });
  let inversions = 0;
  for (let i = 1; i < programs.length; i++) if (collator.compare(programs[i - 1].name, programs[i].name) > 0) inversions++;
  if (inversions > Math.max(3, programs.length * 0.05)) fail(`lista fora de ordem alfabética pt-BR (${inversions} inversões)`);
  else if (inversions) warn(`${inversions} pequena(s) diferença(s) de ordem entre o NLS do Windows e o ICU do Node (normal com hífens/símbolos)`);

  // tempo
  if (res.ms > 25000 || data.scannedMs > 15000) fail(`varredura lenta demais: ${data.scannedMs} ms (processo ${res.ms} ms)`);
  else if (data.scannedMs > 3000) warn(`varredura acima do alvo de 3 s: ${data.scannedMs} ms (provável cache frio; rode de novo)`);

  /* ========== 2. verificações a fundo ========== */
  if (!flag('--no-deep')) {
    const inspect = (p, env, timeout = 30000) => {
      const o = path.join(tmp, `inspect-${Math.random().toString(36).slice(2)}.json`);
      const r = run(['--inspect', p, o], env, timeout);
      if (r.error || r.status !== 0 || !fs.existsSync(o)) { fail(`--inspect ${p}: falhou (${r.error?.message ?? r.status})`); return null; }
      const j = readJson(o);
      j.__ms = r.ms;
      return j;
    };
    const findExe = (folder, timeout = 30000) => {
      const o = path.join(tmp, `find-${Math.random().toString(36).slice(2)}.json`);
      const r = run(['--find-exe', folder, o], {}, timeout);
      if (r.error || r.status !== 0 || !fs.existsSync(o)) { fail(`--find-exe ${folder}: falhou (${r.error?.message ?? r.status})`); return null; }
      const j = readJson(o);
      j.__ms = r.ms;
      return j;
    };
    const KINDS = new Set(['exe', 'lnk', 'bat', 'other']);
    const noControl = (s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(s);
    const checkOk = (label, j, kind) => {
      if (!j) return false;
      if (j.ok !== true) { fail(`${label}: esperava ok:true, veio ${JSON.stringify(j)}`); return false; }
      for (const k of ['kind', 'path', 'args', 'dir', 'name', 'product', 'description', 'company', 'version']) if (typeof j[k] !== 'string') fail(`${label}: campo ${k} ausente ou não é texto`);
      if (!KINDS.has(j.kind)) fail(`${label}: kind inválido (${j.kind})`);
      if (kind && j.kind !== kind) fail(`${label}: kind ${j.kind}, esperado ${kind}`);
      if (!j.name?.trim()) fail(`${label}: nome sugerido vazio`);
      for (const k of ['name', 'product', 'description', 'company', 'version']) if (typeof j[k] === 'string' && !noControl(j[k])) fail(`${label}: ${k} com caractere de controle (${JSON.stringify(j[k])})`);
      if (typeof j.version === 'string' && j.version && !/^\d+(\.\d+)*$/.test(j.version)) fail(`${label}: version não é só números (${JSON.stringify(j.version)})`);
      if (/^\\\\[?.]\\/.test(j.path ?? '')) fail(`${label}: path ainda tem o prefixo \\\\?\\ (${j.path})`);
      if (j.icon !== null && (pngInfo(j.icon).w !== 32 || pngInfo(j.icon).h !== 32)) fail(`${label}: ícone inválido`);
      return true;
    };
    const checkFail = (label, j, hint) => {
      if (!j || j.ok !== false || typeof j.error !== 'string' || !j.error.trim()) { fail(`${label}: esperava ok:false com error, veio ${JSON.stringify(j)}`); return null; }
      if (hint && !hint.test(j.error)) fail(`${label}: mensagem sem "${hint}": ${j.error}`);
      if (!/[a-zà-ú]/i.test(j.error) || /exception|object reference/i.test(j.error)) fail(`${label}: mensagem não parece em português amigável: ${j.error}`);
      return j;
    };

    // amostra espalhada de programas reais (ou todos, com --wide)
    const sample = flag('--wide') ? programs : programs.filter((_, i) => i % Math.max(1, Math.floor(programs.length / 6)) === 0).slice(0, 6);
    for (const p of sample) {
      const j = inspect(p.exe);
      if (checkOk(`inspect ${p.name}`, j, 'exe')) {
        if (j.path.toLowerCase() !== p.exe.toLowerCase()) fail(`inspect ${p.name}: path ${j.path} difere do exe`);
        if (j.dir.toLowerCase() !== path.win32.dirname(p.exe).toLowerCase()) fail(`inspect ${p.name}: dir ${j.dir} difere da pasta do exe`);
      }
      if (flag('--wide')) continue;
      const f = findExe(path.win32.dirname(p.exe));
      if (f) {
        if (!Array.isArray(f.candidates)) fail(`find-exe ${p.name}: candidates não é lista`);
        else {
          const names = new Set();
          for (const c of f.candidates) {
            if (typeof c.path !== 'string' || !fs.existsSync(c.path)) fail(`find-exe ${p.name}: candidato inexistente ${c.path}`);
            else if (c.name !== path.win32.basename(c.path) || typeof c.size !== 'number' || c.size !== fs.statSync(c.path).size) fail(`find-exe ${p.name}: name/size incoerentes em ${c.path}`);
            if (isJunkExe(c.path)) fail(`find-exe ${p.name}: candidato de lixo ${c.path}`);
            if (names.has(lower(c.name))) fail(`find-exe ${p.name}: ${c.name} repetido na lista`);
            names.add(lower(c.name));
          }
        }
        if (f.folder.toLowerCase() !== path.win32.dirname(p.exe).toLowerCase()) fail(`find-exe ${p.name}: folder diferente do pedido`);
      }
    }
    // nomes sugeridos de programas reais do Office, quando existem neste PC (o ProductName é "Microsoft Office" em todos)
    const office = ['C:\\Program Files\\Microsoft Office\\root\\Office16', 'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16'].find((d) => fs.existsSync(path.join(d, 'WINWORD.EXE')));
    if (office) {
      for (const [file, expected] of [['WINWORD.EXE', /word/i], ['EXCEL.EXE', /excel/i], ['POWERPNT.EXE', /powerpoint/i]]) {
        if (!fs.existsSync(path.join(office, file))) continue;
        const j = inspect(path.join(office, file));
        if (j?.ok && !expected.test(j.name)) fail(`inspect ${file}: nome sugerido ${JSON.stringify(j.name)} em vez do nome do programa`);
      }
    }

    testRoot = path.join(HERE, '.tmp-programs-test');
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    const mz = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);   // "programa" falso: só o começo "MZ" (serve para a conferência de .exe)
    const sized = (n) => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(n)]);
    // O Windows se recusa a criar atalho para um .exe com cabeçalho quebrado: nos testes de atalho o alvo é uma CÓPIA de um .exe de verdade
    // (só é lido, nunca executado).
    const realExe = fs.readFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'));

    // casos sintéticos de inspectProgram
    checkFail('inspect inexistente', inspect(path.join(testRoot, 'nao-existe.exe')), /encontrei/i);
    const folderCase = checkFail('inspect pasta', inspect(testRoot), /pasta/i);
    if (folderCase && folderCase.isFolder !== true) fail('inspect pasta: faltou isFolder:true');
    checkFail('inspect vazio', inspect(' '), null);
    fs.writeFileSync(path.join(testRoot, 'falso.exe'), 'isto nao e um programa');
    checkFail('inspect falso .exe', inspect(path.join(testRoot, 'falso.exe')), /não parece/i);
    fs.writeFileSync(path.join(testRoot, 'iniciar.bat'), '@echo off\r\n');
    const bat = inspect(path.join(testRoot, 'iniciar.bat'));
    if (checkOk('inspect .bat', bat, 'bat')) {
      if (bat.path.toLowerCase() !== path.join(testRoot, 'iniciar.bat').toLowerCase()) fail('inspect .bat: path precisa ser o próprio arquivo');
      if (bat.dir.toLowerCase() !== testRoot.toLowerCase()) fail('inspect .bat: dir precisa ser a pasta do arquivo');
      if (bat.name.toLowerCase() === 'iniciar') fail('inspect .bat: nome genérico "iniciar" devia virar o nome da pasta');
    }
    fs.writeFileSync(path.join(testRoot, 'notas.txt'), 'oi');
    checkOk('inspect outro (.txt)', inspect(path.join(testRoot, 'notas.txt')), 'other');
    // caminho com acentos, espaços e um .exe mínimo
    const accented = path.join(testRoot, 'Jogo Açaí Ñandú');
    fs.mkdirSync(accented);
    fs.writeFileSync(path.join(accented, 'Meu Jogo.exe'), realExe);
    const acc = inspect(path.join(accented, 'Meu Jogo.exe'));
    if (checkOk('inspect com acentos', acc, 'exe') && acc.path.toLowerCase() !== path.join(accented, 'Meu Jogo.exe').toLowerCase()) fail(`inspect com acentos: path ${acc.path}`);
    if (acc?.ok && !acc.product && !acc.description) warn('inspect: o .exe de teste (cópia do where.exe) veio sem ProductName/FileDescription');
    const found = findExe(accented);
    if (found && !(found.candidates.length === 1 && found.candidates[0].name === 'Meu Jogo.exe')) fail(`find-exe com acentos: ${JSON.stringify(found)}`);

    // caminhos com prefixo \\?\ (e dispositivos) não chegam à interface assim
    const sysNotepad = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
    if (fs.existsSync(sysNotepad)) {
      const pre = inspect('\\\\?\\' + sysNotepad);
      if (checkOk('inspect \\\\?\\', pre, 'exe') && pre.path.toLowerCase() !== sysNotepad.toLowerCase()) fail(`inspect \\\\?\\: path ${pre.path} devia ser ${sysNotepad}`);
      if (pre?.ok && /^\\\\[?.]\\/.test(pre.dir)) fail(`inspect \\\\?\\: dir com prefixo (${pre.dir})`);
      const prefol = findExe('\\\\?\\' + path.join(testRoot, 'Hollow Knight'));
      if (prefol && prefol.candidates.some((c) => /^\\\\[?.]\\/.test(c.path))) fail('find-exe \\\\?\\: candidato com prefixo');
    }
    checkFail('inspect \\\\.\\pipe', inspect('\\\\.\\pipe\\r3d-teste'), null);
    checkFail('inspect \\\\?\\Volume', inspect('\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\x.exe'), null);

    // nome sugerido para .exe sem ProductName/FileDescription: o nome do arquivo (ou da pasta, se o arquivo tem nome genérico); nunca Downloads/Jogos/WindowsApps
    const nameCases = [
      ['Downloads\\Celeste.exe', 'Celeste'],
      ['Games\\Hollow Knight.exe', 'Hollow Knight'],
      ['Jogos\\hollow_knight.exe', 'Hollow Knight'],
      ['Stremio-5\\stremio.exe', 'Stremio'],
      ['Roblox\\Content\\RobloxPlayerBeta.exe', 'Roblox Player Beta'],
      ['Meu Jogo Novo\\start.exe', 'Meu Jogo Novo'],
      ['Meu Jogo X\\bin\\x64\\game.exe', 'Meu Jogo X'],
      ['Epic\\EpicGamesLauncher.exe', 'Epic Games Launcher'],
      ['Microsoft\\WindowsApps\\wt.exe', 'wt'],
    ];
    for (const [rel, expected] of nameCases) {
      const f = path.join(testRoot, 'nomes', rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, mz);
      const j = inspect(f);
      if (checkOk(`inspect nome ${rel}`, j, 'exe') && j.name !== expected) fail(`inspect nome ${rel}: ${JSON.stringify(j.name)} em vez de ${JSON.stringify(expected)}`);
    }

    // heurística de pasta: nome parecido > maior tamanho; lixo fica de fora; subpastas até o nível 2
    const game = path.join(testRoot, 'Hollow Knight');
    for (const d of ['', 'bin', 'bin\\x64', 'bin\\x64\\fundo', '_CommonRedist\\vcredist']) fs.mkdirSync(path.join(game, d), { recursive: true });
    fs.writeFileSync(path.join(game, 'hollow_knight.exe'), sized(1000));
    fs.writeFileSync(path.join(game, 'zzz_outro_enorme.exe'), sized(50000));
    fs.writeFileSync(path.join(game, 'unins000.exe'), sized(90000));
    fs.writeFileSync(path.join(game, 'UnityCrashHandler64.exe'), sized(90000));
    fs.writeFileSync(path.join(game, 'DXSETUP.exe'), sized(90000));
    fs.writeFileSync(path.join(game, '_CommonRedist', 'vcredist', 'vc_redist.x64.exe'), sized(90000));
    fs.writeFileSync(path.join(game, 'bin', 'x64', 'ferramenta_grande.exe'), sized(70000));
    fs.writeFileSync(path.join(game, 'bin', 'x64', 'fundo', 'nivel3.exe'), sized(99000));
    const fe = findExe(game);
    if (fe) {
      const names = fe.candidates.map((c) => c.name);
      if (names[0] !== 'hollow_knight.exe') fail(`find-exe: o de nome parecido devia vir primeiro (veio ${names.join(', ')})`);
      if (names[1] !== 'zzz_outro_enorme.exe') fail(`find-exe: depois do parecido vem o da raiz, antes do de subpasta (veio ${names.join(', ')})`);
      for (const bad of ['unins000.exe', 'UnityCrashHandler64.exe', 'DXSETUP.exe', 'vc_redist.x64.exe', 'nivel3.exe']) if (names.includes(bad)) fail(`find-exe: ${bad} não devia aparecer`);
      if (!names.includes('ferramenta_grande.exe')) fail('find-exe: faltou o .exe do nível 2 (bin\\x64)');
    }
    // jogo cujo .exe é pequeno e fica na raiz, com 12 ferramentas grandes em bin\ (estilo Half-Life 2): a raiz vem primeiro; nomes repetidos entram uma vez
    const hl = path.join(testRoot, 'Half-Life 2');
    for (const d of ['bin', 'bin\\a', 'bin\\b']) fs.mkdirSync(path.join(hl, d), { recursive: true });
    fs.writeFileSync(path.join(hl, 'hl2.exe'), sized(1000));
    for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(hl, 'bin', `ferramenta${i}.exe`), sized(90000 + i));
    fs.writeFileSync(path.join(hl, 'bin', 'a', 'studiomdl.exe'), sized(95000));
    fs.writeFileSync(path.join(hl, 'bin', 'b', 'studiomdl.exe'), sized(96000));
    fs.writeFileSync(path.join(hl, 'bin', 'STUDIOMDL.exe'), sized(97000));
    const hlf = findExe(hl);
    if (hlf) {
      const names = hlf.candidates.map((c) => c.name);
      if (names[0] !== 'hl2.exe') fail(`find-exe: o .exe pequeno da raiz devia vir antes das ferramentas grandes de bin\\ (veio ${names.join(', ')})`);
      const lows = names.map(lower);
      if (new Set(lows).size !== lows.length) fail(`find-exe: nome repetido na lista (${names.join(', ')})`);
    }
    // .exe fundo (Source 2: game\bin\win64\cs2.exe; Unreal: Jogo\Binaries\Win64), sem nada na raiz
    const cs = path.join(testRoot, 'Counter-Strike Global Offensive');
    fs.mkdirSync(path.join(cs, 'game', 'bin', 'win64'), { recursive: true });
    fs.writeFileSync(path.join(cs, 'game', 'bin', 'win64', 'cs2.exe'), sized(5000));
    const csf = findExe(cs);
    if (csf && !csf.candidates.some((c) => c.name === 'cs2.exe')) fail(`find-exe: não achou game\\bin\\win64\\cs2.exe (${JSON.stringify(csf.candidates.map((c) => c.name))})`);
    const ue = path.join(testRoot, 'Meu Jogo UE');
    fs.mkdirSync(path.join(ue, 'MeuJogo', 'Binaries', 'Win64'), { recursive: true });
    fs.writeFileSync(path.join(ue, 'MeuJogo', 'Binaries', 'Win64', 'MeuJogo-Win64-Shipping.exe'), sized(8000));
    const uef = findExe(ue);
    if (uef && !uef.candidates.some((c) => c.name === 'MeuJogo-Win64-Shipping.exe')) fail(`find-exe: não achou MeuJogo\\Binaries\\Win64 (${JSON.stringify(uef.candidates.map((c) => c.name))})`);
    const none = findExe(path.join(testRoot, 'pasta que nao existe'));
    if (none && (!Array.isArray(none.candidates) || none.candidates.length !== 0)) fail('find-exe: pasta inexistente devia dar candidates []');

    // atalhos (.lnk) criados com o WScript.Shell do Windows
    const mkLink = (lnk, target, argsText = '', workdir = '', timeout = 30000) => {
      const q = (s) => s.replace(/'/g, "''");
      const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${q(lnk)}'); $s.TargetPath='${q(target)}'; $s.Arguments='${q(argsText)}'; if ('${q(workdir)}') { $s.WorkingDirectory='${q(workdir)}' }; $s.Save()`;
      const enc = Buffer.from(ps, 'utf16le').toString('base64');   // -EncodedCommand: sem problema com acentos nem aspas
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true, timeout });
      if (r.status !== 0) fail(`não consegui criar o atalho de teste ${lnk}: ${r.stderr}`);
    };
    const target = path.join(accented, 'Meu Jogo.exe');
    mkLink(path.join(testRoot, 'Atalho do Jogo.lnk'), target, '-windowed -w 1080', accented);
    const lnk = inspect(path.join(testRoot, 'Atalho do Jogo.lnk'));
    if (checkOk('inspect .lnk', lnk, 'lnk')) {
      if (lnk.path.toLowerCase() !== target.toLowerCase()) fail(`inspect .lnk: path precisa ser o .exe de destino (veio ${lnk.path})`);
      if (lnk.args !== '-windowed -w 1080') fail(`inspect .lnk: args ${JSON.stringify(lnk.args)}`);
      if (lnk.dir.toLowerCase() !== accented.toLowerCase()) fail(`inspect .lnk: dir ${lnk.dir}`);
      if (lnk.name !== 'Atalho do Jogo' || lnk.shortcutName !== 'Atalho do Jogo') fail(`inspect .lnk: o nome devia ser o do atalho (veio ${JSON.stringify(lnk.name)} / ${JSON.stringify(lnk.shortcutName)})`);
    }
    mkLink(path.join(testRoot, 'Quebrado.lnk'), path.join(testRoot, 'sumiu', 'Sumiu.exe'));
    checkFail('inspect .lnk quebrado', inspect(path.join(testRoot, 'Quebrado.lnk')), /quebrado|não existe|nao existe/i);
    mkLink(path.join(testRoot, 'ParaTexto.lnk'), path.join(testRoot, 'notas.txt'));
    checkFail('inspect .lnk para .txt', inspect(path.join(testRoot, 'ParaTexto.lnk')), /não é um programa|\.exe/i);
    mkLink(path.join(testRoot, 'ParaPasta.lnk'), accented);
    checkFail('inspect .lnk para pasta', inspect(path.join(testRoot, 'ParaPasta.lnk')), /pasta/i);

    // nome do atalho: o que a pessoa vê no Windows ("Hades - Atalho" vira "Hades"), e não o ProductName do programa de destino
    for (const [file, expected] of [['Servidor Minecraft.lnk', 'Servidor Minecraft'], ['Hades - Atalho.lnk', 'Hades'], ['Atalho para Celeste.lnk', 'Celeste'], ['Jogo - Shortcut.lnk', 'Jogo']]) {
      mkLink(path.join(testRoot, file), target, '', accented);
      const j = inspect(path.join(testRoot, file));
      if (checkOk(`inspect nome do atalho ${file}`, j, 'lnk') && (j.name !== expected || j.shortcutName !== expected)) fail(`inspect nome do atalho ${file}: ${JSON.stringify(j.name)} / ${JSON.stringify(j.shortcutName)} em vez de ${JSON.stringify(expected)}`);
    }
    mkLink(path.join(testRoot, 'Atalho.lnk'), target, '', accented);
    const generic = inspect(path.join(testRoot, 'Atalho.lnk'));
    if (checkOk('inspect atalho genérico', generic, 'lnk') && /^atalho$/i.test(generic.name)) fail('inspect atalho genérico: o nome "Atalho" não ajuda ninguém');

    // pasta de trabalho: a de versão (app-X.Y.Z), a do Menu Iniciar e a Área de Trabalho não servem; uma pasta comum do jogo continua
    const stubDir = path.join(testRoot, 'sq2', 'Stub');
    fs.mkdirSync(path.join(stubDir, 'app-1.2.3'), { recursive: true });
    fs.writeFileSync(path.join(stubDir, 'Stub.exe'), realExe);
    fs.writeFileSync(path.join(stubDir, 'app-1.2.3', 'Stub.exe'), realExe);
    mkLink(path.join(testRoot, 'Stub Versao.lnk'), path.join(stubDir, 'Stub.exe'), '', path.join(stubDir, 'app-1.2.3'));
    const sv = inspect(path.join(testRoot, 'Stub Versao.lnk'));
    if (checkOk('inspect pasta de versão', sv, 'lnk') && sv.dir.toLowerCase() !== stubDir.toLowerCase()) fail(`inspect pasta de versão: dir ${sv.dir} devia ser ${stubDir}`);
    const startFolder = VOLATILE[0];
    if (startFolder) {
      mkLink(path.join(testRoot, 'Menu Iniciar.lnk'), target, '', startFolder);
      const mi = inspect(path.join(testRoot, 'Menu Iniciar.lnk'));
      if (checkOk('inspect pasta do Menu Iniciar', mi, 'lnk') && mi.dir.toLowerCase() !== accented.toLowerCase()) fail(`inspect pasta do Menu Iniciar: dir ${mi.dir} devia ser a pasta do .exe`);
    }
    const deskFolder = VOLATILE[4];
    if (deskFolder) {
      mkLink(path.join(testRoot, 'Area de Trabalho.lnk'), target, '', deskFolder);
      const ad = inspect(path.join(testRoot, 'Area de Trabalho.lnk'));
      if (checkOk('inspect pasta da Área de Trabalho', ad, 'lnk') && ad.dir.toLowerCase() !== accented.toLowerCase()) fail(`inspect pasta da Área de Trabalho: dir ${ad.dir} devia ser a pasta do .exe`);
    }

    // Squirrel: "Update.exe --processStart Foo.exe". Com o Foo.exe fixo na raiz, vale ele; sem ele, vale o comando do próprio atalho
    // (Update.exe + argumentos), que continua funcionando depois das atualizações. Nunca a pasta de versão (app-*), apagada na atualização.
    const sq = path.join(testRoot, 'sq', 'Foo');
    for (const d of ['', 'app-1.2.0', 'app-1.10.0', 'app-1.9.9']) fs.mkdirSync(path.join(sq, d), { recursive: true });
    fs.writeFileSync(path.join(sq, 'Update.exe'), realExe);
    for (const d of ['app-1.2.0', 'app-1.10.0', 'app-1.9.9']) fs.writeFileSync(path.join(sq, d, 'Foo.exe'), realExe);
    const sqBar = path.join(testRoot, 'sq', 'Bar');
    for (const d of ['', 'app-3.0.0']) fs.mkdirSync(path.join(sqBar, d), { recursive: true });
    fs.writeFileSync(path.join(sqBar, 'Update.exe'), realExe);
    fs.writeFileSync(path.join(sqBar, 'Bar.exe'), realExe);
    fs.writeFileSync(path.join(sqBar, 'app-3.0.0', 'Bar.exe'), realExe);
    const lnkDir = path.join(testRoot, 'menu'); fs.mkdirSync(lnkDir);
    mkLink(path.join(lnkDir, 'Foo Squirrel.lnk'), path.join(sq, 'Update.exe'), '--processStart Foo.exe', path.join(sq, 'app-1.10.0'));
    mkLink(path.join(lnkDir, 'Bar Squirrel.lnk'), path.join(sqBar, 'Update.exe'), '--processStart Bar.exe', path.join(sqBar, 'app-3.0.0'));
    const sqInspect = inspect(path.join(lnkDir, 'Foo Squirrel.lnk'));
    if (checkOk('inspect squirrel', sqInspect, 'lnk')) {
      if (sqInspect.path.toLowerCase() !== path.join(sq, 'Update.exe').toLowerCase() || sqInspect.args !== '--processStart Foo.exe') fail(`inspect squirrel: devia manter Update.exe --processStart Foo.exe (veio ${sqInspect.path} ${JSON.stringify(sqInspect.args)})`);
      if (sqInspect.dir.toLowerCase() !== sq.toLowerCase()) fail(`inspect squirrel: dir ${sqInspect.dir} devia ser a raiz ${sq}`);
    }
    const barInspect = inspect(path.join(lnkDir, 'Bar Squirrel.lnk'));
    if (checkOk('inspect squirrel com Bar.exe na raiz', barInspect, 'lnk')) {
      if (barInspect.path.toLowerCase() !== path.join(sqBar, 'Bar.exe').toLowerCase() || barInspect.args !== '') fail(`inspect squirrel com Bar.exe na raiz: devia usar ${path.join(sqBar, 'Bar.exe')} (veio ${barInspect.path} ${JSON.stringify(barInspect.args)})`);
      if (barInspect.dir.toLowerCase() !== sqBar.toLowerCase()) fail(`inspect squirrel com Bar.exe na raiz: dir ${barInspect.dir}`);
    }

    // mesmo .exe, vários atalhos (um launcher para vários jogos): argumentos e nomes diferentes continuam separados; nomes que se contêm e
    // argumentos iguais viram um só
    const riot = path.join(testRoot, 'riot'); fs.mkdirSync(riot);
    fs.writeFileSync(path.join(riot, 'RiotClientServices.exe'), realExe);
    const riotExe = path.join(riot, 'RiotClientServices.exe');
    mkLink(path.join(lnkDir, 'Riot Client.lnk'), riotExe, '');
    mkLink(path.join(lnkDir, 'VALORANT.lnk'), riotExe, '--launch-product=valorant --launch-patchline=live');
    mkLink(path.join(lnkDir, 'League of Legends.lnk'), riotExe, '--launch-product=league_of_legends --launch-patchline=live');
    mkLink(path.join(lnkDir, 'VALORANT Skinned.lnk'), riotExe, '--skin');
    const dupla = path.join(testRoot, 'dupla'); fs.mkdirSync(dupla);
    fs.writeFileSync(path.join(dupla, 'Dupla.exe'), realExe);
    mkLink(path.join(lnkDir, 'Atalho Alfa.lnk'), path.join(dupla, 'Dupla.exe'), '-x');
    mkLink(path.join(lnkDir, 'Outro Beta.lnk'), path.join(dupla, 'Dupla.exe'), '-X');
    // pasta de trabalho de versão, do Menu Iniciar e da Área de Trabalho, vistas pela varredura
    mkLink(path.join(lnkDir, 'Stub Versao.lnk'), path.join(stubDir, 'Stub.exe'), '', path.join(stubDir, 'app-1.2.3'));
    if (startFolder) mkLink(path.join(lnkDir, 'Jogo Menu Iniciar.lnk'), target, '-a', startFolder);
    if (deskFolder) mkLink(path.join(lnkDir, 'Jogo Desktop.lnk'), target, '-b', deskFolder);
    // atalho para a rede que não responde (IP sem dono): não pode atrasar a lista nem aparecer nela
    // (o próprio Windows leva 20 a 40 s para salvar um atalho para um servidor que não responde)
    mkLink(path.join(lnkDir, 'Jogo da Rede.lnk'), '\\\\10.255.255.7\\jogos\\Jogo.exe', '', '', 150000);

    const outSq = path.join(tmp, 'programs-extra.json');
    const extraRun = run(['--programs', outSq], { R3D_PROGRAMS_EXTRA_LNK_DIR: lnkDir });
    const extraData = readJson(outSq);
    if (extraData.error) fail(`varredura com atalhos de teste: ${extraData.error}`);
    const extra = Array.isArray(extraData.programs) ? extraData.programs : [];
    checkPrograms(extra, 'extra');
    if (extraRun.ms > 15000 || extraData.scannedMs > 12000) fail(`varredura com atalho de rede morto lenta demais: ${extraData.scannedMs} ms (processo ${extraRun.ms} ms): o caminho de rede está sendo tocado`);
    else if (extraData.scannedMs > 5000) warn(`varredura com atalho de rede morto levou ${extraData.scannedMs} ms`);
    const get = (n) => extra.find((p) => p.name === n);
    const sqProg = get('Foo Squirrel');
    if (!sqProg) fail('varredura: o atalho Squirrel de teste não apareceu');
    else {
      if (sqProg.exe.toLowerCase() !== path.join(sq, 'Update.exe').toLowerCase() || sqProg.args !== '--processStart Foo.exe') fail(`varredura squirrel: ${sqProg.exe} ${JSON.stringify(sqProg.args)}`);
      if (sqProg.dir.toLowerCase() !== sq.toLowerCase()) fail(`varredura squirrel: dir ${sqProg.dir}`);
    }
    const barProg = get('Bar Squirrel');
    if (!barProg) fail('varredura: o atalho Squirrel com Bar.exe na raiz não apareceu');
    else if (barProg.exe.toLowerCase() !== path.join(sqBar, 'Bar.exe').toLowerCase() || barProg.args !== '' || barProg.dir.toLowerCase() !== sqBar.toLowerCase()) fail(`varredura squirrel (Bar): ${barProg.exe} ${JSON.stringify(barProg.args)} dir ${barProg.dir}`);
    for (const n of ['Riot Client', 'VALORANT', 'League of Legends']) if (!get(n)) fail(`varredura: o atalho ${JSON.stringify(n)} (mesmo .exe, argumentos diferentes) sumiu`);
    if (get('VALORANT Skinned')) fail('varredura: "VALORANT Skinned" devia se juntar ao "VALORANT" (mesmo .exe, nome que o contém)');
    if (get('VALORANT') && !/launch-product=valorant/.test(get('VALORANT').args)) fail(`varredura: o VALORANT perdeu os argumentos (${get('VALORANT').args})`);
    if (extra.filter((p) => /^(Atalho Alfa|Outro Beta)$/.test(p.name)).length !== 1) fail('varredura: dois atalhos para o mesmo .exe com os mesmos argumentos devem virar um só');
    const sv2 = get('Stub Versao');
    if (!sv2) fail('varredura: o atalho "Stub Versao" não apareceu');
    else if (sv2.dir.toLowerCase() !== stubDir.toLowerCase()) fail(`varredura: pasta de versão não foi trocada: ${sv2.dir}`);
    for (const [n, d] of [['Jogo Menu Iniciar', startFolder], ['Jogo Desktop', deskFolder]]) {
      if (!d) continue;
      const pr = get(n);
      if (!pr) fail(`varredura: o atalho ${JSON.stringify(n)} não apareceu`);
      else if (pr.dir.toLowerCase() !== accented.toLowerCase()) fail(`varredura: ${n} ficou com a pasta de trabalho ${pr.dir}`);
    }
    if (extra.some((p) => /^\\\\/.test(p.exe))) fail('varredura: um programa de rede entrou na lista');

    // rede morta: inspectProgram e findExe têm prazo próprio (10 s e 8 s) e respondem em português em vez de ficar presos
    const netI = inspect('\\\\10.255.255.8\\jogos\\Jogo.exe', {}, 40000);
    if (netI) {
      checkFail('inspect em rede morta', netI, null);
      if (netI.__ms > 16000) fail(`inspect em rede morta levou ${netI.__ms} ms (o prazo é 10 s)`);
    }
    const netF = findExe('\\\\10.255.255.9\\jogos', 40000);
    if (netF) {
      if (!Array.isArray(netF.candidates) || netF.candidates.length) fail('find-exe em rede morta devia dar candidates []');
      if (netF.__ms > 16000) fail(`find-exe em rede morta levou ${netF.__ms} ms (o prazo é 8 s)`);
    }
  }

  /* ========== Resumo ========== */
  const bySourceText = Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join('  ');
  console.log(`\nProgramas: ${programs.length} (${bySourceText})   com ícone: ${withIcon}   scannedMs: ${data.scannedMs}   processo: ${res.ms} ms`);
  console.log('\nPrimeiros 15:');
  programs.slice(0, 15).forEach((p) => console.log(`  ${p.name}  [${p.source}]  ${p.exe}${p.args ? '  ' + p.args : ''}`));
  console.log('\nÚltimos 15:');
  programs.slice(-15).forEach((p) => console.log(`  ${p.name}  [${p.source}]  ${p.exe}${p.args ? '  ' + p.args : ''}`));
} catch (e) {
  if (e.message !== 'sem saída') fail(`erro inesperado: ${e.stack || e}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
}

if (warnings.length) { console.log('\nAvisos:'); warnings.forEach((w) => console.log('  - ' + w)); }
if (errors.length) {
  console.error(`\nFALHOU: ${errors.length} violação(ões)`);
  errors.slice(0, 80).forEach((e) => console.error('  x ' + e));
  if (errors.length > 80) console.error(`  ... e mais ${errors.length - 80}`);
  process.exit(1);
}
console.log('\nOK: todas as verificações passaram.');
