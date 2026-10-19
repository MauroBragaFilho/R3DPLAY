// Testes da lógica pura de aplicativos (ui/js/lib/appmodel.js): normalização, validação, diff, ordem, filtros e origem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../../ui/js/lib/appmodel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'ui', 'schema', 'apps.json'), 'utf8'));
const byKey = (k) => schema.fields.find((f) => f.key === k);

/* ---------- Conversões ---------- */
test('coerceBool aceita booleanos reais, texto legado e cai no padrão', () => {
  assert.equal(M.coerceBool(true), true);
  assert.equal(M.coerceBool('true'), true);
  assert.equal(M.coerceBool('False'), false);
  assert.equal(M.coerceBool(1), true);
  assert.equal(M.coerceBool(0), false);
  assert.equal(M.coerceBool('on'), true);
  assert.equal(M.coerceBool(undefined, true), true);
  assert.equal(M.coerceBool('talvez', true), true);
  assert.equal(M.coerceBool(NaN, true), true);
});
test('coerceInt só aceita inteiro; o resto vira o padrão (0 é válido)', () => {
  assert.equal(M.coerceInt(5, 9), 5);
  assert.equal(M.coerceInt('12', 9), 12);
  assert.equal(M.coerceInt(0, 9), 0);
  assert.equal(M.coerceInt('0', 9), 0);
  assert.equal(M.coerceInt(' -3 ', 9), -3);
  assert.equal(M.coerceInt('abc', 9), 9);
  assert.equal(M.coerceInt('1,5', 9), 9);
  assert.equal(M.coerceInt(null, 9), 9);
  assert.equal(M.coerceInt(NaN, 9), 9);
  assert.equal(M.coerceInt(Infinity, 9), 9);
  assert.equal(M.coerceInt(7.9, 9), 7);
});
test('cleanText e cleanImagePath removem quebra de linha, aspas e espaços das pontas', () => {
  assert.equal(M.cleanText('  a\r\nb  '), 'a b');
  assert.equal(M.cleanText(null), '');
  assert.equal(M.cleanImagePath('  "C:\\x y\\capa.png"  '), 'C:\\x y\\capa.png');
  assert.equal(M.isPngPath('a/b/C.PNG'), true);
  assert.equal(M.isPngPath('capa.jpg'), false);
  assert.equal(M.isPngPath(''), false);
});
test('isPngBytes reconhece a assinatura do PNG', () => {
  assert.equal(M.isPngBytes(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), true);
  assert.equal(M.isPngBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), false);
  assert.equal(M.isPngBytes(Uint8Array.from([0x89, 0x50])), false);
  assert.equal(M.isPngBytes(null), false);
});

/* ---------- $(VAR) ---------- */
test('checkInterpolation espelha o parse_env_val do servidor', () => {
  assert.equal(M.checkInterpolation(''), null);
  assert.equal(M.checkInterpolation('cmd /C echo %APOLLO_CLIENT_FPS%'), null);
  assert.equal(M.checkInterpolation('$(PATH)'), null);
  assert.equal(M.checkInterpolation('$(A(b))'), null);               // aninhado fecha
  assert.equal(M.checkInterpolation('preço $ 10'), null);             // $ solto é ignorado
  assert.equal(M.checkInterpolation('termina com $'), null);
  assert.equal(M.checkInterpolation('$$(não é variável'), null);      // $$ vira $ literal: o ( seguinte é comum
  assert.equal(M.checkInterpolation('$${HOME}'), null);
  assert.match(M.checkInterpolation('$(sem fim'), /\$\(/);
  assert.match(M.checkInterpolation('x $(A(b)'), /\$\(/);             // parêntese interno sem par
  assert.match(M.checkInterpolation('powershell -c "$(Get-Date)" $(x'), /\$\(/);
  assert.equal(M.checkInterpolation('powershell -c "$$(Get-Date)"'), null);
});

/* ---------- Schema e campos ---------- */
test('newApp nasce do new_app_template, com cópia profunda e nome vazio', () => {
  const a = M.newApp(schema);
  assert.equal(a.name, '');
  assert.equal(a.uuid, undefined);
  assert.equal(a['exit-timeout'], 5);
  assert.equal(a['scale-factor'], 100);
  assert.equal(a['auto-detach'], true);
  assert.equal(a['allow-client-commands'], true);
  assert.equal(a['virtual-display'], false);
  assert.deepEqual(a['prep-cmd'], []);
  assert.equal(a._notes, undefined);
  a['prep-cmd'].push({ do: 'x', undo: '', elevated: false });
  assert.deepEqual(M.newApp(schema)['prep-cmd'], [], 'a lista do segundo app não pode vazar do primeiro');
  assert.deepEqual(schema.new_app_template['prep-cmd'], [], 'o modelo do schema não pode ser alterado');
});
test('normalizeApp completa defaults, converte tipos e preserva chaves desconhecidas', () => {
  const a = M.normalizeApp({
    uuid: 'ABC', name: '  Meu Jogo ', 'exit-timeout': '7', elevated: 'true', 'terminate-on-pause': 'false',
    'prep-cmd': [{ do: 'a', undo: '', elevated: 'true' }, { do: '', undo: '' }, 'lixo', { undo: 'u' }],
    detached: ['  x  ', '', 5], launching: true, id: 3, minha_chave: { ok: 1 },
  }, schema);
  assert.equal(a.name, 'Meu Jogo');
  assert.equal(a['exit-timeout'], 7);
  assert.equal(a.elevated, true);
  assert.equal(a['terminate-on-pause'], false);
  assert.equal(a['scale-factor'], 100);
  assert.deepEqual(a['prep-cmd'], [{ do: 'a', undo: '', elevated: true }, { do: '', undo: 'u', elevated: false }]);
  assert.deepEqual(a.detached, ['x', '5']);
  assert.equal(a.launching, undefined);
  assert.equal(a.id, undefined);
  assert.deepEqual(a.minha_chave, { ok: 1 });
  assert.equal(a.uuid, 'ABC');
});
test('normalizeApp é idempotente e não altera a entrada', () => {
  const raw = { name: 'X', uuid: 'U', 'prep-cmd': [{ do: 'a', undo: 'b' }] };
  const copia = JSON.parse(JSON.stringify(raw));
  const n1 = M.normalizeApp(raw, schema);
  assert.deepEqual(raw, copia);
  assert.deepEqual(M.normalizeApp(n1, schema), n1);
});
test('per-client-app-identity só vale com use-app-identity ligado', () => {
  assert.equal(M.normalizeApp({ name: 'x', 'per-client-app-identity': true }, schema)['per-client-app-identity'], false);
  assert.equal(M.normalizeApp({ name: 'x', 'use-app-identity': true, 'per-client-app-identity': true }, schema)['per-client-app-identity'], true);
});
test('toPayload omite working-dir, detached e prep-cmd vazios e nunca manda uuid vazio', () => {
  const p = M.toPayload({ name: 'X', 'working-dir': '', uuid: '', detached: [], 'prep-cmd': [] }, schema);
  assert.equal('working-dir' in p, false);
  assert.equal('detached' in p, false);
  assert.equal('prep-cmd' in p, false);
  assert.equal('uuid' in p, false);
  assert.deepEqual(p['state-cmd'], []);
  const q = M.toPayload({ name: 'X', 'working-dir': 'C:\\Jogos', detached: ['a'], 'prep-cmd': [{ do: 'a', undo: '' }] }, schema);
  assert.equal(q['working-dir'], 'C:\\Jogos');
  assert.deepEqual(q.detached, ['a']);
  assert.deepEqual(q['prep-cmd'], [{ do: 'a', undo: '', elevated: false }]);
  // tipos exigidos pelo servidor: booleanos e inteiros de verdade
  for (const f of schema.fields) {
    if (f.type === 'toggle') assert.equal(typeof q[f.key], 'boolean', f.key);
    if (f.type === 'number') assert.equal(Number.isInteger(q[f.key]), true, f.key);
  }
});
test('todo campo do schema entra no app normalizado (menos o uuid, que o servidor gera)', () => {
  const a = M.normalizeApp({ name: 'X' }, schema);
  for (const f of schema.fields) if (f.key !== 'uuid') assert.ok(f.key in a, f.key);
});

/* ---------- Interruptores ---------- */
test('interruptores invertidos mostram o oposto do valor gravado', () => {
  const f = byKey('exclude-global-prep-cmd');
  assert.equal(M.toggleChecked(f, false), true);    // grava false = usa os globais = marcado
  assert.equal(M.toggleChecked(f, true), false);
  assert.equal(M.toggleFromChecked(f, true), false);
  assert.equal(M.toggleFromChecked(f, false), true);
  const g = byKey('virtual-display');
  assert.equal(M.toggleChecked(g, true), true);
  assert.equal(M.toggleFromChecked(g, true), true);
});
test('dica de padrão considera a inversão', () => {
  assert.equal(M.toggleHint(byKey('exclude-global-prep-cmd'), schema), 'Padrão: marcado');
  assert.equal(M.toggleHint(byKey('exclude-global-state-cmd'), schema), 'Padrão: marcado');
  assert.equal(M.toggleHint(byKey('virtual-display'), schema), 'Padrão: desmarcado');
  assert.equal(M.toggleHint(byKey('auto-detach'), schema), 'Padrão: marcado');
  assert.equal(M.toggleHint(byKey('allow-client-commands'), schema), 'Padrão: marcado');
  assert.equal(M.toggleHint(byKey('terminate-on-pause'), schema), 'Padrão: desmarcado');
});
test('plataforma e visible_if escondem campos', () => {
  const app = M.normalizeApp({ name: 'x' }, schema);
  assert.equal(M.fieldVisible(byKey('elevated'), app, 'windows'), true);
  assert.equal(M.fieldVisible(byKey('elevated'), app, 'linux'), false);
  assert.equal(M.fieldVisible(byKey('per-client-app-identity'), app, 'windows'), false);
  assert.equal(M.fieldVisible(byKey('per-client-app-identity'), { ...app, 'use-app-identity': true }, 'windows'), true);
  assert.equal(M.fieldVisible(byKey('name'), app, 'macos'), true);
  assert.deepEqual(M.selectOptions(byKey('gamepad'), 'windows').map((o) => o.value), ['', 'disabled', 'auto', 'ds4', 'x360']);
  assert.deepEqual(M.selectOptions(byKey('gamepad'), 'linux').map((o) => o.value), ['', 'disabled', 'auto', 'ds5', 'switch', 'xone']);
});

/* ---------- Validação ---------- */
const val = (over, platform = 'windows') => M.validateApp({ ...M.newApp(schema), name: 'Jogo', ...over }, schema, { platform });
test('validação: app novo válido não tem erros; nome vazio tem', () => {
  assert.deepEqual(val({}).errors, {});
  assert.match(val({ name: '   ' }).errors.name, /nome/i);
  assert.match(M.validateApp(M.newApp(schema), schema).errors.name, /nome/i);
});
test('validação: números (faixa, texto, vazio = padrão, zero é válido)', () => {
  assert.deepEqual(val({ 'exit-timeout': '0' }).errors, {});
  assert.deepEqual(val({ 'exit-timeout': '' }).errors, {});
  assert.deepEqual(val({ 'exit-timeout': 0 }).errors, {});
  assert.match(val({ 'exit-timeout': '-1' }).errors['exit-timeout'], /menor valor é 0/);
  assert.match(val({ 'exit-timeout': 'abc' }).errors['exit-timeout'], /inteiro/);
  assert.match(val({ 'exit-timeout': '2,5' }).errors['exit-timeout'], /inteiro/);
  assert.match(val({ 'scale-factor': '19' }).errors['scale-factor'], /20% a 200%/);
  assert.match(val({ 'scale-factor': '201' }).errors['scale-factor'], /20% a 200%/);
  assert.deepEqual(val({ 'scale-factor': '200' }).errors, {});
  assert.deepEqual(val({ 'scale-factor': '20' }).errors, {});
  assert.deepEqual(val({ 'scale-factor': 'x' }, 'linux').errors, {}, 'campo escondido nesta plataforma não é validado');
});
test('validação: $( sem ) em qualquer campo de texto ou lista', () => {
  assert.ok(val({ cmd: 'a $(x' }).errors.cmd);
  assert.ok(val({ 'working-dir': '$(' }).errors['working-dir']);
  assert.ok(val({ output: '$(' }).errors.output);
  assert.ok(val({ name: 'Jogo $(' }).errors.name);
  assert.match(val({ detached: ['ok', 'a $(b'] }).errors.detached, /Comando 2/);
  assert.match(val({ 'prep-cmd': [{ do: '', undo: '$(x', elevated: false }] }).errors['prep-cmd'], /Comando 1 \(desfazer\)/);
  assert.match(val({ 'state-cmd': [{ do: '$(', undo: '', elevated: false }] }).errors['state-cmd'], /executar/);
  assert.deepEqual(val({ cmd: 'powershell -c "$$(Get-Date)"' }).errors, {});
});
test('validação: imagem precisa ser PNG', () => {
  assert.ok(val({ 'image-path': 'C:\\capas\\a.jpg' }).errors['image-path']);
  assert.deepEqual(val({ 'image-path': '"C:\\capas\\a.PNG"' }).errors, {});
  assert.deepEqual(val({ 'image-path': '' }).errors, {});
  assert.deepEqual(val({ 'image-path': 'steam.png' }).errors, {});
});
test('validação: controle de jogo precisa existir na plataforma', () => {
  assert.deepEqual(val({ gamepad: 'x360' }).errors, {});
  assert.ok(val({ gamepad: 'ds5' }, 'windows').errors.gamepad);
  assert.deepEqual(val({ gamepad: 'ds5' }, 'linux').errors, {});
  assert.deepEqual(val({ gamepad: 'qualquer' }, 'macos').errors, {}, 'sem gamepad no macOS');
});
test('validação: identidade própria exige uuid de 36 caracteres', () => {
  assert.ok(val({ 'use-app-identity': true, uuid: 'curto' }).errors['use-app-identity']);
  assert.deepEqual(val({ 'use-app-identity': true, uuid: '8E6B3F3E-5C41-4B8E-9C0B-1D6E5D9A7F11' }).errors, {});
  assert.deepEqual(val({ 'use-app-identity': false, uuid: 'curto' }).errors, {});
});
test('avisos: caminho com espaço sem aspas e aplicativo sem comando', () => {
  assert.match(val({ cmd: 'C:\\Program Files\\Jogo\\jogo.exe -windowed' }).warnings.cmd, /aspas/);
  assert.equal(val({ cmd: '"C:\\Program Files\\Jogo\\jogo.exe" -windowed' }).warnings.cmd, undefined);
  assert.equal(val({ cmd: 'C:\\Jogos\\jogo.exe --modo janela' }).warnings.cmd, undefined);
  assert.match(val({ cmd: '' }).warnings.cmd, /área de trabalho/);
  assert.equal(val({ cmd: '', detached: ['steam://rungameid/1'] }).warnings.cmd, undefined);
});

/* ---------- Diff e mesclagem ---------- */
test('changedKeys ignora o que é só diferença de preenchimento', () => {
  const antigo = { name: 'A', uuid: 'U', detached: ['x'] };
  const form = M.normalizeApp(antigo, schema);
  assert.deepEqual(M.changedKeys(antigo, form, schema), [], 'completar defaults não é mudança');
  const editado = { ...form, name: 'B', 'exit-timeout': 9 };
  assert.deepEqual(M.changedKeys(antigo, editado, schema).sort(), ['exit-timeout', 'name']);
  assert.deepEqual(M.changedKeys(antigo, { ...form, name: ' A ' }, schema), []);
});
test('mergeEdit aplica só o que o usuário mudou sobre a versão atual do servidor', () => {
  const original = { uuid: 'U', name: 'A', cmd: 'a.exe', 'image-path': '', extra: 1 };
  const edited = { ...M.normalizeApp(original, schema), name: 'B' };
  // enquanto o editor estava aberto, a capa foi gravada por outro caminho
  const fresh = { ...original, 'image-path': 'C:/x/covers/U.png', outra: 'preservada' };
  const out = M.mergeEdit(fresh, original, edited, schema);
  assert.equal(out.name, 'B');
  assert.equal(out['image-path'], 'C:/x/covers/U.png');
  assert.equal(out.outra, 'preservada');
  assert.equal(out.extra, 1);
  assert.equal(out.uuid, 'U');
  assert.equal(out.cmd, 'a.exe');
});
test('advancedCustomCount conta só campos avançados diferentes do padrão', () => {
  assert.equal(M.advancedCustomCount({ name: 'x' }, schema), 0);
  assert.equal(M.advancedCustomCount({ name: 'x', 'exit-timeout': 9, detached: ['a'], 'wait-all': false }, schema), 3);
  assert.equal(M.advancedCustomCount({ name: 'x', elevated: true }, schema, 'linux'), 0);
});

/* ---------- Origem ---------- */
test('guessSource reconhece o jogo pelos comandos', () => {
  assert.equal(M.guessSource({ detached: ['steam://rungameid/220'] }), 'steam');
  assert.equal(M.guessSource({ detached: ['"C:\\x\\ApolloConfig.exe" --launch-steam 220 source'] }), 'steam');
  assert.equal(M.guessSource({ detached: ['com.epicgames.launcher://apps/a%3Ab%3Ac?action=launch'] }), 'epic');
  assert.equal(M.guessSource({ detached: ['uplay://launch/123/0'] }), 'ubisoft');
  assert.equal(M.guessSource({ cmd: '"C:\\GOG Games\\X\\x.exe"' }), 'gog');
  assert.equal(M.guessSource({ cmd: 'notepad.exe' }), '');
  assert.equal(M.guessSource({ 'prep-cmd': [{ undo: '"x.exe" --close-dir "D:\\Games\\Steam\\steamapps\\common\\Y"' }] }), '', 'o nome da pasta Steam sozinho não decide');
  assert.equal(M.guessSource(null), '');
});
test('sourceOf: scanner manda; depois o palpite; depois "other"', () => {
  assert.equal(M.sourceOf({ detached: ['steam://x'] }, 'gog'), 'gog');
  assert.equal(M.sourceOf({ detached: ['steam://x'] }, undefined), 'steam');
  assert.equal(M.sourceOf({ cmd: 'x' }, 'invalida'), 'other');
  assert.equal(M.sourceLabel('other'), 'Aplicativo');
  assert.equal(M.sourceLabel('steam'), 'Steam');
});

/* ---------- Busca, filtro, ordem ---------- */
const A = (name, uuid = name) => ({ name, uuid });
test('busca ignora acento e maiúsculas', () => {
  assert.equal(M.matchesQuery('Ação Total', 'acao'), true);
  assert.equal(M.matchesQuery('Half-Life 2', 'LIFE'), true);
  assert.equal(M.matchesQuery('Half-Life 2', ''), true);
  assert.equal(M.matchesQuery('Half-Life 2', 'portal'), false);
});
test('filterApps combina busca e origem', () => {
  const apps = [A('Half-Life'), A('Fortnite'), A('Portal')];
  const src = { 'Half-Life': 'steam', Fortnite: 'epic', Portal: 'steam' };
  const sourceOf = (a) => src[a.name];
  assert.deepEqual(M.filterApps(apps, { sourceOf }).map((a) => a.name), ['Half-Life', 'Fortnite', 'Portal']);
  assert.deepEqual(M.filterApps(apps, { source: 'steam', sourceOf }).map((a) => a.name), ['Half-Life', 'Portal']);
  assert.deepEqual(M.filterApps(apps, { source: 'steam', query: 'por', sourceOf }).map((a) => a.name), ['Portal']);
  assert.deepEqual(M.filterApps(apps, { source: 'gog', sourceOf }), []);
});
test('ordenação alfabética em português, com números naturais', () => {
  const apps = [A('Zelda'), A('Ábaco'), A('abelha'), A('Jogo 10'), A('Jogo 2')];
  assert.deepEqual(M.sortByName(apps).map((a) => a.name), ['Ábaco', 'abelha', 'Jogo 2', 'Jogo 10', 'Zelda']);
  assert.equal(M.isAlphabetized(M.sortByName(apps)), true);
  assert.equal(M.isAlphabetized(apps), false);
  assert.equal(M.isAlphabetized([]), true);
});
test('orderedApps/moveUuid/stepUuid não perdem nem duplicam itens', () => {
  const apps = ['a', 'b', 'c', 'd'].map((u) => A(u.toUpperCase(), u));
  assert.deepEqual(M.orderedApps(apps, ['c', 'a']).map((a) => a.uuid), ['c', 'a', 'b', 'd']);
  assert.deepEqual(M.orderedApps(apps, ['x', 'c', 'c']).map((a) => a.uuid), ['c', 'a', 'b', 'd']);
  assert.equal(M.orderedApps(apps, null), apps);
  const o = ['a', 'b', 'c', 'd'];
  assert.deepEqual(M.moveUuid(o, 'a', 'c', false), ['b', 'a', 'c', 'd']);
  assert.deepEqual(M.moveUuid(o, 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.deepEqual(M.moveUuid(o, 'd', 'a', false), ['d', 'a', 'b', 'c']);
  assert.deepEqual(M.moveUuid(o, 'a', 'a', true), o);
  assert.deepEqual(M.moveUuid(o, 'x', 'a', true), o);
  assert.deepEqual(M.stepUuid(o, 'b', 1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(M.stepUuid(o, 'a', -1), o);
  assert.deepEqual(M.stepUuid(o, 'd', 1), o);
  assert.deepEqual(M.stepUuid(o, 'd', -2), ['a', 'd', 'b', 'c']);
  assert.equal(M.sameOrder(o, [...o]), true);
  assert.equal(M.sameOrder(o, ['a', 'b']), false);
  assert.deepEqual(o, ['a', 'b', 'c', 'd'], 'a entrada não pode ser alterada');
});
test('placeholderFor: ícone para apps do sistema, inicial para o resto', () => {
  assert.deepEqual(M.placeholderFor({ name: 'Desktop' }), { kind: 'icon', name: 'desktop_windows' });
  assert.deepEqual(M.placeholderFor({ name: 'Steam Big Picture' }), { kind: 'icon', name: 'sports_esports' });
  assert.deepEqual(M.placeholderFor({ name: 'x', 'image-path': 'steam.png' }), { kind: 'icon', name: 'sports_esports' });
  assert.deepEqual(M.placeholderFor({ name: 'ração' }), { kind: 'letter', text: 'R' });
  assert.deepEqual(M.placeholderFor({ name: '™ Jogo' }), { kind: 'letter', text: 'J' });
  assert.deepEqual(M.placeholderFor({ name: '' }), { kind: 'letter', text: '?' });
  assert.deepEqual(M.placeholderFor({}), { kind: 'letter', text: '?' });
});

/* ---------- Correções da revisão ---------- */
test('coerceInt: número grande demais para ser inteiro seguro vira o padrão', () => {
  assert.equal(M.coerceInt('99999999999999999999', 5), 5);
  assert.equal(M.coerceInt(1e20, 5), 5);
  assert.equal(M.coerceInt('-99999999999999999999', 5), 5);
  assert.equal(M.coerceInt(2147483647, 5), 2147483647);
  assert.equal(M.coerceInt(9007199254740991, 5), 9007199254740991);
});
test('validação: campo sem máximo no schema (exit-timeout) recusa o que não cabe no inteiro do servidor', () => {
  assert.equal(byKey('exit-timeout').max, undefined, 'o teste só faz sentido enquanto o schema não declara máximo');
  assert.deepEqual(val({ 'exit-timeout': '2147483647' }).errors, {});
  assert.match(val({ 'exit-timeout': '2147483648' }).errors['exit-timeout'], /grande demais/);
  assert.match(val({ 'exit-timeout': '99999999999' }).errors['exit-timeout'], /grande demais/);
  assert.match(val({ 'exit-timeout': '99999999999999999999' }).errors['exit-timeout'], /grande demais/);
  assert.match(val({ 'exit-timeout': '99999999999999999999999' }).errors['exit-timeout'], /grande demais/, '23 dígitos viram 1e+23 no JSON');
  // a faixa declarada continua mandando a mensagem
  assert.match(val({ 'scale-factor': '99999999999' }).errors['scale-factor'], /20% a 200%/);
  // o que passou pela normalização nunca sai fora do inteiro seguro
  const n = M.normalizeApp({ name: 'a', 'exit-timeout': '99999999999999999999' }, schema);
  assert.equal(n['exit-timeout'], 5);
});
test('validação: com imagem nova escolhida o texto do campo de imagem não bloqueia (skipImage)', () => {
  const ruim = { name: 'a', 'image-path': 'C:\\imgs\\capa.jpg' };
  assert.ok(M.validateApp(ruim, schema).errors['image-path']);
  assert.deepEqual(M.validateApp(ruim, schema, { skipImage: true }).errors, {});
  // skipImage só afeta a imagem: o resto continua validado
  assert.ok(M.validateApp({ ...ruim, name: '' }, schema, { skipImage: true }).errors.name);
});
test('safeInterpolation escapa o "$" só quando o servidor não conseguiria ler o texto', () => {
  assert.equal(M.safeInterpolation('Jogo normal'), 'Jogo normal');
  assert.equal(M.safeInterpolation('C:\\Jogos\\$(PATH)\\x'), 'C:\\Jogos\\$(PATH)\\x', 'variável bem formada não é tocada');
  assert.equal(M.safeInterpolation('Preço $$ 5'), 'Preço $$ 5');
  const bom = M.safeInterpolation('Pasta $(Aberta');
  assert.equal(bom, 'Pasta $$(Aberta');
  assert.equal(M.checkInterpolation(bom), null);
  assert.equal(M.safeInterpolation(M.safeInterpolation('a $(b')), 'a $$(b', 'idempotente');
  assert.equal(M.safeInterpolation(null), '');
});
test('sanitizeInterpolations cobre todos os campos que o servidor expande e não altera a entrada', () => {
  const app = {
    name: 'Jogo $(X', cmd: 'a $(', 'working-dir': '$(', output: '$(', 'image-path': 'covers/$(a.png',
    detached: ['ok', 'b $('], 'prep-cmd': [{ do: '$(', undo: 'ok', elevated: false }], 'state-cmd': [{ do: 'ok', undo: '$(', elevated: true }],
    'terminate-on-pause': true,
  };
  const copia = structuredClone(app);
  const out = M.sanitizeInterpolations(app);
  assert.deepEqual(app, copia);
  const v = M.validateApp(out, schema);
  assert.deepEqual(v.errors, {}, 'depois de escapar, nada derruba o carregamento do servidor');
  assert.equal(out['terminate-on-pause'], true);
  assert.equal(out['state-cmd'][0].elevated, true);
  assert.equal(M.sanitizeInterpolations(null), null);
});
