// Testes da lógica pura de "Adicionar aplicativo" (ui/js/lib/programs.js): caminhos, comando, busca, nomes e candidatos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../ui/js/lib/programs.js';

/* ---------- Caminhos ---------- */
test('cleanPath tira aspas, troca "/" por "\\", junta barras repetidas e resolve "." e ".."', () => {
  assert.equal(P.cleanPath('  "C:/Jogos//Hades/../Hades/./Hades.exe"  '), 'C:\\Jogos\\Hades\\Hades.exe');
  assert.equal(P.cleanPath('C:\\Jogos\\Hades\\'), 'C:\\Jogos\\Hades');
  assert.equal(P.cleanPath('C:\\'), 'C:\\');
  assert.equal(P.cleanPath('c:/'), 'c:\\');
  assert.equal(P.cleanPath('\\\\servidor\\pasta\\\\jogo.exe'), '\\\\servidor\\pasta\\jogo.exe');
  assert.equal(P.cleanPath('\\\\?\\C:\\Jogos\\a.exe'), 'C:\\Jogos\\a.exe');
  assert.equal(P.cleanPath('\\\\?\\UNC\\srv\\share\\a.exe'), '\\\\srv\\share\\a.exe');
  assert.equal(P.cleanPath('C:\\..\\x.exe'), 'C:\\x.exe');
  assert.equal(P.cleanPath('%USERPROFILE%\\jogo.exe'), '%USERPROFILE%\\jogo.exe');
  assert.equal(P.cleanPath(''), '');
  assert.equal(P.cleanPath(null), '');
  assert.equal(P.cleanPath('""'), '');
});
test('pathKey/samePath ignoram maiúsculas, "/" e "\\" e aspas; caminhos diferentes ou vazios nunca são iguais', () => {
  assert.equal(P.samePath('C:\\Program Files\\X\\x.exe', '"c:/program files/x/X.EXE"'), true);
  assert.equal(P.samePath('C:\\Jogos\\a.exe', 'C:\\Jogos\\b.exe'), false);
  assert.equal(P.samePath('', ''), false);
  assert.equal(P.samePath('C:\\Ação\\a.exe', 'c:\\ação\\A.EXE'), true);
  assert.equal(P.pathKey('C:\\A\\B\\..\\C.exe'), 'c:\\a\\c.exe');
});
test('fileNameOf, baseNameOf, extOf e dirOf', () => {
  assert.equal(P.fileNameOf('C:\\Jogos\\Hades\\Hades.exe'), 'Hades.exe');
  assert.equal(P.baseNameOf('C:\\Jogos\\Hades\\Hades.exe'), 'Hades');
  assert.equal(P.baseNameOf('C:\\Jogos\\Counter-Strike 1.6'), 'Counter-Strike 1');   // (para pastas use fileNameOf)
  assert.equal(P.fileNameOf('C:\\Jogos\\Counter-Strike 1.6'), 'Counter-Strike 1.6');
  assert.equal(P.extOf('C:\\a\\B.EXE'), 'exe');
  assert.equal(P.extOf('C:\\a\\semextensao'), '');
  assert.equal(P.extOf('C:\\a\\.gitignore'), '');
  assert.equal(P.dirOf('C:\\Jogos\\Hades\\Hades.exe'), 'C:\\Jogos\\Hades');
  assert.equal(P.dirOf('C:\\x.exe'), 'C:\\');
  assert.equal(P.dirOf('x.exe'), '');
  assert.equal(P.dirOf('\\\\srv\\share\\x.exe'), '\\\\srv\\share');
});
test('relativeTo tira a pasta do começo (sem diferenciar maiúsculas) e devolve o caminho inteiro se não for filho dela', () => {
  assert.equal(P.relativeTo('C:\\Jogos\\ETS2\\bin\\win_x64\\eurotrucks2.exe', 'c:\\jogos\\ets2'), 'bin\\win_x64\\eurotrucks2.exe');
  assert.equal(P.relativeTo('C:\\Jogos\\ETS2\\a.exe', 'C:\\Jogos\\ETS2\\'), 'a.exe');
  assert.equal(P.relativeTo('D:\\Outro\\a.exe', 'C:\\Jogos'), 'D:\\Outro\\a.exe');
  assert.equal(P.relativeTo('C:\\Jogos2\\a.exe', 'C:\\Jogos'), 'C:\\Jogos2\\a.exe');   // "Jogos2" não está dentro de "Jogos"
});
test('ellipsizePath: caminho curto fica igual; longo mantém a unidade, o fim e cabe no limite', () => {
  assert.equal(P.ellipsizePath('C:\\Jogos\\Hades\\Hades.exe', 64), 'C:\\Jogos\\Hades\\Hades.exe');
  const longo = 'C:\\Program Files (x86)\\Uma Empresa Com Nome Muito Longo\\Produto Muito Importante\\Aplicativo\\bin\\win64\\jogo.exe';
  const curto = P.ellipsizePath(longo, 50);
  assert.ok(curto.startsWith('C:\\…\\'), curto);
  assert.ok(curto.endsWith('win64\\jogo.exe') || curto.endsWith('bin\\win64\\jogo.exe'), curto);
  assert.ok(curto.length <= 50, `${curto.length}: ${curto}`);
  const enorme = P.ellipsizePath(`C:\\${'x'.repeat(200)}.exe`, 40);
  assert.ok(enorme.length <= 40, enorme);
  assert.ok(enorme.endsWith('.exe'));
});
test('ellipsizeText corta no fim sem mexer em barras nem aspas (links e comandos)', () => {
  assert.equal(P.ellipsizeText('steam://rungameid/220', 90), 'steam://rungameid/220');
  assert.equal(P.ellipsizeText('"C:\\Program Files\\x.exe" --launch-steam 220 source', 90), '"C:\\Program Files\\x.exe" --launch-steam 220 source');
  const cortado = P.ellipsizeText(`steam://rungameid/${'9'.repeat(200)}`, 30);
  assert.equal(cortado.length, 30);
  assert.ok(cortado.startsWith('steam://rungameid/9') && cortado.endsWith('…'));
  assert.equal(P.ellipsizeText(null), '');
});
test('humanSize usa vírgula decimal e unidades legíveis', () => {
  assert.equal(P.humanSize(0), '0 B');
  assert.equal(P.humanSize(512), '512 B');
  assert.equal(P.humanSize(850 * 1024), '850 KB');
  assert.equal(P.humanSize(1234567), '1,2 MB');
  assert.equal(P.humanSize(52428800), '50 MB');
  assert.equal(P.humanSize(3.4 * 1024 ** 3), '3,4 GB');
  assert.equal(P.humanSize(-1), '');
  assert.equal(P.humanSize('abc'), '');
});
test('escapeDollar/unescapeDollar: todo "$" de um caminho vira "$$" e volta ao ler', () => {
  assert.equal(P.escapeDollar('C:\\Jogos\\$(Odd)\\a.exe'), 'C:\\Jogos\\$$(Odd)\\a.exe');
  assert.equal(P.unescapeDollar(P.escapeDollar('a$$b$c$')), 'a$$b$c$');
  assert.equal(P.escapeDollar(''), '');
  assert.equal(P.escapeDollar(null), '');
});

/* ---------- Comando ---------- */
test('parseCommand: caminho entre aspas com espaços, parênteses e acentos, mais argumentos', () => {
  assert.deepEqual(P.parseCommand('"C:\\Program Files (x86)\\Steam\\steam.exe" -applaunch 220'),
    { exe: 'C:\\Program Files (x86)\\Steam\\steam.exe', args: '-applaunch 220', kind: 'path' });
  assert.deepEqual(P.parseCommand('"C:\\Jogos\\Ação e Aventura\\Jogo (Ed. Especial).exe"'),
    { exe: 'C:\\Jogos\\Ação e Aventura\\Jogo (Ed. Especial).exe', args: '', kind: 'path' });
  assert.deepEqual(P.parseCommand('"C:\\x\\a.exe" --nome "Fulano de Tal" -w'), { exe: 'C:\\x\\a.exe', args: '--nome "Fulano de Tal" -w', kind: 'path' });
  assert.deepEqual(P.parseCommand('"C:\\x\\a.exe"/windowed'), { exe: 'C:\\x\\a.exe', args: '/windowed', kind: 'path' });
});
test('parseCommand: caminho SEM aspas com espaços é lido até a extensão', () => {
  assert.deepEqual(P.parseCommand('C:\\Program Files\\Foo Bar\\foo.exe -windowed'), { exe: 'C:\\Program Files\\Foo Bar\\foo.exe', args: '-windowed', kind: 'path' });
  assert.deepEqual(P.parseCommand('C:\\Jogos\\a.exe'), { exe: 'C:\\Jogos\\a.exe', args: '', kind: 'path' });
  assert.deepEqual(P.parseCommand('D:\\Jogos\\Run.BAT /x'), { exe: 'D:\\Jogos\\Run.BAT', args: '/x', kind: 'path' });
  assert.deepEqual(P.parseCommand('C:\\Tools\\semextensao -a'), { exe: 'C:\\Tools\\semextensao', args: '-a', kind: 'path' });
});
test('parseCommand: link, comando do sistema, vazio, aspas sem fechar, variável do Windows e caminho de rede', () => {
  assert.deepEqual(P.parseCommand('steam://rungameid/220'), { exe: 'steam://rungameid/220', args: '', kind: 'url' });
  assert.deepEqual(P.parseCommand('cmd /C start "" "C:\\a.exe"'), { exe: 'cmd', args: '/C start "" "C:\\a.exe"', kind: 'command' });
  assert.deepEqual(P.parseCommand('powershell.exe -File x.ps1'), { exe: 'powershell.exe', args: '-File x.ps1', kind: 'command' });
  assert.deepEqual(P.parseCommand(''), { exe: '', args: '', kind: 'empty' });
  assert.deepEqual(P.parseCommand('   '), { exe: '', args: '', kind: 'empty' });
  assert.deepEqual(P.parseCommand(null), { exe: '', args: '', kind: 'empty' });
  assert.deepEqual(P.parseCommand('"C:\\Jogos\\sem fechar.exe'), { exe: 'C:\\Jogos\\sem fechar.exe', args: '', kind: 'path' });
  assert.equal(P.parseCommand('"%USERPROFILE%\\Jogos\\a.exe"').kind, 'path');
  assert.equal(P.parseCommand('"\\\\servidor\\jogos\\a.exe" -x').kind, 'path');
  assert.equal(P.parseCommand('"""').kind, 'empty');
});
test('buildCommand: o caminho vai SEMPRE entre aspas, com os argumentos depois', () => {
  assert.equal(P.buildCommand('C:\\Jogos\\Hades\\Hades.exe'), '"C:\\Jogos\\Hades\\Hades.exe"');
  assert.equal(P.buildCommand('C:\\Program Files (x86)\\Foo\\foo.exe', '-w "a b"'), '"C:\\Program Files (x86)\\Foo\\foo.exe" -w "a b"');
  assert.equal(P.buildCommand('"C:\\já tem aspas\\a.exe"', '  -x  '), '"C:\\já tem aspas\\a.exe" -x');
  assert.equal(P.buildCommand('', '-x'), '');
  assert.equal(P.buildCommand(null), '');
  assert.equal(P.buildCommand('C:\\a.exe', 'linha1\nlinha2'), '"C:\\a.exe" linha1 linha2');
});
test('buildCommand e parseCommand são inversos (inclusive com $, acentos, parênteses e argumentos com aspas)', () => {
  const casos = [
    ['C:\\Program Files (x86)\\Steam\\steam.exe', '-applaunch 220'],
    ['C:\\Jogos\\Ação e Aventura\\Jogo (Ed. Especial).exe', ''],
    ['D:\\Games\\$Recycle (x)\\a.exe', '--ini "C:\\a b\\c.ini"'],
    ['C:\\Jogos\\$(Odd)\\a.exe', ''],
    ['\\\\servidor\\jogos\\Meu Jogo\\a.exe', '-w'],
  ];
  for (const [exe, args] of casos) {
    const p = P.parseCommand(P.buildCommand(exe, args));
    assert.equal(p.exe, exe);
    assert.equal(p.args, args);
    assert.equal(p.kind, 'path');
  }
  // o "$(" de um caminho nunca chega ao servidor sem proteção
  assert.equal(P.buildCommand('C:\\Jogos\\$(Odd)\\a.exe'), '"C:\\Jogos\\$$(Odd)\\a.exe"');
});
test('exeOfCommand devolve o arquivo só quando o comando é um caminho', () => {
  assert.equal(P.exeOfCommand('"C:\\a b\\x.exe" -f'), 'C:\\a b\\x.exe');
  assert.equal(P.exeOfCommand('steam://rungameid/1'), null);
  assert.equal(P.exeOfCommand('cmd /C x'), null);
  assert.equal(P.exeOfCommand(''), null);
});

/* ---------- Programas já usados ---------- */
const apps = [
  { uuid: 'U1', name: 'Hades', cmd: '"C:\\Jogos\\Hades\\Hades.exe"' },
  { uuid: 'U2', name: 'Chrome', cmd: 'c:/program files/google/chrome/application/CHROME.EXE --kiosk' },
  { uuid: 'U3', name: 'Via Steam', cmd: '', detached: ['steam://rungameid/220'] },
  { uuid: 'U4', name: 'Atalho desvinculado', cmd: '', detached: ['"D:\\Emu\\retroarch.exe" -f'] },
  { uuid: 'U5', name: 'Outro Hades', cmd: '"C:\\JOGOS\\hades\\hades.exe"' },
  { uuid: 'U6', name: 'Com variável', cmd: '"$(HOME)\\x.exe"' },
  null, { name: 'sem cmd' },
];
test('usedExes compara o .exe sem diferenciar caixa, "/" nem aspas, olha os comandos desvinculados e guarda o primeiro nome', () => {
  const m = P.usedExes(apps);
  assert.equal(m.get(P.pathKey('C:\\Jogos\\Hades\\Hades.exe')), 'Hades');
  assert.equal(m.get(P.pathKey('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')), 'Chrome');
  assert.equal(m.get(P.pathKey('D:\\Emu\\retroarch.exe')), 'Atalho desvinculado');
  assert.equal(m.size, 3);   // sem link, sem variável, sem lixo
  assert.equal(P.usedExes(null).size, 0);
});
test('markUsed marca os programas da lista que algum aplicativo já abre', () => {
  const lista = [
    { name: 'Hades', exe: 'C:\\Jogos\\Hades\\Hades.exe' },
    { name: 'Google Chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: '--kiosk' },
    { name: 'Blender', exe: 'C:\\Program Files\\Blender\\blender.exe' },
  ];
  const r = P.markUsed(lista, apps);
  assert.deepEqual(r.map((p) => p.used), [true, true, false]);
  assert.deepEqual(r.map((p) => p.usedBy), ['Hades', 'Chrome', '']);
  assert.equal(lista[0].used, undefined);   // não altera a lista original
});
test('markUsed e findAppUsingExe: o mesmo .exe com argumentos diferentes é outro programa (OneNote e Sticky Notes usam o ONENOTE.EXE)', () => {
  const meus = [
    { uuid: 'A1', name: 'Meu OneNote', cmd: '"C:\\Program Files\\Microsoft Office\\root\\Office16\\ONENOTE.EXE"' },
    { uuid: 'A2', name: 'Riot VALORANT', cmd: '"C:\\Riot Games\\Riot Client\\RiotClientServices.exe" --launch-product=valorant --launch-patchline=live' },
  ];
  const onenote = 'C:\\Program Files\\Microsoft Office\\root\\Office16\\ONENOTE.EXE';
  const riot = 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe';
  const lista = [
    { name: 'OneNote', exe: onenote, args: '' },
    { name: 'Sticky Notes (new)', exe: onenote, args: '/memoryWindow start' },
    { name: 'VALORANT', exe: riot, args: '--launch-product=valorant   --launch-patchline=LIVE' },   // espaços e caixa não importam
    { name: 'League of Legends', exe: riot, args: '--launch-product=league_of_legends --launch-patchline=live' },
  ];
  assert.deepEqual(P.markUsed(lista, meus).map((p) => p.used), [true, false, true, false]);
  assert.equal(P.findAppUsingExe(meus, onenote, '', ''), 'Meu OneNote');
  assert.equal(P.findAppUsingExe(meus, onenote, '', '/memoryWindow start'), '');
  assert.equal(P.findAppUsingExe(meus, onenote), 'Meu OneNote');   // sem argumentos informados: só o .exe
  assert.notEqual(P.programKey(onenote, ''), P.programKey(onenote, '/x'));
  assert.equal(P.programKey('C:/Program Files/X/a.EXE', ' -a  -b'), P.programKey('"c:\\program files\\x\\a.exe"', '-A -B'));
  // a chave dos programas da lista é a mesma do comando montado a partir deles
  for (const p of lista) {
    const cmd = P.programFields(p).cmd;
    assert.equal(P.markUsed([p], [{ name: 'Feito pela tela', cmd }])[0].used, true, p.name);
  }
});
test('findAppUsingExe ignora o próprio aplicativo (editar) e devolve o nome do outro', () => {
  assert.equal(P.findAppUsingExe(apps, 'C:\\Jogos\\Hades\\Hades.exe'), 'Hades');
  assert.equal(P.findAppUsingExe(apps, 'C:\\Jogos\\Hades\\Hades.exe', 'U1'), 'Outro Hades');   // o outro app com o mesmo .exe
  assert.equal(P.findAppUsingExe([apps[0]], 'C:\\Jogos\\Hades\\Hades.exe', 'U1'), '');
  assert.equal(P.findAppUsingExe(apps, 'C:\\Nada\\x.exe'), '');
  assert.equal(P.findAppUsingExe(apps, ''), '');
});

/* ---------- Lista do app nativo ---------- */
const icon = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAA';
test('sanitizePrograms descarta linhas inválidas, repetidas (mesmo .exe em outra grafia) e dlls, e completa a pasta', () => {
  const lista = [
    { name: 'Hades', exe: 'C:\\Jogos\\Hades\\Hades.exe', args: '', dir: '', source: 'registry', icon },
    { name: ' Chrome ', exe: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: '--x', dir: 'C:\\Program Files\\Google\\Chrome', source: 'startmenu', icon: null },
    { name: 'Chrome de novo', exe: 'c:\\program files\\google\\chrome\\application\\CHROME.EXE', args: '--x' },
    { name: 'Chrome com outro argumento', exe: 'c:\\program files\\google\\chrome\\application\\CHROME.EXE', args: '--incognito' },   // outro programa: fica
    { name: '', exe: 'C:\\a.exe' },
    { name: 'Sem exe' },
    { name: 'Número', exe: 42 },
    { name: 'Relativo', exe: 'jogo.exe' },
    { name: 'Biblioteca', exe: 'C:\\Windows\\x.dll' },
    { name: 'Script', exe: 'C:\\Jogos\\run.bat' },
    null, 'texto', 7,
  ];
  const r = P.sanitizePrograms(lista);
  assert.deepEqual(r.map((p) => p.name), ['Hades', 'Chrome', 'Chrome com outro argumento', 'Script']);
  assert.equal(r[0].dir, 'C:\\Jogos\\Hades');
  assert.equal(r[0].icon, icon);
  assert.equal(r[1].exe, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(r[1].args, '--x');
  assert.equal(P.sanitizePrograms('lixo').length, 0);
  assert.equal(P.sanitizePrograms(undefined).length, 0);
});
test('sanitizePrograms só deixa passar ícone PNG em base64 e corta em 800 itens', () => {
  const r = P.sanitizePrograms([
    { name: 'A', exe: 'C:\\a.exe', icon: 'data:image/png;base64,AAAA' },
    { name: 'B', exe: 'C:\\b.exe', icon: '<script>alert(1)</script>' },
    { name: 'C', exe: 'C:\\c.exe', icon: 42 },
    { name: 'D', exe: 'C:\\d.exe', icon },
  ]);
  assert.deepEqual(r.map((p) => p.icon), [null, null, null, icon]);
  const muitos = Array.from({ length: 1000 }, (_, i) => ({ name: `P${i}`, exe: `C:\\p\\${i}.exe` }));
  assert.equal(P.sanitizePrograms(muitos).length, P.MAX_PROGRAMS);
});

/* ---------- Busca ---------- */
const catalogo = [
  { name: '7-Zip File Manager', exe: 'C:\\Program Files\\7-Zip\\7zFM.exe' },
  { name: 'Ação Total Racing', exe: 'C:\\Jogos\\Ação Total\\racing.exe' },
  { name: 'Blender 4.2', exe: 'C:\\Blender\\blender-launcher.exe' },
  { name: 'Google Chrome', exe: 'C:\\Chrome\\chrome.exe' },
  { name: 'Hades', exe: 'C:\\Jogos\\Hades\\Hades.exe' },
  { name: 'Hades II', exe: 'C:\\Jogos\\Hades II\\Hades2.exe' },
  { name: 'Mozilla Firefox', exe: 'C:\\Firefox\\firefox.exe' },
  { name: 'Visual Studio Code', exe: 'C:\\Code\\Code.exe' },
  { name: 'Old Hades Mod', exe: 'C:\\Mods\\old.exe' },
];
const nomes = (r) => r.map((p) => p.name);
test('searchPrograms ignora acento e maiúsculas e acha em qualquer parte do nome', () => {
  assert.deepEqual(nomes(P.searchPrograms(catalogo, 'acao')), ['Ação Total Racing']);
  assert.deepEqual(nomes(P.searchPrograms(catalogo, 'AÇÃO')), ['Ação Total Racing']);
  assert.deepEqual(nomes(P.searchPrograms(catalogo, 'chrome')), ['Google Chrome']);
  assert.deepEqual(nomes(P.searchPrograms(catalogo, 'ilLa')), ['Mozilla Firefox']);
  assert.deepEqual(nomes(P.searchPrograms(catalogo, 'zero')), []);
});
test('searchPrograms: várias palavras precisam aparecer todas, em qualquer ordem', () => {
  assert.deepEqual(nomes(P.searchPrograms(catalogo, 'studio visual')), ['Visual Studio Code']);
  assert.deepEqual(nomes(P.searchPrograms(catalogo, 'google xyz')), []);
});
test('searchPrograms: quem começa com o texto vem primeiro, depois início de palavra, depois o resto; o empate mantém a ordem', () => {
  assert.deepEqual(nomes(P.searchPrograms(catalogo, 'hades')), ['Hades', 'Hades II', 'Old Hades Mod']);
  const mistura = [{ name: 'Shades of Gray', exe: 'C:\\a.exe' }, { name: 'Notepad Hades', exe: 'C:\\b.exe' }, { name: 'Hades', exe: 'C:\\c.exe' }, { name: 'The Hades Mod', exe: 'C:\\d.exe' }];
  assert.deepEqual(nomes(P.searchPrograms(mistura, 'hades')), ['Hades', 'Notepad Hades', 'The Hades Mod', 'Shades of Gray']);
  assert.deepEqual(nomes(P.searchPrograms(mistura, 'ades')), ['Shades of Gray', 'Notepad Hades', 'Hades', 'The Hades Mod']);   // ninguém começa com "ades": mesma ordem da lista
});
test('searchPrograms: acha pelo nome do arquivo quando o nome do programa não bate e devolve tudo para busca vazia', () => {
  assert.deepEqual(nomes(P.searchPrograms(catalogo, 'hades2')), ['Hades II']);
  assert.deepEqual(nomes(P.searchPrograms(catalogo, '7zfm')), ['7-Zip File Manager']);
  assert.equal(P.searchPrograms(catalogo, '').length, catalogo.length);
  assert.equal(P.searchPrograms(catalogo, '   ').length, catalogo.length);
  assert.equal(P.searchPrograms(catalogo, null).length, catalogo.length);
  assert.notEqual(P.searchPrograms(catalogo, ''), catalogo);   // cópia
});

/* ---------- Nome sugerido ---------- */
test('cleanProgramName tira versão, arquitetura, marcas e "Launcher" sobrando', () => {
  const c = (s, o) => P.cleanProgramName(s, o);
  assert.equal(c('Blender 4.2'), 'Blender');
  assert.equal(c('Python 3.12 (64-bit)'), 'Python');
  assert.equal(c('Notepad++ 8.6.2'), 'Notepad++');
  assert.equal(c('WinRAR 6.24 (x64)'), 'WinRAR');
  assert.equal(c('Hades v1.38'), 'Hades');
  assert.equal(c('Hades version 2'), 'Hades');
  assert.equal(c('Jogo Ótimo x64'), 'Jogo Ótimo');
  assert.equal(c('Minecraft Launcher'), 'Minecraft');
  assert.equal(c('Epic Games Launcher'), 'Epic Games');
  assert.equal(c('Launcher'), 'Launcher');
  assert.equal(c('Hades Game Launcher'), 'Hades');
  assert.equal(c('Game Launcher'), 'Game');
  assert.equal(c('Microsoft® Office™ Word'), 'Microsoft Office Word');
  assert.equal(c('Hades.exe'), 'Hades');
  assert.equal(c('  Muito   espaço  '), 'Muito espaço');
});
test('cleanProgramName não estraga nomes que parecem versão ou arquitetura mas não são', () => {
  const c = (s) => P.cleanProgramName(s);
  assert.equal(c('Fallout 4'), 'Fallout 4');
  assert.equal(c('Super Mario 64'), 'Super Mario 64');
  assert.equal(c('7-Zip'), '7-Zip');
  assert.equal(c('Microsoft Windows Terminal'), 'Microsoft Windows Terminal');
  assert.equal(c('Battle.net'), 'Battle.net');
  assert.equal(c('2.5D Platformer'), '2.5D Platformer');
  assert.equal(c('Left 4 Dead 2'), 'Left 4 Dead 2');
  assert.equal(c('Total War: Warhammer III'), 'Total War: Warhammer III');
});
test('cleanProgramName para nome de arquivo ou pasta: "_" vira espaço, palavras coladas se separam, tudo minúsculo ganha inicial', () => {
  const c = (s) => P.cleanProgramName(s, { fromFile: true });
  assert.equal(c('Hades-Win64-Shipping'), 'Hades');
  assert.equal(c('HorizonZeroDawn'), 'Horizon Zero Dawn');
  assert.equal(c('FarCry6'), 'Far Cry 6');
  assert.equal(c('meu_jogo_legal'), 'Meu Jogo Legal');
  assert.equal(c('hades'), 'Hades');
  assert.equal(c('Hades2'), 'Hades2');           // sem inventar espaço
  assert.equal(c('iTunes'), 'iTunes');
  assert.equal(c('MSIAfterburner'), 'MSIAfterburner');
  assert.equal(c('Euro Truck Simulator 2'), 'Euro Truck Simulator 2');
});
test('isGenericName reconhece nomes que não dizem nada', () => {
  for (const n of ['Unity', 'unity', 'Application', 'Aplicativo', 'game', 'Launcher', 'Setup', 'UnrealEngine', 'Godot Engine', '', ' ', 'x', '123', '3f2504e0-4f89-11d3-9a0c-0305e82c3301']) assert.equal(P.isGenericName(n), true, n);
  for (const n of ['Hades', 'Euro Truck Simulator 2', '7-Zip', 'Ação Total']) assert.equal(P.isGenericName(n), false, n);
});
test('isGenericName reconhece pastas de compilação e plataforma (Win64, x86_64, WindowsNoEditor, Shipping…)', () => {
  for (const n of ['Win64', 'Win32', 'win_x64', 'Win 64', 'x86_64', 'x64', 'x86', 'amd64', 'WindowsNoEditor', 'WindowsClient', 'Shipping', 'Retail', 'Development', 'Binaries', 'Bin64', 'Release x64', 'Linux64']) {
    assert.equal(P.isGenericName(n), true, n);
  }
  // nomes de verdade que só PARECEM com uma pasta de compilação
  for (const n of ['Windows Defender', 'Retail Tycoon', 'Shipping Simulator', 'Dead Cells', 'Development Hell', 'Debug Run', 'X-Plane 12', 'Win Or Lose']) assert.equal(P.isGenericName(n), false, n);
});
test('suggestName: jogo da Unreal (Binaries\\Win64\\X-Win64-Shipping.exe) fica com o nome do jogo, não "Win64"', () => {
  assert.equal(P.suggestName({ folder: 'Win64', file: 'Hades-Win64-Shipping' }), 'Hades');
  assert.equal(P.suggestName({ name: 'Win64', folder: 'Win64', file: 'Hades-Win64-Shipping' }), 'Hades');
  assert.equal(P.suggestName({ name: 'x86_64', folder: 'x86_64', file: 'meu_jogo' }), 'Meu Jogo');
  assert.equal(P.suggestName({ name: 'WindowsNoEditor', folder: 'WindowsNoEditor', file: 'ShooterGame' }), 'Shooter Game');
  assert.equal(P.suggestName({ product: 'Win64', folder: 'Shipping', file: 'Hades-Win64-Shipping' }), 'Hades');
});
test('suggestName: se tudo é genérico, devolve o primeiro que existir (melhor que nada)', () => {
  assert.equal(P.suggestName({ name: 'Win64', folder: 'Win64', file: 'Win64' }), 'Win64');
});
test('suggestName: nome sugerido pelo app nativo > produto > descrição > pasta > arquivo, pulando os genéricos', () => {
  assert.equal(P.suggestName({ product: 'Hades II', name: 'Hades II', description: 'x' }), 'Hades II');
  assert.equal(P.suggestName({ product: 'Hades II', description: 'x' }), 'Hades II');
  assert.equal(P.suggestName({ product: 'Hades II', name: 'Outro', description: 'x' }), 'Outro');   // o app nativo já escolheu entre produto e descrição
  assert.equal(P.suggestName({ name: 'Hades', folder: 'Pasta' }), 'Hades');
  assert.equal(P.suggestName({ name: '', description: 'Meu Jogo Legal', folder: 'Pasta' }), 'Meu Jogo Legal');
  // nome/descrição igual ao nome do arquivo é palpite fraco: a pasta vem antes; o produto (mesmo igual ao arquivo) é confiável
  assert.equal(P.suggestName({ name: 'eurotrucks2', description: 'eurotrucks2', folder: 'Euro Truck Simulator 2', file: 'eurotrucks2' }), 'Euro Truck Simulator 2');
  assert.equal(P.suggestName({ name: 'Hades', file: 'Hades', folder: 'Games' }), 'Hades');
  assert.equal(P.suggestName({ product: 'Hades', file: 'Hades', folder: 'Outra Coisa' }), 'Hades');
  assert.equal(P.suggestName({ product: 'Spotify', file: 'Spotify', folder: 'Programas Do Usuario' }), 'Spotify');
  assert.equal(P.suggestName({ name: 'Unity', product: 'Unity', description: 'Application', folder: 'Euro Truck Simulator 2', file: 'eurotrucks2' }), 'Euro Truck Simulator 2');
  assert.equal(P.suggestName({ name: 'Game', folder: 'Jogos', file: 'hades-win64-shipping' }), 'Hades');   // "Jogos" é pasta de biblioteca, não nome de jogo
  assert.equal(P.suggestName({ name: 'Game', folder: 'Meu Jogo Bonito', file: 'x' }), 'Meu Jogo Bonito');
  assert.equal(P.suggestName({ file: 'meu_jogo' }), 'Meu Jogo');
  assert.equal(P.suggestName({ name: 'Unity', product: 'Unity' }), 'Unity');   // tudo genérico: melhor que nada
  assert.equal(P.suggestName({}), '');
  assert.equal(P.suggestName(), '');
});
test('suggestName: pasta que só enfeita o nome com versão/sistema não vence o nome do programa; pasta com parte do nome do jogo vence', () => {
  assert.equal(P.suggestName({ name: 'Stremio', file: 'stremio', folder: 'Stremio-5' }), 'Stremio');
  assert.equal(P.suggestName({ name: 'Hades', file: 'hades', folder: 'Hades x64' }), 'Hades');
  assert.equal(P.suggestName({ name: 'Hades', file: 'hades', folder: 'Hades II' }), 'Hades II');   // "II" faz parte do nome
  assert.equal(P.suggestName({ name: 'hl2', file: 'hl2', folder: 'Half-Life 2' }), 'Half-Life 2');
});
test('suggestName: pastas de recipiente (System32, Tools, Server, Downloads) e nomes de assembly nunca viram nome', () => {
  assert.equal(P.suggestName({ name: 'Notepad', file: 'notepad', folder: 'System32' }), 'Notepad');
  assert.equal(P.suggestName({ name: 'MxNotify', file: 'MxNotify', folder: 'Tools' }), 'MxNotify');
  assert.equal(P.suggestName({ name: 'NDI Bridge', product: 'Application.NDI.Bridge.UI', file: 'Application.NDI.Bridge.UI' }), 'NDI Bridge');
  assert.equal(P.isGenericName('Application.NDI.Bridge.UI'), true);
  assert.equal(P.isGenericName('Application.NdiGroupEditor'), true);
  assert.equal(P.isGenericName('Node.js'), false);
  assert.equal(P.isGenericName('Battle.net'), false);
  for (const n of ['System32', 'Downloads', 'Documents', 'Tools', 'Server', 'Program Files (x86)']) assert.equal(P.isGenericName(n), true, n);
});
test('isGenericShortcutName: nome de atalho do Menu Iniciar é nome de verdade ("Unity", "Godot Engine"), mas "Win64" e "Atalho" continuam sem valor', () => {
  for (const n of ['Unity', 'Godot Engine', 'Unreal Engine']) { assert.equal(P.isGenericName(n), true, n); assert.equal(P.isGenericShortcutName(n), false, n); }
  for (const n of ['Win64', 'Application', 'Setup', 'x']) assert.equal(P.isGenericShortcutName(n), true, n);
});
test('cleanProgramName não estraga versão dentro de parênteses e tira o "Â" solto do recurso de versão', () => {
  assert.equal(P.cleanProgramName('IDLE (Python 3.12 64-bit)'), 'IDLE (Python 3.12 64-bit)');
  assert.equal(P.cleanProgramName('IDLE (Python 3.14)'), 'IDLE (Python 3.14)');
  assert.equal(P.cleanProgramName('Python 3.12 (64-bit)'), 'Python');
  assert.equal(P.cleanProgramName('MicrosoftÂ® WindowsÂ® Operating System'), 'Microsoft Windows Operating System');
  assert.equal(P.cleanProgramName('Â'), '');
});
test('suggestName nunca devolve um "$(" sem ")" (derrubaria a lista de jogos do servidor)', () => {
  assert.equal(P.suggestName({ name: 'Jogo $(quebrado' }), 'Jogo $$(quebrado');
  assert.equal(P.suggestName({ name: 'Cash$ Game' }), 'Cash$ Game');
  assert.equal(P.suggestName({ name: 'x'.repeat(200) }).length, 80);
});

/* ---------- Executáveis de uma pasta ---------- */
test('rankCandidates põe primeiro o que tem nome parecido com o da pasta e afunda launchers, configuração e crash', () => {
  const folder = 'C:\\Jogos\\Euro Truck Simulator 2';
  const r = P.rankCandidates([
    { path: `${folder}\\Launcher.exe`, name: 'Launcher.exe', size: 2 * 1048576 },
    { path: `${folder}\\bin\\win_x86\\eurotrucks2.exe`, name: 'eurotrucks2.exe', size: 31 * 1048576 },
    { path: `${folder}\\bin\\win_x64\\eurotrucks2.exe`, name: 'eurotrucks2.exe', size: 40 * 1048576 },
    { path: `${folder}\\CrashReporter.exe`, name: 'CrashReporter.exe', size: 1048576 },
  ], { folder });
  assert.equal(P.fileNameOf(r.list[0].path), 'eurotrucks2.exe');
  assert.ok(r.list[0].path.includes('win_x64'), 'a versão maior de 64 bits vem antes da de 32');
  assert.deepEqual(r.list.slice(-2).map((c) => c.name).sort(), ['CrashReporter.exe', 'Launcher.exe']);
  assert.equal(r.recommended, r.list[0]);
});
test('rankCandidates: nome igual ao da pasta é confiável; vários sem pista não são', () => {
  const folder = 'C:\\Jogos\\Hades';
  const claro = P.rankCandidates([
    { path: `${folder}\\Hades.exe`, name: 'Hades.exe', size: 50 * 1048576 },
    { path: `${folder}\\x64\\Other.exe`, name: 'Other.exe', size: 10 * 1048576 },
  ], { folder });
  assert.equal(claro.confident, true);
  assert.equal(P.fileNameOf(claro.recommended.path), 'Hades.exe');
  const duvida = P.rankCandidates([
    { path: 'C:\\Jogos\\Pacote\\a.exe', name: 'a.exe', size: 10 * 1048576 },
    { path: 'C:\\Jogos\\Pacote\\b.exe', name: 'b.exe', size: 11 * 1048576 },
  ], { folder: 'C:\\Jogos\\Pacote' });
  assert.equal(duvida.confident, false);
  assert.equal(P.pickMainExe([
    { path: 'C:\\Jogos\\Pacote\\a.exe', size: 10 * 1048576 }, { path: 'C:\\Jogos\\Pacote\\b.exe', size: 11 * 1048576 },
  ], { folder: 'C:\\Jogos\\Pacote' }), null);
  assert.equal(P.fileNameOf(P.pickMainExe([
    { path: `${folder}\\Hades.exe`, size: 5 }, { path: `${folder}\\Launcher.exe`, size: 5 },
  ], { folder }).path), 'Hades.exe');
});
test('rankCandidates: um só candidato é o recomendado; lista vazia ou lixo não quebra; mantém a ordem original no empate', () => {
  const um = P.rankCandidates([{ path: 'C:\\Jogos\\Qualquer\\x.exe', size: 1 }], { folder: 'C:\\Jogos\\Qualquer' });
  assert.equal(um.list.length, 1);
  assert.equal(um.recommended.path, 'C:\\Jogos\\Qualquer\\x.exe');
  assert.deepEqual(P.rankCandidates([], {}), { list: [], recommended: null, confident: false });
  assert.deepEqual(P.rankCandidates(null), { list: [], recommended: null, confident: false });
  assert.equal(P.rankCandidates([null, 'x', { nome: 1 }, { path: '  ' }]).list.length, 0);
  const empate = P.rankCandidates([{ path: 'C:\\a\\um.exe' }, { path: 'C:\\a\\dois.exe' }, { path: 'C:\\a\\tres.exe' }]);
  assert.deepEqual(empate.list.map((c) => c.name), ['um.exe', 'dois.exe', 'tres.exe']);
});
test('candidateTitle é o nome do arquivo sem a extensão', () => {
  assert.equal(P.candidateTitle({ path: 'C:\\x\\eurotrucks2.exe' }), 'eurotrucks2');
  assert.equal(P.candidateTitle({ name: 'Hades.exe' }), 'Hades');
});
