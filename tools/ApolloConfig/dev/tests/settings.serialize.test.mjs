// Casos de borda e de erro de js/lib/serialize.js (regras de ui/schema/_serializacao.md, seções 3, 8 e 9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog } from './settings.fixtures.test.mjs';
import {
  parseBool, boolVocab, formatBool, parseNumberText, checkRange, normalizeText, validateText, finalizeList, validateList,
  bracketsBalanced, ensureRemap, finalizeRemap, validateRemap, parseFile, canon, validateValue, toFile, createModel, sortKeysDeep,
  newListItem, listColumns, defaultDraft, isDefaultDraft, NEVER_SEND, flattenBracketLines, partialRows, restoreDraft,
} from '../../ui/js/lib/serialize.js';
import { checkValue } from '../../ui/js/lib/config.js';

const opt = (k) => catalog.byKey.get(k);
const model = (values = {}, platform = 'windows') => { const m = createModel(catalog, { platform }); m.load(values); return m; };
const noFresh = {};

/* ---------- booleanos ---------- */
test('booleano: leitura como o servidor (bool_f), com a armadilha de caixa alta e do caractere 1', () => {
  for (const t of ['enabled', 'enable', 'true', 'yes', 'on', '1', '10', 'a1b']) assert.equal(parseBool(t), true, t);
  for (const t of ['disabled', 'disable', 'false', 'no', 'off', '0', 'Enabled', 'TRUE', 'ON', 'banana', ' ']) assert.equal(parseBool(t), false, t);
  assert.equal(parseBool(''), undefined);
  assert.equal(parseBool(undefined), undefined);
  assert.equal(parseBool(null), undefined);
});

test('booleano: preserva o vocabulário que já está no arquivo', () => {
  assert.deepEqual(boolVocab('on'), ['on', 'off']);
  assert.deepEqual(boolVocab('NO'), ['yes', 'no']);
  assert.deepEqual(boolVocab('1'), ['1', '0']);
  assert.deepEqual(boolVocab('true'), ['true', 'false']);
  assert.deepEqual(boolVocab('enable'), ['enable', 'disable']);
  assert.deepEqual(boolVocab('Enabled'), ['enabled', 'disabled']);   // devolve a forma minúscula
  assert.deepEqual(boolVocab('2'), ['enabled', 'disabled']);         // fora da lista: enabled/disabled
  assert.deepEqual(boolVocab(undefined), ['enabled', 'disabled']);
  assert.equal(formatBool(true, 'off'), 'on');
  assert.equal(formatBool(false, 'yes'), 'no');
  assert.equal(formatBool(false, undefined), 'disabled');
  assert.equal(formatBool(true, 'Disabled'), 'enabled');             // nunca devolve maiúsculas
});

test('booleano: ao editar, mantém o vocabulário do arquivo (on/off, yes/no, 1/0, true/false)', () => {
  for (const [orig, off] of [['on', 'off'], ['yes', 'no'], ['1', '0'], ['true', 'false'], ['enable', 'disable']]) {
    const m = model({ mouse: orig });            // mouse: padrão ligado
    assert.equal(m.draft.mouse, true, orig);
    m.set('mouse', false);
    assert.equal(m.buildSave({ mouse: orig }).body.mouse, off, orig);
  }
  const m = model({ upnp: 'off' });              // upnp: padrão desligado; ligar escreve "on"
  assert.equal(m.draft.upnp, false);
  m.set('upnp', true);
  assert.equal(m.buildSave({ upnp: 'off' }).body.upnp, 'on');
  const w = model({ mouse: 'Enabled' });         // "Enabled" o servidor lê como desligado; editar corrige para minúsculas
  assert.equal(w.draft.mouse, false);
  w.set('mouse', true);
  assert.equal(w.isDirty('mouse'), true);
});

test('booleano: voltar ao padrão remove a chave; ligar o que é padrão desligado grava enabled', () => {
  const m = model({ upnp: 'enabled' });
  m.set('upnp', false);
  const s = m.buildSave({ upnp: 'enabled', port: '48000' });
  assert.equal('upnp' in s.body, false);
  assert.equal(s.body.port, '48000');
  const n = model({});
  n.set('upnp', true);
  assert.equal(n.buildSave({}).body.upnp, 'enabled');
});

/* ---------- números ---------- */
test('número inteiro: só dígitos, sem decimais nem espaços internos', () => {
  const ok = { ' 47989 ': '47989', '007': '7', '-1': '-1', '-0': '0', '0': '0', '2147483647': '2147483647' };
  for (const [t, v] of Object.entries(ok)) assert.equal(parseNumberText(t).value, v, JSON.stringify(t));
  for (const t of ['24.9', '24,9', '1e3', '0x10', 'abc', '--1', '+5', '1 000', '１２', '5.', '.5', '2147483648', '-2147483649', '99999999999999999999']) {
    assert.ok(parseNumberText(t).error, `deveria rejeitar ${JSON.stringify(t)}`);
  }
  assert.equal(parseNumberText('').empty, true);
  assert.equal(parseNumberText('   ').empty, true);
  assert.equal(parseNumberText(undefined).empty, true);
});

test('número real: aceita vírgula e ponto, normaliza zeros', () => {
  const ok = { '24,9': '24.9', '24.90': '24.9', '30': '30', '1000.0': '1000', '007.50': '7.5', '0.0': '0', '59.9558': '59.9558', ' 12,50 ': '12.5' };
  for (const [t, v] of Object.entries(ok)) assert.equal(parseNumberText(t, true).value, v, t);
  for (const t of ['1,2,3', 'abc', '1e3', '.5', '5.', '1..2']) assert.ok(parseNumberText(t, true).error, t);
});

test('número: faixa do schema (port 1029..65514, minimum_fps_target 0..1000, min_threads >= 1)', () => {
  const v = (k, t) => validateValue(opt(k), t);
  assert.ok(v('port', '1028').error);
  assert.match(v('port', '1028').error, /mínimo é 1029/);
  assert.deepEqual(v('port', '1029'), {});
  assert.deepEqual(v('port', '65514'), {});
  assert.match(v('port', '65515').error, /máximo é 65514/);
  assert.ok(v('port', '47989.5').error);
  assert.ok(v('port', 'abc').error);
  assert.deepEqual(v('port', ''), {});                       // vazio = usar o padrão
  assert.match(v('ping_timeout', '-2').error, /mínimo é -1 ms/);
  assert.deepEqual(v('ping_timeout', '-1'), {});
  assert.deepEqual(v('back_button_timeout', '-1'), {});      // sem mínimo de propósito
  assert.deepEqual(v('qp', '-5'), {});
  assert.match(v('min_threads', '0').error, /mínimo é 1/);
  assert.deepEqual(v('fec_percentage', '255'), {});
  assert.match(v('fec_percentage', '256').error, /máximo/);
  assert.match(v('fec_percentage', '0').error, /mínimo/);
  assert.deepEqual(v('nvenc_vbv_increase', '400'), {});
  assert.ok(v('nvenc_vbv_increase', '401').error);
  assert.deepEqual(v('key_repeat_frequency', '24,9'), {});   // real
  assert.ok(v('key_repeat_frequency', '-1').error);
  assert.deepEqual(v('minimum_fps_target', '59.94'), {});
  assert.ok(v('minimum_fps_target', '1000.5').error);
  assert.ok(v('dd_config_revert_delay', '99999999999').error);
  assert.deepEqual(v('dd_wa_hdr_toggle_delay', '3000'), {});
  assert.ok(v('dd_wa_hdr_toggle_delay', '3001').error);
  assert.equal(checkRange({ min: 1, max: 3 }, 2), '');
  assert.equal(checkRange({}, 1e9), '');
});

test('número: gravado como texto puro; vazio e igual ao padrão saem do arquivo', () => {
  const m = model({});
  m.set('port', ' 48000 ');
  assert.equal(m.buildSave({}).body.port, '48000');
  m.set('port', '47989');                                    // padrão
  assert.equal(m.isDirty('port'), false);
  const n = model({ port: '48000' });
  n.set('port', '47989');
  assert.equal('port' in n.buildSave({ port: '48000' }).body, false);
  n.set('port', '');                                         // em branco = padrão
  assert.equal('port' in n.buildSave({ port: '48000' }).body, false);
  assert.equal(n.isDefault('port'), true);
  const r = model({});
  r.set('key_repeat_frequency', '12,5');
  assert.equal(r.buildSave({}).body.key_repeat_frequency, '12.5');
  r.set('key_repeat_frequency', '24.90');                    // 24.9 é o padrão, escrito de outro jeito
  assert.equal(r.isDirty('key_repeat_frequency'), false);
});

test('número inválido no arquivo: não bloqueia, não suja e é preservado; só valida se for editado', () => {
  const m = model({ port: 'abc', qp: '30' });
  assert.equal(m.draft.port, 'abc');
  assert.equal(m.isDirty('port'), false);
  m.set('qp', '31');
  const s = m.buildSave({ port: 'abc', qp: '30' });
  assert.equal(s.ok, true);
  assert.equal(s.body.port, 'abc');
  m.set('port', 'xyz');
  assert.equal(m.buildSave({ port: 'abc' }).ok, false);
  assert.ok(m.buildSave({ port: 'abc' }).errors.port);
});

/* ---------- texto ---------- */
test('texto: rejeita quebra de linha e caracteres de controle', () => {
  assert.match(validateText(opt('sunshine_name'), 'a\nb').error, /quebra de linha/);
  assert.match(validateText(opt('sunshine_name'), 'a\r\nb').error, /quebra de linha/);
  assert.match(validateText(opt('sunshine_name'), 'abc\n').error, /quebra de linha/);   // até no fim (o trim esconderia)
  assert.ok(validateText(opt('sunshine_name'), 'a\u0000b').error);
  assert.ok(validateText(opt('sunshine_name'), 'a\u001Fb').error);
  assert.equal(validateText(opt('sunshine_name'), 'a\tb').error, undefined);
  const m = model({});
  m.set('sunshine_name', 'linha1\nlinha2');
  const s = m.buildSave({});
  assert.equal(s.ok, false);
  assert.ok(s.errors.sunshine_name);
});

test('texto: # BLOQUEIA (o servidor corta o valor ali e a conferência por GET falharia); começar com [ bloqueia (exceto keybindings)', () => {
  assert.match(validateText(opt('sunshine_name'), 'Sala #1').error, /#/);
  assert.match(validateText(opt('sunshine_name'), '#x').error, /não pode ser usado/);       // valor só com # também
  assert.match(validateText(opt('log_path'), 'D:\\logs\\#1.log').error, /#/);
  const m = model({});
  m.set('sunshine_name', 'Sala #1');
  const s = m.buildSave({});
  assert.equal(s.ok, false);
  assert.match(s.errors.sunshine_name, /#/);
  assert.equal('sunshine_name' in s.body, false);          // nada de "salvar mesmo assim"
  assert.equal('warnings' in s, false);
  m.set('sunshine_name', 'Sala 1');                       // corrigido: salva
  assert.equal(m.buildSave({}).body.sunshine_name, 'Sala 1');
  assert.match(validateText(opt('log_path'), '[abc]').error, /\[/);
  assert.equal(validateText(opt('keybindings'), '[0x10,0xA0]').error, undefined);
  assert.match(validateText(opt('dd_manual_resolution'), '25#0x14').error, /LARGURAxALTURA/);   // campo com formato: a mensagem do formato vem primeiro
});

test('texto: espaços nas pontas saem; vazio e igual ao padrão removem a chave', () => {
  const m = model({ sunshine_name: 'Antigo' });
  m.set('sunshine_name', '  Sala R3D  ');
  assert.equal(m.buildSave({ sunshine_name: 'Antigo' }).body.sunshine_name, 'Sala R3D');
  m.set('sunshine_name', '   ');
  assert.equal('sunshine_name' in m.buildSave({ sunshine_name: 'Antigo' }).body, false);
  assert.equal(m.isDefault('sunshine_name'), true);
  const k = model({ keybindings: '[0x4A,0x4B]' });
  k.set('keybindings', '[0x10,0xA0,0x11,0xA2,0x12,0xA4]');   // igual ao padrão
  assert.equal('keybindings' in k.buildSave({ keybindings: '[0x4A,0x4B]' }).body, false);
});

test('texto: formatos (resolução, taxa de atualização, modo de reserva, atalhos)', () => {
  const e = (k, t) => validateText(opt(k), t).error;
  assert.equal(e('dd_manual_resolution', '2560x1440'), undefined);
  assert.match(e('dd_manual_resolution', '2560*1440'), /LARGURAxALTURA/);
  assert.ok(e('dd_manual_resolution', '2560x'));
  assert.equal(e('dd_manual_resolution', ''), undefined);
  assert.equal(e('dd_manual_refresh_rate', '59.9558'), undefined);
  assert.equal(e('dd_manual_refresh_rate', '59,9558'), undefined);          // vírgula vira ponto
  assert.equal(normalizeText(opt('dd_manual_refresh_rate'), ' 59,9558 '), '59.9558');
  assert.ok(e('dd_manual_refresh_rate', '59.'));
  assert.ok(e('dd_manual_refresh_rate', 'rápido'));
  assert.equal(e('fallback_mode', '1920x1080x60'), undefined);
  assert.match(e('fallback_mode', '1920x1080x59.94'), /inteiro/);            // o painel original reverteria em silêncio
  assert.match(e('fallback_mode', '1920x1080'), /Modo de reserva inválido/);
  assert.equal(e('keybindings', '[0x10,0xA0,0x4A,0x4B]'), undefined);
  assert.equal(e('keybindings', '[10,160]'), undefined);
  assert.match(e('keybindings', '[0x10]'), /Formato inválido/);              // número ímpar
  assert.match(e('keybindings', '[0x10 ,0xA0]'), /Formato inválido/);        // espaço antes da vírgula corrompe
  assert.match(e('keybindings', '[0x5,0xA0]'), /Formato inválido/);          // hex com dígitos ímpares vira 0
});

test('texto: campos obrigatórios quando visíveis (resolução/taxa manual)', () => {
  const m = model({ dd_configuration_option: 'ensure_primary' });
  m.set('dd_resolution_option', 'manual');                   // escolheu "manual" e não digitou nada
  let s = m.buildSave({ dd_configuration_option: 'ensure_primary' });
  assert.equal(s.ok, false);
  assert.ok(s.errors.dd_manual_resolution);
  m.set('dd_manual_resolution', '1920x1080');
  s = m.buildSave({ dd_configuration_option: 'ensure_primary' });
  assert.equal(s.ok, true);
  assert.equal(s.body.dd_manual_resolution, '1920x1080');
  assert.equal(s.body.dd_resolution_option, 'manual');
  // escondido (config desativada): não cobra
  const n = model({});
  n.set('dd_resolution_option', 'manual');
  assert.equal(n.buildSave({}).ok, true);
  assert.equal(n.get('dd_resolution_option'), 'manual');
});

/* ---------- escolhas ---------- */
test('escolha: apelidos do servidor, valor desconhecido preservado, valor fora da lista bloqueia', () => {
  assert.equal(parseFile(opt('min_log_level'), 'info').value, '2');
  assert.equal(parseFile(opt('min_log_level'), 'none').value, '6');
  assert.equal(parseFile(opt('min_log_level'), '4').value, '4');
  assert.equal(parseFile(opt('qsv_coder'), 'ac').value, 'cabac');
  assert.equal(parseFile(opt('amd_coder'), 'vlc').value, 'cavlc');
  assert.equal(parseFile(opt('qsv_preset'), 'slowest').value, 'veryslow');
  const m = model({ encoder: 'maquina-estranha', qp: '30' });
  assert.equal(m.draft.encoder, 'maquina-estranha');
  assert.equal(m.isDirty('encoder'), false);
  m.set('qp', '31');
  assert.equal(m.buildSave({ encoder: 'maquina-estranha', qp: '30' }).body.encoder, 'maquina-estranha');
  m.set('hevc_mode', '9');                                   // fora da lista
  assert.ok(m.buildSave({}).errors.hevc_mode);
  assert.ok(validateValue(opt('gamepad'), 'ds5', { platform: 'windows' }).error);    // ds5 é só Linux
  assert.deepEqual(validateValue(opt('gamepad'), 'ds4', { platform: 'windows' }), {});
  assert.deepEqual(validateValue(opt('gamepad'), 'ds5', { platform: 'linux' }), {});
});

test('escolha: capture e encoder "" (autodetecção) removem a chave', () => {
  const m = model({ capture: 'wgc', encoder: 'nvenc' });
  m.set('capture', '');
  m.set('encoder', '');
  const s = m.buildSave({ capture: 'wgc', encoder: 'nvenc' });
  assert.equal('capture' in s.body, false);
  assert.equal('encoder' in s.body, false);
});

test('escolha numérica (hevc_mode, lan_encryption_mode): vai como texto "2", e o padrão sai', () => {
  const m = model({});
  m.set('hevc_mode', '2');
  m.set('lan_encryption_mode', '1');
  m.set('wan_encryption_mode', '1');                         // padrão da WAN é 1
  m.set('av1_mode', '0');                                    // padrão
  const s = m.buildSave({});
  assert.equal(s.body.hevc_mode, '2');
  assert.equal(s.body.lan_encryption_mode, '1');
  assert.equal('wan_encryption_mode' in s.body, false);
  assert.equal('av1_mode' in s.body, false);
});

test('dd_configuration_option: padrão "disabled" é gravado explícito (senão o main.js repõe ensure_primary)', () => {
  const m = model({ dd_configuration_option: 'ensure_primary' });
  m.set('dd_configuration_option', 'disabled');
  assert.equal(m.isDirty('dd_configuration_option'), true);
  const s = m.buildSave({ dd_configuration_option: 'ensure_primary' });
  assert.equal(s.body.dd_configuration_option, 'disabled');
  assert.equal(toFile(opt('dd_configuration_option'), 'disabled', {}).value, 'disabled');
});

/* ---------- listas de comandos ---------- */
test('lista: itens vazios saem, textos aparados, elevated booleano só no Windows', () => {
  const o = opt('global_prep_cmd');
  const items = [{ do: ' a ', undo: '' }, { do: '  ', undo: '\t' }, { do: '', undo: ' b', elevated: 'sim' }, { do: '', undo: '' }];
  assert.deepEqual(finalizeList(o, items, 'windows'), [{ do: 'a', elevated: false, undo: '' }, { do: '', elevated: true, undo: 'b' }]);
  assert.deepEqual(finalizeList(o, items, 'linux'), [{ do: 'a', undo: '' }, { do: '', elevated: 'sim', undo: 'b' }]);
  assert.deepEqual(finalizeList(o, null, 'windows'), []);
  assert.deepEqual(finalizeList(o, [{ do: 'x', extra: 1, undo: '' }], 'windows')[0].extra, 1);   // campos desconhecidos passam
});

test('lista: server_cmd exige nome E comando; linha pela metade é erro (não some em silêncio)', () => {
  const o = opt('server_cmd');
  assert.deepEqual(finalizeList(o, [{ name: 'A', cmd: '' }, { name: 'B', cmd: 'b.exe' }], 'windows'), [{ cmd: 'b.exe', elevated: false, name: 'B' }]);
  const v = validateList(o, [{ name: 'A', cmd: '' }, { name: '', cmd: 'x' }, { name: '', cmd: '' }], 'windows');
  assert.ok(v.error);
  assert.deepEqual(v.rows.map((r) => `${r.i}:${r.field}`), ['0:cmd', '1:name']);
  assert.deepEqual(validateList(o, [{ name: '', cmd: '' }], 'windows').rows, []);
});

test('lista: # e quebra de linha em comandos bloqueiam (o servidor pode nem iniciar)', () => {
  const o = opt('global_prep_cmd');
  const hash = validateList(o, [{ do: 'echo #oi', undo: '' }], 'windows');
  assert.equal(hash.rows[0].field, 'do');
  assert.match(hash.rows[0].message, /#/);
  assert.ok(validateList(o, [{ do: 'a\nb', undo: '' }], 'windows').rows.length);
  assert.ok(validateList(o, [{ do: 'a', undo: 'b\r' }], 'windows').rows.length);
  const m = model({});
  m.set('global_prep_cmd', [{ do: 'echo #oi', undo: '', elevated: false }]);
  const s = m.buildSave({});
  assert.equal(s.ok, false);
  assert.ok(s.rowErrors.global_prep_cmd.length);
  assert.equal('global_prep_cmd' in s.body && typeof s.body.global_prep_cmd !== 'string', false);
});

test('lista: colchetes sem par quebram o valor no servidor', () => {
  assert.equal(bracketsBalanced('[]'), true);
  assert.equal(bracketsBalanced('[{"do":"echo [x]"}]'), true);
  assert.equal(bracketsBalanced('[{"do":"echo ]"}]'), false);     // "]" solto encerra cedo
  assert.equal(bracketsBalanced('[{"do":"echo ["}]'), false);     // "[" aberto nunca fecha
  assert.equal(bracketsBalanced('{"a":"]"}'), true);              // só vale para quem começa com [
  const o = opt('global_prep_cmd');
  assert.match(validateList(o, [{ do: 'echo ]', undo: '' }], 'windows').error, /colchetes/);
  assert.equal(validateList(o, [{ do: 'echo [ok]', undo: '' }], 'windows').error, undefined);
  assert.equal(validateList(o, [{ do: 'dir C:\\ [a]', undo: '' }], 'windows').error, undefined);
});

test('lista: JSON ilegível no arquivo vira aviso, não é sobrescrito e não suja', () => {
  const m = model({ global_prep_cmd: '[{"do":"abc"', server_cmd: '{"nao":"lista"}', global_state_cmd: '[1,2]', qp: '30' });
  for (const k of ['global_prep_cmd', 'server_cmd', 'global_state_cmd']) {
    assert.ok(m.parseErrors[k], k);
    assert.equal(m.isDirty(k), false);
  }
  m.set('global_prep_cmd', [{ do: 'x', undo: '', elevated: false }]);   // ignorado: está protegido
  assert.equal(m.isDirty('global_prep_cmd'), false);
  m.set('qp', '31');
  const s = m.buildSave({ global_prep_cmd: '[{"do":"abc"', qp: '30' });
  assert.equal(s.body.global_prep_cmd, '[{"do":"abc"');                  // bytes originais preservados
  // o usuário aceita descartar o valor ilegível: a chave passa a ser removida
  m.overrideBroken('global_prep_cmd');
  assert.equal(m.parseErrors.global_prep_cmd, undefined);
  assert.equal(m.isDirty('global_prep_cmd'), true);
  assert.equal('global_prep_cmd' in m.buildSave({ global_prep_cmd: '[{"do":"abc"' }).body, false);
});

test('lista: Windows ganha elevated:false ao carregar; outros sistemas não', () => {
  const raw = '[{"do":"a","undo":"b"}]';
  assert.deepEqual(parseFile(opt('global_prep_cmd'), raw, { platform: 'windows' }).value, [{ do: 'a', undo: 'b', elevated: false }]);
  assert.deepEqual(parseFile(opt('global_prep_cmd'), raw, { platform: 'linux' }).value, [{ do: 'a', undo: 'b' }]);
  assert.deepEqual(newListItem(opt('global_prep_cmd'), 'windows'), { do: '', undo: '', elevated: false });
  assert.deepEqual(newListItem(opt('global_prep_cmd'), 'linux'), { do: '', undo: '' });
  assert.deepEqual(newListItem(opt('server_cmd'), 'windows'), { name: '', cmd: '', elevated: false });
  assert.deepEqual(listColumns(opt('global_prep_cmd'), 'windows').map((c) => c.field), ['do', 'undo', 'elevated']);
  assert.deepEqual(listColumns(opt('global_prep_cmd'), 'linux').map((c) => c.field), ['do', 'undo']);
  // o arquivo do exemplo: server_cmd sem edição não vira "sujo" por causa do elevated
  const m = model({ server_cmd: '[{"cmd":"bubbles.scr","elevated":false,"name":"Bubbles"}]' });
  assert.equal(m.isDirty('server_cmd'), false);
});

test('lista: adicionar uma linha em branco não suja; adicionar uma preenchida sim; remover suja', () => {
  const m = model({ global_prep_cmd: '[{"do":"a","elevated":false,"undo":"b"}]' });
  const base = m.draft.global_prep_cmd;
  m.set('global_prep_cmd', [...base, { do: '', undo: '', elevated: false }]);
  assert.equal(m.isDirty('global_prep_cmd'), false);
  m.set('global_prep_cmd', [...base, { do: 'c', undo: '', elevated: false }]);
  assert.equal(m.isDirty('global_prep_cmd'), true);
  m.set('global_prep_cmd', []);
  assert.equal(m.isDirty('global_prep_cmd'), true);
  assert.equal('global_prep_cmd' in m.buildSave({ global_prep_cmd: '[{"do":"a","elevated":false,"undo":"b"}]' }).body, false);   // lista vazia = padrão
});

test('lista: gravada como array de verdade, com chaves em ordem alfabética (o servidor grava assim e config.js compara com JSON.stringify)', () => {
  const m = model({});
  m.set('global_prep_cmd', [{ undo: 'u', elevated: false, do: 'd' }]);
  const body = m.buildSave({}).body;
  assert.equal(Array.isArray(body.global_prep_cmd), true);
  assert.deepEqual(Object.keys(body.global_prep_cmd[0]), ['do', 'elevated', 'undo']);
  assert.equal(JSON.stringify(body.global_prep_cmd), '[{"do":"d","elevated":false,"undo":"u"}]');
});

/* ---------- remapeamento de modos ---------- */
test('dd_mode_remapping: sempre as 3 listas', () => {
  assert.deepEqual(ensureRemap(null), { mixed: [], resolution_only: [], refresh_rate_only: [] });
  assert.deepEqual(ensureRemap({ mixed: [{ a: '1' }] }), { mixed: [{ a: '1' }], resolution_only: [], refresh_rate_only: [] });
  assert.deepEqual(ensureRemap({ mixed: 'x', outra: 1 }).mixed, []);
  assert.equal(ensureRemap({ outra: 1 }).outra, 1);
  const bad = parseFile(opt('dd_mode_remapping'), '[1,2]');
  assert.ok(bad.error);
  const part = parseFile(opt('dd_mode_remapping'), '{"mixed":[]}');           // incompleto no arquivo: a tela completa
  assert.deepEqual(part.value, { mixed: [], resolution_only: [], refresh_rate_only: [] });
  assert.ok(parseFile(opt('dd_mode_remapping'), 'não é json').error);
});

test('dd_mode_remapping: só a lista ativa é editada/validada; as outras ficam intactas', () => {
  const get = (o) => (k) => o[k] ?? '';
  const mixedEnv = get({ dd_configuration_option: 'ensure_primary' });
  const val = { mixed: [{ requested_resolution: '1920x1080', requested_fps: '60', final_resolution: '', final_refresh_rate: '119,95 ' }, { requested_resolution: '', requested_fps: '', final_resolution: '', final_refresh_rate: '' }], resolution_only: [{ requested_resolution: 'lixo', final_resolution: '' }], refresh_rate_only: [] };
  const fin = finalizeRemap(val, mixedEnv);
  assert.deepEqual(fin.mixed, [{ final_refresh_rate: '119.95', final_resolution: '', requested_fps: '60', requested_resolution: '1920x1080' }]);
  assert.deepEqual(fin.resolution_only, [{ final_resolution: '', requested_resolution: 'lixo' }]);   // inativa: intacta, mesmo inválida
  assert.deepEqual(validateRemap(val, mixedEnv).rows, []);
  assert.deepEqual(Object.keys(fin), ['mixed', 'refresh_rate_only', 'resolution_only']);
  // inativa quando a configuração está desativada
  assert.deepEqual(validateRemap(val, get({ dd_configuration_option: 'disabled' })).rows, []);
  assert.deepEqual(finalizeRemap(val, get({ dd_configuration_option: 'disabled' })).mixed.length, 2);
});

test('dd_mode_remapping: formatos e valores finais', () => {
  const get = (o) => (k) => o[k] ?? '';
  const mixedEnv = get({ dd_configuration_option: 'ensure_primary' });
  const rows = (list, env = mixedEnv) => validateRemap({ mixed: [], resolution_only: [], refresh_rate_only: [], ...list }, env).rows.map((r) => `${r.i}:${r.field}`);
  assert.deepEqual(rows({ mixed: [{ requested_resolution: '1920*1080', final_resolution: '2560x1440' }] }), ['0:requested_resolution']);
  assert.deepEqual(rows({ mixed: [{ requested_fps: '59.9', final_refresh_rate: '60' }] }), ['0:requested_fps']);
  assert.deepEqual(rows({ mixed: [{ requested_fps: '60', final_refresh_rate: 'a' }] }), ['0:final_refresh_rate']);
  assert.deepEqual(rows({ mixed: [{ requested_fps: '60' }] }), ['0:final_resolution', '0:final_refresh_rate']);        // mixed: precisa de um final
  const resOnly = get({ dd_configuration_option: 'ensure_primary', dd_refresh_rate_option: 'manual' });
  assert.deepEqual(rows({ resolution_only: [{ requested_resolution: '1920x1080' }] }, resOnly), ['0:final_resolution']);
  assert.deepEqual(rows({ resolution_only: [{ requested_resolution: '', final_resolution: '1x1' }] }, resOnly), []);   // "solicitado" vazio casa com qualquer
  const fpsOnly = get({ dd_configuration_option: 'ensure_primary', dd_resolution_option: 'manual' });
  assert.deepEqual(rows({ refresh_rate_only: [{ requested_fps: '60', final_refresh_rate: '' }] }, fpsOnly), ['0:final_refresh_rate']);
  assert.deepEqual(rows({ mixed: [{ requested_resolution: '#', final_resolution: '1x1' }] }), ['0:requested_resolution']);
});

test('dd_mode_remapping: tudo vazio é o padrão (chave removida); com linhas vai com 3 listas', () => {
  const m = model({ dd_configuration_option: 'ensure_primary' });
  m.set('dd_mode_remapping', { mixed: [{ requested_resolution: '', requested_fps: '', final_resolution: '', final_refresh_rate: '' }], resolution_only: [], refresh_rate_only: [] });
  assert.equal(m.isDirty('dd_mode_remapping'), false);
  m.set('dd_mode_remapping', { mixed: [{ requested_resolution: '1920x1080', requested_fps: '', final_resolution: '2560x1440', final_refresh_rate: '' }], resolution_only: [], refresh_rate_only: [] });
  const body = m.buildSave({ dd_configuration_option: 'ensure_primary' }).body;
  assert.deepEqual(Object.keys(body.dd_mode_remapping), ['mixed', 'refresh_rate_only', 'resolution_only']);
  assert.equal(JSON.stringify(body.dd_mode_remapping), '{"mixed":[{"final_refresh_rate":"","final_resolution":"2560x1440","requested_fps":"","requested_resolution":"1920x1080"}],"refresh_rate_only":[],"resolution_only":[]}');
});

/* ---------- modelo e gravação ---------- */
test('gravação: parte do GET de agora, troca só as chaves sujas e preserva o resto (inclusive desconhecidas)', () => {
  const m = model({ port: '47989', flags: '0', qp: '30' });
  m.set('qp', '33');
  const fresh = { port: '50000', flags: '0', share_library: 'disabled', keybindings: '[0x4A,0x4B]', qp: '30', future: 'x', status: true, platform: 'windows', version: '1', vdisplayStatus: 0 };
  const s = m.buildSave(fresh);
  assert.deepEqual(s.body, { port: '50000', flags: '0', share_library: 'disabled', keybindings: '[0x4A,0x4B]', qp: '33', future: 'x' });
  for (const k of NEVER_SEND) assert.equal(k in s.body, false);
  assert.deepEqual(s.changes, [{ key: 'qp', action: 'set' }]);
});

test('gravação: sem edições não muda nada; metadados saem mesmo assim', () => {
  const m = model({ upnp: 'enabled' });
  const s = m.buildSave({ upnp: 'enabled', status: true, vdisplayStatus: 0, platform: 'windows', version: '9' });
  assert.deepEqual(s.body, { upnp: 'enabled' });
  assert.deepEqual(s.changes, []);
  assert.equal(s.ok, true);
});

test('modelo: sujo só enquanto difere do arquivo; descartar volta ao arquivo', () => {
  const m = model({ upnp: 'enabled', port: '48000' });
  m.set('upnp', false);
  m.set('port', '48001');
  assert.deepEqual(m.dirtyKeys(), ['port', 'upnp'].sort((a, b) => catalog.byKey.get(a).order - catalog.byKey.get(b).order));
  m.set('upnp', true);                                       // desfez à mão
  assert.deepEqual(m.dirtyKeys(), ['port']);
  m.discard();
  assert.equal(m.dirty.size, 0);
  assert.equal(m.draft.port, '48000');
  assert.equal(m.draft.upnp, true);
});

test('modelo: get() devolve o objeto único (arquivo + edições + padrões) para as condições entre categorias', () => {
  const m = model({ mouse: 'disabled' });
  assert.equal(m.get('mouse'), 'disabled');
  assert.equal(m.get('keyboard'), 'enabled');                // padrão
  assert.equal(m.get('dd_resolution_option'), 'auto');
  assert.equal(m.get('desconhecida'), '');
  m.set('mouse', true);
  assert.equal(m.get('mouse'), 'enabled');
  m.set('port', '');
  assert.equal(m.get('port'), '47989');                      // vazio = padrão
  assert.equal(m.get('global_prep_cmd'), '');
  const f = model({ future: 'x' });
  assert.equal(f.get('future'), 'x');                        // chave que a tela não conhece
});

test('modelo: vários erros ao mesmo tempo; nada é enviado quando há erro', () => {
  const file = { dd_configuration_option: 'ensure_primary', dd_resolution_option: 'manual' };   // o campo de resolução manual aparece
  const m = model(file);
  m.set('port', '10');
  m.set('qp', 'x');
  m.set('sunshine_name', 'a\nb');
  m.set('dd_manual_resolution', '12');
  const s = m.buildSave(file);
  assert.equal(s.ok, false);
  assert.deepEqual(Object.keys(s.errors).sort(), ['dd_manual_resolution', 'port', 'qp', 'sunshine_name']);
  assert.deepEqual(s.changes, []);
  assert.deepEqual(s.skipped, []);
});

test('campo escondido com edição inválida NÃO bloqueia o Salvar (ninguém conseguiria corrigir): o valor do arquivo é mantido e a chave vai em skipped', () => {
  // showIf de teclado: key_repeat_delay só aparece com o teclado ligado
  const file = { key_repeat_delay: '400', qp: '30' };
  const m = model(file);
  m.set('key_repeat_delay', '-5');
  assert.ok(m.buildSave(file).errors.key_repeat_delay);          // visível: bloqueia
  m.set('keyboard', false);                                      // o interruptor que o controla é desligado: o campo some
  m.set('qp', '31');
  const s = m.buildSave(file);
  assert.equal(s.ok, true);
  assert.deepEqual(s.errors, {});
  assert.deepEqual(s.skipped, ['key_repeat_delay']);
  assert.equal(s.body.key_repeat_delay, '400');                  // continua como estava no arquivo
  assert.equal(s.body.keyboard, 'disabled');
  assert.equal(s.body.qp, '31');
  // resolução manual: escolheu manual, digitou "abc" e voltou para automático
  const f2 = { dd_configuration_option: 'ensure_primary' };
  const n = model(f2);
  n.set('dd_resolution_option', 'manual');
  n.set('dd_manual_resolution', 'abc');
  assert.ok(n.buildSave(f2).errors.dd_manual_resolution);
  n.set('dd_resolution_option', 'auto');
  const t = n.buildSave(f2);
  assert.equal(t.ok, true);
  assert.deepEqual(t.skipped, ['dd_manual_resolution']);
  assert.equal('dd_manual_resolution' in t.body, false);
  // edição VÁLIDA em campo escondido continua sendo gravada (o painel original mantém a chave)
  const v = model({});
  v.set('key_repeat_delay', '600');
  v.set('keyboard', false);
  const w = v.buildSave({});
  assert.equal(w.body.key_repeat_delay, '600');
  assert.deepEqual(w.skipped, []);
  // plataforma errada: a opção do Windows não existe no Linux
  const l = model({}, 'linux');
  l.set('key_repeat_delay', 'abc');
  assert.equal(l.buildSave({}).ok, true);
});

test('campo dentro de GRUPO escondido também conta como escondido', () => {
  const g = catalog.byKey.get('motion_as_ds4');
  const m = model({});
  assert.equal(m.shown(g), true);
  m.set('controller', false);
  assert.equal(m.shown(g), false);
  assert.equal(m.shown(catalog.byKey.get('ds4_back_as_touchpad_click')), false);
});

test('canon e padrão: comparações por tipo', () => {
  assert.equal(canon(opt('port'), ' 047989 '), '47989');
  assert.equal(canon(opt('port'), 'abc'), '!abc');
  assert.equal(isDefaultDraft(opt('port'), '47989'), true);
  assert.equal(isDefaultDraft(opt('port'), '47990'), false);
  assert.equal(isDefaultDraft(opt('upnp'), false), true);
  assert.equal(isDefaultDraft(opt('upnp'), true), false);
  assert.equal(isDefaultDraft(opt('sunshine_name'), ''), true);
  assert.equal(isDefaultDraft(opt('hevc_mode'), '0'), true);
  assert.deepEqual(defaultDraft(opt('dd_mode_remapping')), { mixed: [], resolution_only: [], refresh_rate_only: [] });
  assert.deepEqual(defaultDraft(opt('server_cmd')), []);
  assert.deepEqual(sortKeysDeep({ b: [{ z: 1, a: 2 }], a: 1 }), { a: 1, b: [{ a: 2, z: 1 }] });
});

test('parseFile: valores ausentes ou vazios viram o padrão; booleano desconhecido vira o padrão', () => {
  assert.equal(parseFile(opt('upnp'), undefined).absent, true);
  assert.equal(parseFile(opt('mouse'), '').value, true);
  assert.equal(parseFile(opt('mouse'), '').absent, true);
  assert.equal(parseFile(opt('qp'), '30').value, '30');
  assert.deepEqual(parseFile(opt('server_cmd'), '[]').value, []);
  assert.deepEqual(noFresh, {});
});

test('número em branco conta como o padrão (não suja)', () => {
  const m = model({});
  m.set('port', '');
  assert.equal(m.isDirty('port'), false);
  assert.equal(m.isDefault('port'), true);
  const n = model({ port: '48000' });
  n.set('port', '   ');
  assert.equal(n.isDirty('port'), true);                     // tira a chave do arquivo
  assert.equal('port' in n.buildSave({ port: '48000' }).body, false);
  assert.equal(canon(opt('qp'), ''), '28');
  assert.equal(canon(opt('key_repeat_frequency'), ''), '24.9');
});

test('lista escrita à mão em várias linhas vai compacta (writeConfig recusa quebras de linha)', () => {
  const multi = '[\r\n  {"name": "A",\r\n   "cmd": "a.exe"}\r\n]';
  const m = model({ server_cmd: multi, qp: '30' });
  m.set('qp', '31');
  const s = m.buildSave({ server_cmd: multi, qp: '30' });
  assert.deepEqual(s.body.server_cmd, [{ cmd: 'a.exe', name: 'A' }]);
  assert.equal(JSON.stringify(s.body.server_cmd).includes('\n'), false);
  // ilegível: preservada (não suja, não vira lista), mas achatada para uma linha: senão o writeConfig recusaria a gravação inteira
  const bad = model({ global_prep_cmd: '[\n{', qp: '30' });
  bad.set('qp', '31');
  const sb = bad.buildSave({ global_prep_cmd: '[\n{', qp: '30' });
  assert.equal(sb.body.global_prep_cmd, '[{');
  assert.equal(/[\r\n]/.test(sb.body.global_prep_cmd), false);
  assert.equal(sb.body.qp, '31');
});

test('keybindings (texto) escrito à mão em várias linhas: a tela mostra uma linha e o Salvar de OUTRA opção não é recusado pelo writeConfig', () => {
  const multi = '[0x10,0xA0,\r\n  0x4A,0x4B\r\n]';
  const m = model({ keybindings: multi, qp: '30' });
  assert.equal(m.draft.keybindings, '[0x10,0xA0,0x4A,0x4B]');      // sem quebras no campo
  assert.equal(m.isDirty('keybindings'), false);
  assert.equal(m.isDefault('keybindings'), false);
  m.set('qp', '31');
  const s = m.buildSave({ keybindings: multi, qp: '30' });
  assert.equal(s.ok, true);
  assert.equal(s.body.keybindings, '[0x10,0xA0,0x4A,0x4B]');
  assert.equal(checkValue('keybindings', s.body.keybindings), null);   // o mesmo teste que o writeConfig faz
  // chave que a tela não conhece também é achatada (só quando é "[...]")
  const u = model({ futura: '[1,\n2]', texto: 'a\nb' });
  u.set('qp', '31');
  const t = u.buildSave({ futura: '[1,\n2]', texto: 'a\nb' });
  assert.equal(t.body.futura, '[1,2]');
  assert.equal(t.body.texto, 'a\nb');                              // o servidor nunca devolve isso; não mexemos
  assert.equal(flattenBracketLines('[1,\n  2,\r\n3]'), '[1,2,3]');
  assert.equal(flattenBracketLines('abc\ndef'), 'abc\ndef');
  assert.equal(flattenBracketLines('[1,2]'), '[1,2]');
});

/* ---------- linhas pela metade, apelidos, padrão do R3D PLAY ---------- */
test('lista: linha pela metade conta como alteração (suja) e BLOQUEIA o Salvar; linha em branco continua não contando', () => {
  const file = { server_cmd: '[{"cmd":"a.exe","elevated":false,"name":"A"}]' };
  const m = model(file);
  const base = m.draft.server_cmd;
  assert.equal(m.dirtyKeys().length, 0);
  m.set('server_cmd', [...base, { name: 'Novo', cmd: '', elevated: false }]);          // só o nome
  assert.equal(m.isDirty('server_cmd'), true);
  let s = m.buildSave(file);
  assert.equal(s.ok, false);
  assert.ok(s.errors.server_cmd);
  assert.deepEqual(s.rowErrors.server_cmd.map((r) => `${r.i}:${r.field}`), ['1:cmd']);
  assert.deepEqual(s.body, file);                                                      // nada foi alterado no corpo
  m.set('server_cmd', [...base, { name: '', cmd: 'b.exe', elevated: false }]);          // só o comando
  assert.equal(m.buildSave(file).rowErrors.server_cmd[0].field, 'name');
  m.set('server_cmd', [...base, { name: '  ', cmd: '', elevated: false }]);             // em branco de verdade
  assert.equal(m.isDirty('server_cmd'), false);
  assert.equal(m.buildSave(file).ok, true);
  m.set('server_cmd', [...base, { name: 'Novo', cmd: 'b.exe', elevated: false }]);      // completou
  assert.equal(m.buildSave(file).ok, true);
  assert.equal(m.buildSave(file).body.server_cmd.length, 2);
  // sozinha (sem outra alteração) a linha pela metade também aparece como alteração
  const solo = model({});
  solo.set('server_cmd', [{ name: 'X', cmd: '', elevated: false }]);
  assert.deepEqual(solo.dirtyKeys(), ['server_cmd']);
  solo.discard();
  assert.deepEqual(solo.dirtyKeys(), []);
  // uma linha pela metade que JÁ veio do arquivo (editado à mão) não suja por si só
  const half = model({ server_cmd: '[{"cmd":"","elevated":false,"name":"Meio"}]' });
  assert.deepEqual(half.dirtyKeys(), []);
  assert.deepEqual(half.buildSave({ server_cmd: '[{"cmd":"","elevated":false,"name":"Meio"}]' }).body.server_cmd, '[{"cmd":"","elevated":false,"name":"Meio"}]');
  assert.equal(partialRows(opt('server_cmd'), [{ name: 'A', cmd: '' }, { name: '', cmd: '' }], 'linux').length, 1);
});

test('escolha: valores que existem em Object.prototype ("constructor", "toString") no arquivo não quebram a leitura', () => {
  for (const bad of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(parseFile(opt('min_log_level'), bad).value, bad);
    assert.equal(parseFile(opt('qsv_coder'), bad).value, bad);
    const m = model({ min_log_level: bad, amd_coder: bad, qsv_preset: bad });
    assert.equal(m.draft.min_log_level, bad);
    assert.equal(m.isDirty('min_log_level'), false);
    assert.equal(typeof m.draft.amd_coder, 'string');
    assert.deepEqual(m.buildSave({ min_log_level: bad }).body, { min_log_level: bad });   // preservado
    assert.ok(m.check('min_log_level').error);                                            // mas inválido se a pessoa mexer
  }
  assert.equal(parseFile(opt('min_log_level'), 'info').value, '2');                       // apelidos legítimos continuam valendo
});

test('padrão do R3D PLAY (dd_configuration_option): restaurar grava ensure_primary; "disabled" explícito não é o padrão', () => {
  const o = opt('dd_configuration_option');
  assert.equal(restoreDraft(o), 'ensure_primary');
  assert.equal(restoreDraft(opt('upnp')), false);
  assert.equal(restoreDraft(opt('dd_mode_remapping')) !== undefined, true);
  const m = model({ dd_configuration_option: 'ensure_primary' });
  assert.equal(m.isDefault('dd_configuration_option'), true);       // instalação normal: sem selo "diferente do padrão"
  const d = model({ dd_configuration_option: 'disabled' });
  assert.equal(d.isDefault('dd_configuration_option'), false);
  d.reset('dd_configuration_option');
  assert.equal(d.draft.dd_configuration_option, 'ensure_primary');
  assert.equal(d.isDirty('dd_configuration_option'), true);
  assert.equal(d.buildSave({ dd_configuration_option: 'disabled' }).body.dd_configuration_option, 'ensure_primary');   // explícito, como o main.js
  // chave ausente continua sendo lida como o padrão do MOTOR (o servidor em execução usa "disabled")
  const a = model({});
  assert.equal(a.draft.dd_configuration_option, 'disabled');
  assert.equal(a.isDirty('dd_configuration_option'), false);
  assert.equal(a.isDefault('dd_configuration_option'), false);
  assert.equal(isDefaultDraft(o, 'ensure_primary'), true);
});
