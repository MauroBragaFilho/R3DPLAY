// Testes do aplicativo criado a partir de um programa, do selo "N personalizados", dos arquivos soltos e das mensagens da ponte
// (ui/js/lib/programs.js + appmodel.js com o schema de verdade).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../../ui/js/lib/programs.js';
import * as M from '../../ui/js/lib/appmodel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'ui', 'schema', 'apps.json'), 'utf8'));
const prog = (over = {}) => ({ exe: 'C:\\Jogos\\Hades\\Hades.exe', args: '', dir: 'C:\\Jogos\\Hades', name: 'Hades', icon: null, kind: 'exe', ...over });

/* ---------- Aplicativo a partir de um programa ---------- */
test('appFromProgram: comando com o caminho entre aspas, pasta do programa, tela virtual e fechar ao sair ligados', () => {
  const app = P.appFromProgram(prog(), schema);
  assert.equal(app.name, 'Hades');
  assert.equal(app.cmd, '"C:\\Jogos\\Hades\\Hades.exe"');
  assert.equal(app['working-dir'], 'C:\\Jogos\\Hades');
  assert.equal(app['virtual-display'], true);
  assert.equal(app['terminate-on-pause'], true);
  assert.equal('uuid' in app, false);   // o servidor cria o uuid
});
test('appFromProgram: o resto vem dos padrões do schema (apps.json) e tem os tipos certos', () => {
  const app = P.appFromProgram(prog(), schema);
  const tpl = schema.new_app_template;
  for (const k of ['output', 'exclude-global-prep-cmd', 'exclude-global-state-cmd', 'elevated', 'auto-detach', 'wait-all', 'exit-timeout', 'prep-cmd', 'state-cmd', 'detached',
    'image-path', 'scale-factor', 'use-app-identity', 'per-client-app-identity', 'allow-client-commands', 'gamepad']) {
    assert.deepEqual(app[k], tpl[k], k);
  }
  assert.equal(typeof app['exit-timeout'], 'number');
  assert.equal(typeof app['wait-all'], 'boolean');
  assert.notEqual(app['prep-cmd'], schema.new_app_template['prep-cmd']);   // cópia: listas nunca compartilhadas entre aplicativos
});
test('appFromProgram passa na validação do editor e vai no POST sem chaves vazias proibidas', () => {
  const app = P.appFromProgram(prog({ args: '-windowed' }), schema);
  const v = M.validateApp(app, schema, { platform: 'windows' });
  assert.deepEqual(v.errors, {});
  assert.deepEqual(v.warnings, {});   // caminho entre aspas: sem o aviso de espaços; tem comando: sem o aviso "só mostra a área de trabalho"
  const payload = M.toPayload(app, schema);
  assert.equal(payload.cmd, '"C:\\Jogos\\Hades\\Hades.exe" -windowed');
  assert.equal(payload['working-dir'], 'C:\\Jogos\\Hades');
  assert.equal('detached' in payload, false);
  assert.equal('prep-cmd' in payload, false);
});
test('appFromProgram com caminho cheio de espaços, parênteses e acentos', () => {
  const p = prog({ exe: 'C:\\Program Files (x86)\\Meu Jogo Ótimo\\Jogo (Ed. Especial).exe', dir: 'C:\\Program Files (x86)\\Meu Jogo Ótimo', name: 'Jogo Ótimo' });
  const app = P.appFromProgram(p, schema);
  assert.equal(app.cmd, '"C:\\Program Files (x86)\\Meu Jogo Ótimo\\Jogo (Ed. Especial).exe"');
  assert.equal(app['working-dir'], 'C:\\Program Files (x86)\\Meu Jogo Ótimo');
  assert.deepEqual(M.validateApp(app, schema).errors, {});
  assert.equal(P.parseCommand(app.cmd).exe, p.exe);
});
test('appFromProgram protege o "$" dos caminhos e o nome contra o "$(" sem ")" (que derrubaria a lista de jogos)', () => {
  const app = P.appFromProgram(prog({ exe: 'C:\\Jogos\\$(Odd\\a.exe', dir: 'C:\\Jogos\\$(Odd', name: 'Jogo $(Odd' }), schema);
  assert.equal(app.cmd, '"C:\\Jogos\\$$(Odd\\a.exe"');
  assert.equal(app['working-dir'], 'C:\\Jogos\\$$(Odd');
  assert.equal(app.name, 'Jogo $$(Odd');
  const v = M.validateApp(app, schema);
  assert.deepEqual(v.errors, {});
  assert.equal(M.checkInterpolation(app.cmd), null);
  assert.equal(P.parseCommand(app.cmd).exe, 'C:\\Jogos\\$(Odd\\a.exe');
});
test('appFromProgram: .bat usa a pasta dele; sem pasta informada usa a do arquivo; nome pode ser trocado', () => {
  const bat = P.appFromProgram(prog({ exe: 'D:\\Jogos\\Rodar Jogo.bat', dir: 'D:\\Jogos', kind: 'bat', name: 'Rodar Jogo' }), schema);
  assert.equal(bat.cmd, '"D:\\Jogos\\Rodar Jogo.bat"');
  assert.equal(bat['working-dir'], 'D:\\Jogos');
  const semDir = P.appFromProgram(prog({ dir: '' }), schema);
  assert.equal(semDir['working-dir'], 'C:\\Jogos\\Hades');
  assert.equal(P.appFromProgram(prog(), schema, { name: 'Outro nome' }).name, 'Outro nome');
  assert.equal(P.appFromProgram(prog({ name: '  Nome com espaços nas pontas  ' }), schema).name, 'Nome com espaços nas pontas');
});
test('programFields só dá o comando e a pasta; a política dos programas é fixa', () => {
  assert.deepEqual(P.programFields(prog()), { cmd: '"C:\\Jogos\\Hades\\Hades.exe"', 'working-dir': 'C:\\Jogos\\Hades' });
  assert.deepEqual(P.programFields({ exe: 'C:\\x.exe', args: '-a' }), { cmd: '"C:\\x.exe" -a', 'working-dir': 'C:\\' });
  assert.deepEqual({ ...P.PROGRAM_POLICY }, { 'virtual-display': true, 'terminate-on-pause': true });
  assert.throws(() => { 'use strict'; P.PROGRAM_POLICY['virtual-display'] = false; });   // congelada
});

/* ---------- De onde vem o programa ---------- */
test('programFromList: nome limpo, pasta e ícone', () => {
  const p = P.programFromList({ name: 'Blender 4.2', exe: 'C:/Program Files/Blender Foundation/Blender 4.2/blender-launcher.exe', args: '', dir: '', icon: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAA' });
  assert.equal(p.name, 'Blender');
  assert.equal(p.exe, 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender-launcher.exe');
  assert.equal(p.dir, 'C:\\Program Files\\Blender Foundation\\Blender 4.2');
  assert.equal(p.fileName, 'blender-launcher.exe');
  assert.ok(p.icon);
});
test('programFromInspect: nome do programa > produto > pasta escolhida; atalho já vem resolvido; argumentos do atalho seguem', () => {
  const info = { ok: true, kind: 'exe', path: 'C:\\Jogos\\ETS2\\bin\\win_x64\\eurotrucks2.exe', args: '', dir: 'C:\\Jogos\\ETS2\\bin\\win_x64', name: 'Unity', product: 'Unity', description: 'eurotrucks2', company: '', version: '1', icon: null };
  assert.equal(P.programFromInspect(info, { folderName: 'Euro Truck Simulator 2' }).name, 'Euro Truck Simulator 2');
  assert.equal(P.programFromInspect({ ...info, name: 'Euro Truck Simulator 2' }, { folderName: 'Pasta' }).name, 'Euro Truck Simulator 2');
  const lnk = P.programFromInspect({ ...info, kind: 'lnk', path: 'C:\\Jogos\\Hades\\Hades.exe', args: '-windowed', dir: '', name: 'Hades' });
  assert.equal(lnk.exe, 'C:\\Jogos\\Hades\\Hades.exe');
  assert.equal(lnk.dir, 'C:\\Jogos\\Hades');
  assert.equal(lnk.args, '-windowed');
  assert.equal(lnk.kind, 'lnk');
  assert.equal(P.appFromProgram(lnk, schema).cmd, '"C:\\Jogos\\Hades\\Hades.exe" -windowed');
  // sem nome nenhum e com a pasta do .exe sendo só "win_x64": usa o nome do arquivo (pasta de compilação não é nome de jogo)
  assert.equal(P.programFromInspect({ ...info, name: '', product: '', description: '' }).name, 'Eurotrucks2');
});
test('programFromInspect sem pista nenhuma cai no nome da pasta e depois no do arquivo', () => {
  const vazio = { ok: true, kind: 'exe', path: 'C:\\Jogos\\Meu Jogo\\jogo.exe', args: '', dir: 'C:\\Jogos\\Meu Jogo', name: '', product: '', description: '' };
  assert.equal(P.programFromInspect(vazio).name, 'Meu Jogo');
  assert.equal(P.programFromInspect({ ...vazio, dir: '', path: 'D:\\hades.exe' }).name, 'Hades');
});

test('programFromInspect: jogo da Unreal (Binaries\\Win64\\X-Win64-Shipping.exe) sem produto nem descrição não vira "Win64"', () => {
  const info = { ok: true, kind: 'exe', path: 'C:\\Jogos\\Hades\\Binaries\\Win64\\Hades-Win64-Shipping.exe', args: '', dir: 'C:\\Jogos\\Hades\\Binaries\\Win64', name: 'Win64', product: '', description: '' };
  assert.equal(P.programFromInspect(info).name, 'Hades');
  assert.equal(P.programFromList({ name: 'Win64', exe: info.path, args: '', dir: info.dir, icon: null }).name, 'Hades');
});

/* ---------- Selo "N personalizados" ---------- */
test('customOptionCount: um aplicativo recém-criado a partir de um programa tem 0 personalizados (política e programa não contam)', () => {
  const app = P.appFromProgram(prog(), schema);
  const base = P.policyBaseline(schema);
  assert.equal(P.customOptionCount(app, schema, { base }), 0);
  assert.equal(P.customOptionCount({ ...app, cmd: '"D:\\outro.exe"', 'working-dir': 'D:\\', name: 'x', 'image-path': 'C:\\c.png' }, schema, { base }), 0);
});
test('customOptionCount conta cada opção avançada que sai do padrão (tipo de controle, tela virtual, listas, números…)', () => {
  const base = P.policyBaseline(schema);
  const app = P.appFromProgram(prog(), schema);
  assert.equal(P.customOptionCount({ ...app, gamepad: 'x360' }, schema, { base }), 1);
  assert.equal(P.customOptionCount({ ...app, 'virtual-display': false }, schema, { base }), 1);
  assert.equal(P.customOptionCount({ ...app, 'virtual-display': false, 'terminate-on-pause': false, elevated: true }, schema, { base }), 3);
  assert.equal(P.customOptionCount({ ...app, 'prep-cmd': [{ do: 'a', undo: '', elevated: false }], detached: ['x'] }, schema, { base }), 2);
  assert.equal(P.customOptionCount({ ...app, 'exit-timeout': '10' }, schema, { base }), 1);
  assert.equal(P.customOptionCount({ ...app, 'exit-timeout': 'inválido' }, schema, { base }), 0);   // texto que não é número volta ao padrão
});
test('customOptionCount respeita visible_if (identidade por cliente só conta com a identidade ligada) e sem base usa os padrões do schema', () => {
  const base = P.policyBaseline(schema);
  const app = P.appFromProgram(prog(), schema);
  assert.equal(P.customOptionCount({ ...app, 'use-app-identity': false, 'per-client-app-identity': true }, schema, { base }), 0);
  assert.equal(P.customOptionCount({ ...app, 'use-app-identity': true, 'per-client-app-identity': true }, schema, { base }), 2);
  assert.equal(P.customOptionCount(M.newApp(schema), schema), 0);
  assert.equal(P.customOptionCount(app, schema), 2);   // contra os padrões do schema, a política conta (tela virtual e fechar ao sair)
});
test('policyBaseline é o aplicativo padrão com a política ligada', () => {
  const b = P.policyBaseline(schema);
  assert.equal(b['virtual-display'], true);
  assert.equal(b['terminate-on-pause'], true);
  assert.equal(b.cmd, '');
  assert.equal(b.name, '');
});

/* ---------- Arquivos soltos ---------- */
test('classifyPath separa programa, atalho, .bat, link de loja, outro arquivo e pasta', () => {
  const t = P.classifyPath;
  assert.equal(t('C:\\Jogos\\Hades\\Hades.exe'), 'exe');
  assert.equal(t('C:\\Users\\Eu\\Desktop\\Hades.LNK'), 'lnk');
  assert.equal(t('D:\\run.bat'), 'bat');
  assert.equal(t('D:\\run.CMD'), 'bat');
  assert.equal(t('C:\\Users\\Eu\\Desktop\\Hades.url'), 'url');
  assert.equal(t('C:\\Downloads\\foto.png'), 'file');
  assert.equal(t('C:\\Downloads\\leia-me.txt'), 'file');
  assert.equal(t('C:\\Jogos\\Hades'), 'folder');
  assert.equal(t('C:\\Jogos\\Counter-Strike 1.6'), 'folder');   // "pasta.versão" não é extensão
  assert.equal(t('C:\\Jogos\\Jogo v1.0 final'), 'folder');
  assert.equal(t('D:\\'), 'folder');
  assert.equal(t(''), 'invalid');
  assert.equal(t(null), 'invalid');
});
test('classifyPath: sufixo curto desconhecido ("Dr.Mario") é incerto, não "arquivo": pode ser uma pasta', () => {
  const t = P.classifyPath;
  for (const p of ['C:\\Jogos\\Dr.Mario', 'C:\\Jogos\\CS.GO', 'C:\\Jogos\\Hades.v2', 'C:\\Jogos\\Games.Old', 'C:\\Jogos\\Euro.Truck']) assert.equal(t(p), 'unknown', p);
  for (const p of ['C:\\a\\foto.PNG', 'C:\\a\\musica.mp3', 'C:\\a\\x.zip', 'C:\\a\\x.dll']) assert.equal(t(p), 'file', p);   // arquivos comuns seguem sendo recusados direto
});
test('pickDropped: pasta provável vem antes do item incerto; item incerto sozinho segue para a confirmação', () => {
  assert.deepEqual(P.pickDropped(['C:\\Jogos\\Dr.Mario']), { ok: true, path: 'C:\\Jogos\\Dr.Mario', kind: 'unknown', extra: 0 });
  assert.deepEqual(P.pickDropped(['C:\\a\\foto.png', 'C:\\Jogos\\Dr.Mario']), { ok: true, path: 'C:\\Jogos\\Dr.Mario', kind: 'unknown', extra: 1 });
  assert.equal(P.pickDropped(['C:\\Jogos\\Dr.Mario', 'C:\\Jogos\\Hades']).path, 'C:\\Jogos\\Hades');
  assert.equal(P.pickDropped(['C:\\Jogos\\Dr.Mario', 'C:\\Jogos\\Hades\\Hades.exe']).kind, 'exe');
});
test('judgeDropped confirma com a ponte o que é um item solto incerto (pasta com ponto no nome, arquivo estranho)', () => {
  const j = P.judgeDropped;
  assert.equal(j('unknown', { ok: false, isFolder: true, error: 'Isso é uma pasta' }), 'folder');   // "Dr.Mario" era uma pasta
  assert.equal(j('folder', { ok: false, isFolder: true }), 'folder');
  assert.equal(j('unknown', { ok: true, kind: 'other', path: 'C:\\a\\dados.xyz1' }), 'other');      // arquivo existe, mas não abre como programa
  assert.equal(j('folder', { ok: true, kind: 'other', path: 'C:\\a\\LEIAME' }), 'other');            // "LEIAME" não é pasta
  assert.equal(j('unknown', { ok: true, kind: 'exe', path: 'C:\\a\\x.exe' }), 'program');
  assert.equal(j('unknown', { ok: true, kind: 'exe' }), 'other');                                     // resposta sem caminho: não adivinha
  assert.equal(j('folder', { ok: false, error: 'Não encontrei esse arquivo.' }), 'error');            // não existe
  assert.equal(j('unknown', { ok: false, error: 'Não encontrei esse arquivo.' }), 'error');
  // a ponte não soube responder (app antigo, falha): o palpite de pasta vale; o de arquivo estranho é recusado
  assert.equal(j('folder', { error: 'comando desconhecido' }), 'folder');
  assert.equal(j('unknown', { error: 'comando desconhecido' }), 'other');
  assert.equal(j('folder', null), 'folder');
  assert.equal(j('unknown', undefined), 'other');
});
test('DROP_MESSAGES.unknown não afirma que é um "tipo de arquivo" e aponta as saídas', () => {
  assert.match(P.DROP_MESSAGES.unknown, /pasta/);
  assert.match(P.DROP_MESSAGES.unknown, /\.exe/);
  assert.doesNotMatch(P.DROP_MESSAGES.unknown, /tipo de arquivo/);
});

/* ---------- Jogo de loja aberto pelo .exe ---------- */
test('storeOfPath reconhece a pasta de instalação de cada loja (e só ela)', () => {
  assert.equal(P.storeOfPath('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe'), 'steam');
  assert.equal(P.storeOfPath('D:/SteamLibrary/SteamApps/Common/Hades/Hades.exe'), 'steam');
  assert.equal(P.storeOfPath('C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe'), 'epic');
  assert.equal(P.storeOfPath('C:\\GOG Games\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe'), 'gog');
  assert.equal(P.storeOfPath('C:\\Program Files (x86)\\GOG Galaxy\\Games\\Witcher 3\\witcher3.exe'), 'gog');
  assert.equal(P.storeOfPath('C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Far Cry 6\\FarCry6.exe'), 'ubisoft');
  for (const nao of ['C:\\Jogos\\Hades\\Hades.exe', 'C:\\Program Files (x86)\\Steam\\steam.exe', 'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win32\\EpicGamesLauncher.exe',
    'C:\\Jogos\\steamapps.exe', '', null, undefined]) assert.equal(P.storeOfPath(nao), '', String(nao));
});
test('pickDropped usa o primeiro programa; prefere programa a pasta; conta os itens de fora', () => {
  assert.deepEqual(P.pickDropped(['C:\\a\\x.exe']), { ok: true, path: 'C:\\a\\x.exe', kind: 'exe', extra: 0 });
  assert.deepEqual(P.pickDropped(['C:\\a\\foto.png', 'C:\\Jogos\\Hades', 'C:\\Jogos\\Hades\\Hades.exe']), { ok: true, path: 'C:\\Jogos\\Hades\\Hades.exe', kind: 'exe', extra: 2 });
  assert.deepEqual(P.pickDropped(['C:\\Jogos\\Hades']), { ok: true, path: 'C:\\Jogos\\Hades', kind: 'folder', extra: 0 });
  assert.equal(P.pickDropped(['C:/Jogos/Hades/Hades.lnk']).path, 'C:\\Jogos\\Hades\\Hades.lnk');
});
test('pickDropped explica o que não serve (atalho de loja, outro arquivo, nada legível)', () => {
  const url = P.pickDropped(['C:\\Desktop\\Hades.url']);
  assert.equal(url.ok, false);
  assert.equal(url.kind, 'url');
  assert.match(url.message, /Detectar jogos/);
  const file = P.pickDropped(['C:\\a\\foto.png', 'C:\\a\\texto.txt']);
  assert.equal(file.ok, false);
  assert.equal(file.kind, 'file');
  assert.match(file.message, /\.exe/);
  for (const nada of [[], null, undefined, [''], [42], ['   ']]) {
    const r = P.pickDropped(nada);
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'invalid');
    assert.ok(r.message);
  }
});
test('hasFiles distingue um arquivo do Windows de uma capa arrastada na grade', () => {
  assert.equal(P.hasFiles({ dataTransfer: { types: ['Files'] } }), true);
  assert.equal(P.hasFiles({ dataTransfer: { types: ['text/plain', 'Files'] } }), true);
  assert.equal(P.hasFiles({ dataTransfer: { types: ['text/plain'] } }), false);
  assert.equal(P.hasFiles({ dataTransfer: null }), false);
  assert.equal(P.hasFiles({}), false);
  assert.equal(P.hasFiles(null), false);
});

/* ---------- Mensagens da ponte ---------- */
test('describeBridgeError: usa a mensagem em português da ponte, avisa de app antigo e esconde texto técnico em inglês', () => {
  const fb = 'Não consegui ler este arquivo.';
  assert.equal(P.describeBridgeError({ ok: false, error: 'O atalho aponta para algo que não é um programa.' }, fb), 'O atalho aponta para algo que não é um programa.');
  assert.equal(P.describeBridgeError({ error: 'comando desconhecido' }, fb), 'Esta versão do aplicativo ainda não tem esta função. Atualize o R3D PLAY ou use "Preencher tudo manualmente".');
  assert.equal(P.describeBridgeError({ error: 'System.IO.FileNotFoundException: Could not find file' }, fb), fb);
  assert.equal(P.describeBridgeError({ error: 'Object reference not set to an instance of an object.' }, fb), fb);
  assert.equal(P.describeBridgeError({}, fb), fb);
  assert.equal(P.describeBridgeError(null, fb), fb);
  assert.equal(P.describeBridgeError({ error: '   ' }, fb), fb);
});
