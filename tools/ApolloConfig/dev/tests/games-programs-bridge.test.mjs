// Integração interface x app nativo (C#): respostas REAIS do app (anonimizadas: usuário "Teste") passando pelas funções da interface,
// mais conferências de contrato entre os dois lados (comandos que a interface chama existem no C#; mensagens de erro do C# chegam à pessoa).
// Para gerar dados novos: ApolloConfig.exe --programs saida.json | --inspect <arquivo> saida.json | --find-exe <pasta> saida.json
// (ou rode o devserver com R3D_NATIVE_EXE e use a tela de verdade; ver DESENVOLVIMENTO.md, seção 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../../ui/js/lib/programs.js';
import * as M from '../../ui/js/lib/appmodel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'ui', 'schema', 'apps.json'), 'utf8'));
const OFFICE = 'C:\\Program Files\\Microsoft Office\\root\\Office16';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAA';

/* ---------- installedPrograms (formato e conteúdo reais) ---------- */
const prog = (name, exe, args = '', dir = '', icon = PNG, source = 'startmenu') => ({ name, exe, args, dir: dir || exe.slice(0, exe.lastIndexOf('\\')), source, icon });
const REAL_LIST = [
  prog('Access', `${OFFICE}\\MSACCESS.EXE`),
  prog('Database Compare', 'C:\\Program Files\\Microsoft Office\\root\\Client\\AppVLP.exe', '"C:\\Program Files (x86)\\Microsoft Office\\Office16\\DCF\\DATABASECOMPARE.EXE"', '', null),
  prog('Epic Games Launcher', 'C:\\Program Files\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe', '', 'C:\\Program Files\\Epic Games'),
  prog('Git Bash', 'C:\\Program Files\\Git\\git-bash.exe', '--cd-to-home', 'C:\\Users\\Teste'),
  prog('IDLE (Python 3.12 64-bit)', 'C:\\Users\\Teste\\AppData\\Local\\Programs\\Python\\Python312\\pythonw.exe', '"C:\\Users\\Teste\\AppData\\Local\\Programs\\Python\\Python312\\Lib\\idlelib\\idle.pyw"'),
  prog('Intel® Graphics Software', 'C:\\Program Files\\Intel\\Intel Graphics Software\\IntelGraphicsSoftware.exe'),
  prog('OneNote', `${OFFICE}\\ONENOTE.EXE`),
  prog('Python 3.12 (64-bit)', 'C:\\Users\\Teste\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'),
  prog('Spreadsheet Compare', 'C:\\Program Files\\Microsoft Office\\root\\Client\\AppVLP.exe', '"C:\\Program Files (x86)\\Microsoft Office\\Office16\\DCF\\SPREADSHEETCOMPARE.EXE"', '', null),
  prog('Sticky Notes (new)', `${OFFICE}\\ONENOTE.EXE`, '/memoryWindow start'),
  prog('Unity', 'C:\\Program Files\\Unity\\Hub\\Editor\\2022.3.22f1\\Editor\\Unity.exe'),
  prog('Word', `${OFFICE}\\WINWORD.EXE`),
];
test('lista real: o mesmo .exe com argumentos diferentes continua com uma linha para cada programa', () => {
  const r = P.sanitizePrograms(REAL_LIST);
  assert.equal(r.length, REAL_LIST.length);
  assert.deepEqual(r.filter((p) => /ONENOTE/i.test(p.exe)).map((p) => p.name), ['OneNote', 'Sticky Notes (new)']);
  assert.deepEqual(r.filter((p) => /AppVLP/i.test(p.exe)).map((p) => p.name), ['Database Compare', 'Spreadsheet Compare']);
  assert.equal(new Set(r.map((p) => P.programKey(p.exe, p.args))).size, r.length);   // chaves únicas (a tela usa a chave para as linhas)
});
test('lista real: o comando montado volta igual ao que o C# mandou (caminho com espaços, parênteses e argumentos com aspas)', () => {
  for (const p of P.sanitizePrograms(REAL_LIST)) {
    const fields = P.programFields(P.programFromList(p));
    const back = P.parseCommand(fields.cmd);
    assert.equal(back.kind, 'path', p.name);
    assert.equal(P.pathKey(back.exe), P.pathKey(p.exe), p.name);
    assert.equal(back.args, p.args, p.name);
    assert.ok(fields['working-dir'], p.name);
    assert.deepEqual(M.validateApp(P.appFromProgram(P.programFromList(p), schema), schema).errors, {}, p.name);
  }
  assert.equal(P.programFields(P.programFromList(REAL_LIST[1])).cmd,
    '"C:\\Program Files\\Microsoft Office\\root\\Client\\AppVLP.exe" "C:\\Program Files (x86)\\Microsoft Office\\Office16\\DCF\\DATABASECOMPARE.EXE"');
});
test('lista real: o nome do atalho do Menu Iniciar manda (Word, Unity), sem ®/™ e sem estragar nomes com parênteses', () => {
  const nome = (n) => P.programFromList(REAL_LIST.find((p) => p.name === n)).name;
  assert.equal(nome('Word'), 'Word');
  assert.equal(nome('Unity'), 'Unity');                          // "Unity" é genérico para um .exe, mas é o nome do atalho
  assert.equal(nome('Intel® Graphics Software'), 'Intel Graphics Software');
  assert.equal(nome('IDLE (Python 3.12 64-bit)'), 'IDLE (Python 3.12 64-bit)');   // versão dentro de parênteses não é mexida
  assert.equal(nome('Python 3.12 (64-bit)'), 'Python');
  assert.equal(nome('Sticky Notes (new)'), 'Sticky Notes (new)');
});
test('lista real: a busca acha com e sem acento, pelo nome do atalho e por parte do nome', () => {
  const lista = P.sanitizePrograms(REAL_LIST);
  const nomes = (q) => P.searchPrograms(lista, q).map((p) => p.name);
  assert.deepEqual(nomes('word'), ['Word']);
  assert.deepEqual(nomes('intel graphics'), ['Intel® Graphics Software']);
  assert.deepEqual(nomes('compare'), ['Database Compare', 'Spreadsheet Compare']);
  assert.deepEqual(nomes('onenote'), ['OneNote', 'Sticky Notes (new)']);   // (o segundo acha pelo nome do arquivo ONENOTE.EXE)
  assert.deepEqual(nomes('zzzz'), []);
});
test('lista real: "já está na lista" olha o .exe E os argumentos', () => {
  const meus = [{ name: 'Meu OneNote', cmd: P.buildCommand(`${OFFICE}\\ONENOTE.EXE`) }, { name: 'Bash', cmd: P.buildCommand('C:\\Program Files\\Git\\git-bash.exe', '--cd-to-home') }];
  const r = P.markUsed(P.sanitizePrograms(REAL_LIST), meus);
  assert.deepEqual(r.filter((p) => p.used).map((p) => p.name), ['Git Bash', 'OneNote']);   // "Sticky Notes (new)" usa o mesmo ONENOTE.EXE, com outros argumentos
});

/* ---------- inspectProgram (formato e conteúdo reais) ---------- */
const exeInfo = (over) => ({ ok: true, kind: 'exe', args: '', company: '', version: '1.0', icon: PNG, ...over });
const REAL_INSPECT = {
  winword: exeInfo({ path: `${OFFICE}\\WINWORD.EXE`, dir: OFFICE, name: 'Microsoft Word', product: 'Microsoft Office', description: 'Microsoft Word' }),
  word_lnk: exeInfo({ kind: 'lnk', path: `${OFFICE}\\WINWORD.EXE`, dir: OFFICE, name: 'Word', product: 'Microsoft Office', description: 'Microsoft Word', shortcutName: 'Word' }),
  git_bash_lnk: exeInfo({ kind: 'lnk', path: 'C:\\Program Files\\Git\\git-bash.exe', args: '--cd-to-home', dir: 'C:\\Users\\Teste', name: 'Git Bash', product: 'Git', description: 'Git for Windows', shortcutName: 'Git Bash' }),
  lnk_sem_nome: exeInfo({ kind: 'lnk', path: 'C:\\Jogos\\Hades\\Hades.exe', dir: 'C:\\Jogos\\Hades', name: 'Hades', product: 'Hades', description: 'Hades', shortcutName: '' }),
  notepad: exeInfo({ path: 'C:\\Windows\\System32\\notepad.exe', dir: 'C:\\Windows\\System32', name: 'Notepad', product: 'Microsoft® Windows® Operating System', description: 'Notepad' }),
  charmap_lnk: exeInfo({ kind: 'lnk', path: 'C:\\Windows\\System32\\charmap.exe', dir: 'C:\\Windows\\System32', name: 'Character Map', product: 'MicrosoftÂ® WindowsÂ® Operating System', description: 'Character Map', shortcutName: 'Character Map' }),
  charmap_exe: exeInfo({ path: 'C:\\Windows\\System32\\charmap.exe', dir: 'C:\\Windows\\System32', name: '', product: 'MicrosoftÂ® WindowsÂ® Operating System', description: '' }),
  ndi_bridge: exeInfo({ path: 'C:\\Program Files\\NDI\\NDI 6 Tools\\Bridge\\Application.NDI.Bridge.UI.exe', dir: 'C:\\Program Files\\NDI\\NDI 6 Tools\\Bridge', name: 'NDI Bridge', product: 'Application.NDI.Bridge.UI', description: 'NDI Bridge' }),
  ndi_router: exeInfo({ path: 'C:\\Program Files\\NDI\\NDI 6 Tools\\Router\\Application.NDI.Router.exe', dir: 'C:\\Program Files\\NDI\\NDI 6 Tools\\Router', name: 'Application.NDI.Router', product: 'Application.NDI.Router', description: 'Application.NDI.Router' }),
  hl2: exeInfo({ path: 'D:\\Steam\\steamapps\\common\\Half-Life 2\\hl2.exe', dir: 'D:\\Steam\\steamapps\\common\\Half-Life 2', name: 'hl2', product: '', description: '' }),
  mxnotify: exeInfo({ path: 'C:\\Program Files\\Maxon\\Tools\\MxNotify.exe', dir: 'C:\\Program Files\\Maxon\\Tools', name: 'MxNotify', product: '', description: '' }),
  opencut: exeInfo({ path: 'C:\\Program Files\\OpenCut\\server\\OpenCut-Server.exe', dir: 'C:\\Program Files\\OpenCut\\server', name: 'OpenCut Server', product: '', description: '' }),
  stremio: exeInfo({ path: 'C:\\Users\\Teste\\AppData\\Local\\Programs\\LNV\\Stremio-5\\stremio.exe', dir: 'C:\\Users\\Teste\\AppData\\Local\\Programs\\LNV\\Stremio-5', name: 'Stremio', product: '', description: '' }),
  hoyo: exeInfo({ path: 'D:\\Games\\Gensho Impact\\HoYoPlay\\launcher.exe', dir: 'D:\\Games\\Gensho Impact\\HoYoPlay', name: 'Ho Yo Play', product: 'HoYoPlay', description: 'HoYoPlay' }),
  wslsettings: exeInfo({ path: 'C:\\Program Files\\WSL\\wslsettings\\wslsettings.exe', dir: 'C:\\Program Files\\WSL\\wslsettings', name: 'Windows Subsystem for Linux Settings', product: 'Windows Subsystem for Linux', description: 'Windows Subsystem for Linux Settings' }),
  bat: { ok: true, kind: 'bat', path: 'C:\\Users\\Teste\\Jogos\\Iniciar Jogo Épico.bat', args: '', dir: 'C:\\Users\\Teste\\Jogos', name: 'Iniciar Jogo Épico', product: '', description: '', company: '', version: '', icon: null },
  bat_minusculo: { ok: true, kind: 'bat', path: 'C:\\Users\\Teste\\Downloads\\gradlew.bat', args: '', dir: 'C:\\Users\\Teste\\Downloads', name: 'gradlew', product: '', description: '', company: '', version: '', icon: null },
};
test('inspectProgram real: o nome que o app nativo escolheu (WINWORD = "Microsoft Word") vence o produto do .exe ("Microsoft Office")', () => {
  assert.equal(P.programFromInspect(REAL_INSPECT.winword).name, 'Microsoft Word');
  assert.equal(P.programFromInspect(REAL_INSPECT.wslsettings).name, 'Windows Subsystem for Linux Settings');
  assert.equal(P.programFromInspect(REAL_INSPECT.ndi_bridge).name, 'NDI Bridge');             // o produto é um nome de assembly
  assert.equal(P.programFromInspect(REAL_INSPECT.opencut).name, 'OpenCut Server');            // "server" é pasta de recipiente, não nome
});
test('inspectProgram real: atalho (.lnk) usa o nome do atalho, não o produto do destino ("Word", não "Microsoft Office")', () => {
  assert.equal(P.programFromInspect(REAL_INSPECT.word_lnk).name, 'Word');
  const git = P.programFromInspect(REAL_INSPECT.git_bash_lnk);
  assert.equal(git.name, 'Git Bash');
  assert.equal(git.args, '--cd-to-home');
  assert.equal(git.kind, 'lnk');
  assert.equal(P.programFromInspect(REAL_INSPECT.charmap_lnk).name, 'Character Map');
  assert.equal(P.programFromInspect(REAL_INSPECT.lnk_sem_nome).name, 'Hades');                // shortcutName vazio: cai no nome comum
});
test('inspectProgram real: nome que é a pasta de recipiente (System32, Tools, Server) ou só o arquivo não vira nome do jogo', () => {
  assert.equal(P.programFromInspect(REAL_INSPECT.notepad).name, 'Notepad');
  assert.equal(P.programFromInspect(REAL_INSPECT.mxnotify).name, 'MxNotify');
  assert.equal(P.programFromInspect(REAL_INSPECT.stremio).name, 'Stremio');                    // a pasta "Stremio-5" não acrescenta nada
  assert.equal(P.programFromInspect(REAL_INSPECT.ndi_router).name, 'Router');                  // só há o nome de assembly: a pasta ajuda
});
test('inspectProgram real: sem nome útil, a pasta escolhida ou a do .exe dá o nome; mesmas letras do produto, vale a grafia dele', () => {
  assert.equal(P.programFromInspect(REAL_INSPECT.hl2).name, 'Half-Life 2');
  assert.equal(P.programFromInspect(REAL_INSPECT.hl2, { folderName: 'Meu Half' }).name, 'Meu Half');
  assert.equal(P.programFromInspect(REAL_INSPECT.hoyo).name, 'HoYoPlay');                      // C#: "Ho Yo Play"
});
test('inspectProgram real: texto com "Â" solto (recurso de versão com a codificação errada) não vaza para o nome', () => {
  assert.equal(P.cleanProgramName('MicrosoftÂ® WindowsÂ® Operating System'), 'Microsoft Windows Operating System');
  assert.equal(P.isGenericName(P.cleanProgramName('MicrosoftÂ® WindowsÂ® Operating System')), true);   // produto genérico do Windows: não serve de nome
  assert.equal(P.programFromInspect(REAL_INSPECT.charmap_exe).name, 'Charmap');                          // sobra o nome do arquivo (a pasta é System32)
});
test('inspectProgram real: arquivo .bat usa o nome do arquivo (e não o da pasta Jogos/Downloads)', () => {
  const bat = P.programFromInspect(REAL_INSPECT.bat);
  assert.equal(bat.name, 'Iniciar Jogo Épico');
  assert.equal(bat.kind, 'bat');
  assert.equal(bat.dir, 'C:\\Users\\Teste\\Jogos');
  assert.equal(P.programFromInspect(REAL_INSPECT.bat_minusculo).name, 'Gradlew');
  assert.equal(P.appFromProgram(bat, schema).cmd, '"C:\\Users\\Teste\\Jogos\\Iniciar Jogo Épico.bat"');
});
test('inspectProgram real: o app criado de cada resposta real sai com a política (tela virtual e fechar ao sair) e passa na validação', () => {
  for (const [k, info] of Object.entries(REAL_INSPECT)) {
    const app = P.appFromProgram(P.programFromInspect(info), schema);
    assert.equal(app['virtual-display'], true, k);
    assert.equal(app['terminate-on-pause'], true, k);
    assert.ok(app.name, k);
    assert.deepEqual(M.validateApp(app, schema).errors, {}, k);
    assert.equal(P.parseCommand(app.cmd).kind, 'path', k);
  }
});

/* ---------- candidates (pickFolder / findExe), na ordem real do C# ---------- */
const cand = (folder, rel, size) => ({ path: `${folder}\\${rel}`, name: rel.split('\\').pop(), size });
test('candidates reais: a ordem do app nativo é mantida (Half-Life 2: hl2.exe antes das ferramentas da pasta bin)', () => {
  const folder = 'D:\\Steam\\steamapps\\common\\Half-Life 2';
  const lista = [cand(folder, 'hl2.exe', 127072), cand(folder, 'bin\\elementviewer.exe', 3202048), cand(folder, 'bin\\qc_eyes.exe', 2911232), cand(folder, 'bin\\studiomdl.exe', 1792000)];
  const r = P.rankCandidates(lista, { folder, trustOrder: true });
  assert.deepEqual(r.list.map((c) => c.name), ['hl2.exe', 'elementviewer.exe', 'qc_eyes.exe', 'studiomdl.exe']);
  assert.equal(r.confident, false);                      // nenhum nome lembra o da pasta: a pessoa escolhe
  // sem confiar na ordem (lista sem ordem nenhuma), a pontuação da interface põe uma ferramenta na frente por causa do tamanho: por isso trustOrder existe
  assert.notEqual(P.rankCandidates(lista, { folder }).list[0].name, 'hl2.exe');
});
test('candidates reais: War Thunder (launcher.exe é como o jogo abre) e Gensho Impact (launcher na raiz) ficam como o app nativo ordenou', () => {
  const wt = 'D:\\Steam\\steamapps\\common\\War Thunder';
  assert.deepEqual(P.rankCandidates([cand(wt, 'launcher.exe', 8752360), cand(wt, 'gaijin_downloader.exe', 3913944)], { folder: wt, trustOrder: true }).list.map((c) => c.name), ['launcher.exe', 'gaijin_downloader.exe']);
  const gi = 'D:\\Games\\Gensho Impact';
  const g = P.rankCandidates([cand(gi, 'HoYoPlay\\launcher.exe', 6163240), cand(gi, 'HoYoPlay\\1.16.1.364\\HYP.exe', 710952), cand(gi, 'HoYoPlay\\1.16.1.364\\7z.exe', 585000)], { folder: gi, trustOrder: true });
  assert.equal(g.recommended.name, 'launcher.exe');
});
test('candidates reais: nome igual ao da pasta continua "mais provável" (confiante) mesmo mantendo a ordem do app nativo', () => {
  const folder = 'D:\\Games\\GTA SA';
  const r = P.rankCandidates([cand(folder, 'gta_sa.exe', 14383616), cand(folder, 'omp-launcher.exe', 9820952), cand(folder, 'samp.exe', 412672)], { folder, trustOrder: true });
  assert.equal(r.recommended.name, 'gta_sa.exe');
  assert.equal(r.confident, true);
  const fo = 'D:\\Steam\\steamapps\\common\\FlatOut 2';
  const f = P.rankCandidates([cand(fo, 'FlatOut2.exe', 3004832), cand(fo, 'mods\\FlatOut 2 Mod Manager.exe', 5442832), cand(fo, 'fo2_launcher.exe', 611600)], { folder: fo, trustOrder: true });
  assert.equal(f.confident, true);
  assert.equal(P.rankCandidates([cand(folder, 'a.exe', 1), cand(folder, 'b.exe', 2)], { folder, trustOrder: true }).confident, false);
});

/* ---------- arrastar e soltar: caminhos reais ---------- */
test('arquivos soltos: caminhos com acento, ™, parênteses, caminho longo e pasta com ponto no nome', () => {
  const longo = `C:\\Users\\Teste\\${'pasta_muito_longa_para_testar_caminho_'.repeat(8)}\\JogoLongo.exe`;
  assert.equal(P.classifyPath('C:\\Jogos\\Ação_Épica.EXE'), 'exe');
  assert.equal(P.classifyPath('C:\\Users\\Teste\\Área de Trabalho\\Meu Jogo Ação™.lnk'), 'lnk');
  assert.equal(P.classifyPath('C:\\Jogos\\Jogo Ação™ (v1.2)'), 'folder');          // o ")" não é extensão
  assert.equal(P.classifyPath('C:\\Jogos\\Hades.v2'), 'unknown');                  // quem decide é a ponte (isFolder)
  assert.equal(P.classifyPath(longo), 'exe');
  assert.equal(P.pickDropped(['C:\\Jogos\\leia-me.txt', 'C:\\Jogos\\Jogo Ação™ (v1.2)', longo]).path, longo);
  assert.equal(P.pickDropped(['\\\\?\\C:\\Jogos\\Hades\\Hades.exe']).path, 'C:\\Jogos\\Hades\\Hades.exe');   // prefixo longo do Windows some
  // o que a ponte diz de uma pasta com ponto: { ok: false, isFolder: true }
  assert.equal(P.judgeDropped('unknown', { ok: false, isFolder: true, error: 'Isso é uma pasta...' }), 'folder');
});

/* ---------- contrato entre os dois lados ---------- */
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
test('contrato: todo comando que a interface manda para o app nativo existe no Program.cs (e o inverso para os comandos novos)', () => {
  const cs = read('Program.cs');
  const handled = new Set([...cs.matchAll(/case "([A-Za-z]+)"/g)].map((m) => m[1]));
  const used = new Set();
  for (const f of walk(path.join(root, 'ui', 'js'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\b(?:native|safeNative|nativeFiles)\(\s*'([A-Za-z]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 12, `poucos comandos achados (${[...used]})`);
  for (const cmd of used) assert.ok(handled.has(cmd), `a interface chama "${cmd}", mas o Program.cs não tem esse comando`);
  for (const cmd of ['installedPrograms', 'pickFile', 'pickFolder', 'inspectProgram', 'droppedFiles', 'findExe']) assert.ok(handled.has(cmd), `falta "${cmd}" no Program.cs`);
  // as flags de teste que o DESENVOLVIMENTO.md e o devserver citam
  for (const flag of ['--programs', '--inspect', '--find-exe']) assert.ok(cs.includes(`"${flag}"`), flag);
});
test('contrato: toda mensagem de erro em português do C# chega à pessoa como está (nada vira "texto técnico")', () => {
  const src = ['ProgramScanner.cs', 'FilePicker.cs'].map((f) => read(f)).join('\n');
  const msgs = [];
  for (const m of src.matchAll(/(?:Fail|Error)\(\$?"((?:[^"\\]|\\.)*)"/g)) msgs.push(m[1]);
  for (const m of src.matchAll(/\["error"\] = "((?:[^"\\]|\\.)*)"/g)) msgs.push(m[1]);
  assert.ok(msgs.length >= 15, `poucas mensagens achadas (${msgs.length})`);
  for (const raw of msgs) {
    const msg = raw.replace(/\{[^}]*\}/g, 'x');   // texto interpolado do C#
    assert.equal(P.describeBridgeError({ error: msg }, 'FALLBACK'), msg, msg);
    assert.match(msg, /[a-zãõáéíóúç]/i);
  }
});
test('contrato: o que a interface lê de cada resposta existe nos campos que o C# escreve', () => {
  const ps = read('ProgramScanner.cs');
  for (const campo of ['name', 'exe', 'args', 'dir', 'source', 'icon']) assert.ok(ps.includes(`["${campo}"] = `), `installedPrograms sem "${campo}"`);
  for (const campo of ['ok', 'kind', 'path', 'args', 'dir', 'name', 'product', 'description', 'company', 'version', 'icon', 'shortcutName', 'isFolder']) assert.ok(ps.includes(`["${campo}"]`), `inspectProgram sem "${campo}"`);
  const fp = read('FilePicker.cs');
  for (const campo of ['cancelled', 'path', 'folder', 'candidates', 'size', 'name']) assert.ok(fp.includes(`["${campo}"]`), `pickFile/pickFolder sem "${campo}"`);
});
