// Testes de ui/js/lib/perms.js: máscara de permissões, implicações, modelos de acesso, risco, rascunho/diff e corpo do POST de update.
// Rodar: node --test tools/ApolloConfig/dev/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../../ui/js/lib/perms.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'ui', 'schema', 'clients.json'), 'utf8'));
const bit = (name) => P.permByName(name).bit;
const maskOf = (names) => names.reduce((m, n) => m | bit(n), 0);

/* ---------- Fidelidade ao schema (se o schema mudar, estes testes avisam) ---------- */
// Ajudas que o schema escreve com palavras que não aparecem em nenhum rótulo da tela ('assistir', 'iniciar', 'Permission Denied'):
// na tela usamos os rótulos reais (Ver transmissões, Iniciar aplicativos). Só estas podem diferir do schema, e nunca com os termos antigos.
const HELP_REWORDED = new Set(['list', 'view', 'launch', 'clipboard_set', 'clipboard_read']);
test('ajudas reescritas usam os rótulos reais da tela e nenhum termo em inglês solto', () => {
  for (const name of HELP_REWORDED) {
    const p = P.permByName(name);
    assert.ok(!/assistir|'iniciar'|Permission Denied/.test(p.help), `${name}: termo antigo na ajuda`);
    // toda permissão citada entre aspas curvas tem de ser o rótulo de uma permissão que existe
    for (const [, quoted] of p.help.matchAll(/“([^”]+)”/g)) {
      assert.ok(P.PERMISSIONS.some((x) => x.label === quoted) || quoted === 'Jogos e transmissão', `${name}: “${quoted}” não é um rótulo`);
    }
  }
});
test('permissões: bits, grupos, risco, implicações e ajuda iguais ao schema', () => {
  assert.equal(P.PERMISSIONS.length, SCHEMA.permissions.length);
  for (const s of SCHEMA.permissions) {
    const p = P.permByName(s.name);
    assert.ok(p, `falta a permissão ${s.name}`);
    assert.equal(p.bit, s.bit, `${s.name}: bit`);
    assert.equal('0x' + p.bit.toString(16).padStart(8, '0'), s.hex.toLowerCase(), `${s.name}: hex`);
    assert.equal(p.group, s.group, `${s.name}: grupo`);
    assert.equal(p.label, s.label, `${s.name}: rótulo`);
    assert.equal(p.danger, s.danger, `${s.name}: risco`);
    assert.equal(p.shown, s.exposed_in_original_ui, `${s.name}: mostrar como caixa`);
    assert.deepEqual(p.implies || [], s.implies || [], `${s.name}: implies`);
    assert.deepEqual(p.impliedBy || [], s.implied_by || [], `${s.name}: impliedBy`);
    if (p.shown && !HELP_REWORDED.has(p.name)) assert.equal(p.help, s.help, `${s.name}: ajuda`);
    if (p.shown) assert.ok(p.help.trim().length > 20, `${s.name}: tem ajuda`);
  }
  // cada bit é potência de 2 e nenhum se repete
  const bits = P.PERMISSIONS.map((p) => p.bit);
  assert.equal(new Set(bits).size, bits.length);
  for (const b of bits) assert.equal(b & (b - 1), 0, 'bit único');
  assert.equal(bits.reduce((a, b) => a | b, 0), P.PERM_ALL, 'a união dos bits é o PERM_ALL');
});

test('grupos e máscaras de referência iguais ao schema', () => {
  assert.deepEqual(P.GROUPS.map((g) => [g.id, g.label, g.help]), SCHEMA.permission_groups.sort((a, b) => a.order - b.order).map((g) => [g.id, g.label, g.help]));
  const m = SCHEMA.permission_masks;
  assert.equal(P.PERM_ALL, m._all);
  assert.equal(P.PERM_DEFAULT, m._default);
  assert.equal(P.PERM_STREAM, m._allow_view);
  assert.equal(maskOf(['input_controller', 'input_touch', 'input_pen', 'input_mouse', 'input_kbd']), m._all_inputs);
  assert.equal(maskOf(['list', 'view', 'launch']), m._all_actions);
  assert.equal(maskOf(['clipboard_set', 'clipboard_read', 'file_upload', 'file_dwnload', 'server_cmd']), m._all_operations);
  assert.equal(P.PERM_ALL, m._all_inputs | m._all_operations | m._all_actions);
  assert.equal(P.CUSTOM_LABEL, SCHEMA.presets_match.custom_label);
});

test('modelos de acesso: id, rótulo, máscara, bits, risco, ícone e ajuda iguais ao schema', () => {
  assert.deepEqual(P.PRESETS.map((p) => p.id), SCHEMA.presets.map((p) => p.id), 'mesma ordem');
  for (const s of SCHEMA.presets) {
    const p = P.presetById(s.id);
    assert.equal(p.label, s.label);
    assert.equal(p.mask, s.mask);
    assert.equal('0x' + p.mask.toString(16).padStart(8, '0'), s.mask_hex.toLowerCase());
    assert.equal(maskOf(s.bits), s.mask, `${s.id}: os bits listados somam a máscara`);
    assert.equal(p.risk, s.risk);
    assert.equal(p.icon, s.icon);
    assert.equal(p.help, s.help.replace(' (_default)', ''), 'igual ao schema, sem o nome técnico (_default)');
  }
});

test('campos editáveis cobrem exatamente os campos do schema que vão no update', () => {
  const inUpdate = SCHEMA.fields.filter((f) => f.in_update && f.key !== 'uuid').map((f) => f.key).sort();
  assert.deepEqual([...P.FIELD_KEYS].sort(), inUpdate);
  for (const k of P.FIELD_KEYS) assert.ok(P.FIELD_LABELS[k], `rótulo de ${k}`);
});

/* ---------- Máscara ---------- */
test('coerceMask: recorta nos bits válidos e trata lixo como "sem permissão"', () => {
  assert.equal(P.coerceMask(119480064), 119480064);
  assert.equal(P.coerceMask(0), 0);
  assert.equal(P.coerceMask(0xFFFFFFFF), P.PERM_ALL);
  assert.equal(P.coerceMask(0x80000000 + 50331648), 50331648);
  assert.equal(P.coerceMask('50331648'), 50331648);
  assert.equal(P.coerceMask(50331648.9), 50331648, 'fração é cortada');
  for (const bad of [NaN, Infinity, -Infinity, -1, -50331648, 2 ** 32, 2 ** 40, 'abc', '', '  ', null, undefined, {}, [], true, false]) {
    assert.equal(P.coerceMask(bad), 0, `lixo ${String(bad)} => 0 (nunca "tudo")`);
  }
});

test('normalizeMask: iniciar => assistir => listar e idempotente', () => {
  assert.equal(P.normalizeMask(bit('launch')), maskOf(['launch', 'view', 'list']));
  assert.equal(P.normalizeMask(bit('view')), maskOf(['view', 'list']));
  assert.equal(P.normalizeMask(bit('list')), bit('list'));
  assert.equal(P.normalizeMask(bit('input_kbd')), bit('input_kbd'), 'entradas não implicam nada');
  assert.equal(P.normalizeMask(0), 0);
  for (let m = 0; m < 1 << 13; m++) {
    const raw = P.PERMISSIONS.reduce((acc, p, i) => (m & (1 << i) ? acc | p.bit : acc), 0);
    const n = P.normalizeMask(raw);
    assert.equal(P.normalizeMask(n), n, 'idempotente');
    assert.equal(n & raw, raw, 'só acrescenta bits');
    if (n & bit('launch')) assert.ok(n & bit('view') && n & bit('list'));
    if (n & bit('view')) assert.ok(n & bit('list'));
  }
});

test('togglePerm: ligar liga as implicadas; desligar respeita o que trava', () => {
  let m = 0;
  m = P.togglePerm(m, 'launch', true);
  assert.equal(m, maskOf(['launch', 'view', 'list']), 'iniciar marca assistir e listar');
  assert.equal(P.togglePerm(m, 'view', false), m, 'assistir está travada por iniciar');
  assert.equal(P.togglePerm(m, 'list', false), m, 'listar está travada por iniciar/assistir');
  m = P.togglePerm(m, 'launch', false);
  assert.equal(m, maskOf(['view', 'list']), 'desmarcar iniciar mantém assistir e listar');
  assert.equal(P.togglePerm(m, 'list', false), m, 'listar ainda travada por assistir');
  m = P.togglePerm(m, 'view', false);
  assert.equal(m, bit('list'));
  m = P.togglePerm(m, 'list', false);
  assert.equal(m, 0);
  assert.equal(P.togglePerm(0, 'view', true), maskOf(['view', 'list']), 'assistir marca listar');
  assert.equal(P.togglePerm(0, 'list', true), bit('list'));
  // desligar um bit que já está desligado não muda nada
  assert.equal(P.togglePerm(0, 'input_pen', false), 0);
  // nome desconhecido: devolve a máscara recortada
  assert.equal(P.togglePerm(50331648, 'nao_existe', true), 50331648);
  // bits escondidos (upload/download) são preservados ao mexer em outra coisa
  const full = P.PERM_ALL;
  const noClip = P.togglePerm(full, 'clipboard_read', false);
  assert.equal(noClip, full & ~bit('clipboard_read'));
  assert.ok(noClip & bit('file_upload') && noClip & bit('file_dwnload'));
});

test('togglePerm: qualquer sequência de cliques mantém a invariante das implicações', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let run = 0; run < 200; run++) {
    let m = 0;
    for (let i = 0; i < 40; i++) {
      const p = P.PERMISSIONS[rnd(P.PERMISSIONS.length)];
      m = P.togglePerm(m, p.name, rnd(2) === 1);
      assert.ok(m >= 0 && m <= P.PERM_ALL && (m & ~P.PERM_ALL) === 0);
      assert.equal(m, P.normalizeMask(m), 'só liga pelos cliques => sempre normalizada');
    }
  }
});

test('lockedBy / hasPerm: implicadas aparecem marcadas e travadas mesmo sem o bit gravado', () => {
  const launchOnly = bit('launch'); // o servidor aceita assim, sem gravar view/list
  assert.equal(P.lockedBy(launchOnly, 'view'), 'launch');
  assert.equal(P.lockedBy(launchOnly, 'list'), 'launch');
  assert.equal(P.lockedBy(launchOnly, 'launch'), null);
  assert.equal(P.lockedBy(bit('view'), 'list'), 'view');
  assert.equal(P.lockedBy(bit('view'), 'launch'), null);
  assert.equal(P.lockedBy(0, 'list'), null);
  assert.equal(P.lockedBy(P.PERM_ALL, 'input_kbd'), null);
  assert.ok(P.hasPerm(launchOnly, 'view') && P.hasPerm(launchOnly, 'list'));
  assert.ok(!P.hasPerm(0, 'list'));
  assert.ok(!P.hasPerm(P.PERM_ALL, 'nao_existe'));
});

/* ---------- Modelos ---------- */
test('todos os modelos: reconhecidos pela própria máscara, máscara já normalizada, sem duplicatas', () => {
  const masks = new Set();
  for (const p of P.PRESETS) {
    assert.equal(P.normalizeMask(p.mask), p.mask, `${p.id}: bits implicados explícitos`);
    assert.equal(P.presetOf(p.mask)?.id, p.id, `${p.id}: reconhecido`);
    assert.ok(!masks.has(p.mask), `${p.id}: máscara repetida`);
    masks.add(p.mask);
    assert.equal(P.riskOf(p.mask), p.risk, `${p.id}: risco`);
    // montar o modelo clicando nas caixas, em qualquer ordem, dá exatamente a máscara do modelo
    const names = P.PERMISSIONS.filter((x) => p.mask & x.bit).map((x) => x.name);
    for (const order of [names, [...names].reverse()]) {
      let m = 0;
      for (const n of order) m = P.togglePerm(m, n, true);
      assert.equal(m, p.mask, `${p.id}: clicando nas caixas`);
    }
  }
});

test('presetOf: compara depois de normalizar e ignora bits desconhecidos; senão "Personalizado" (null)', () => {
  assert.equal(P.presetOf(0)?.id, 'bloqueado');
  assert.equal(P.presetOf(maskOf(['view']))?.id, 'apenas_ver', 'só assistir == listar+assistir');
  assert.equal(P.presetOf(maskOf(['launch', 'input_controller']))?.id, 'jogar_controle', 'launch sozinho vale como launch+view+list');
  assert.equal(P.presetOf(50331648 + 0x80000000)?.id, 'apenas_ver', 'bit fora da máscara é descartado');
  assert.equal(P.presetOf(bit('list')), null, 'só listar não é nenhum modelo');
  assert.equal(P.presetOf(P.PERM_ALL & ~bit('input_pen')), null, 'controle total menos uma caixa visível = personalizado');
  assert.equal(P.presetOf(P.PERM_ALL & ~bit('file_upload'))?.id, 'controle_total', 'upload/download não têm caixa: não deixam ninguém "Personalizado"');
  assert.equal(P.presetOf(maskOf(['launch'])), null);
  assert.equal(P.presetOf('lixo')?.id, 'bloqueado', 'lixo vira 0 = sem acesso (nunca promove)');
  // exaustivo: todo subconjunto resolve para no máximo um modelo, igual ao da forma normalizada
  for (let m = 0; m < 1 << 13; m++) {
    const raw = P.PERMISSIONS.reduce((acc, p, i) => (m & (1 << i) ? acc | p.bit : acc), 0);
    const a = P.presetOf(raw);
    const b = P.presetOf(P.normalizeMask(raw));
    assert.equal(a?.id, b?.id);
  }
});

test('bits escondidos (upload/download): as 11 caixas visíveis marcadas == Controle total, sem "Acesso limitado"', () => {
  assert.equal(P.VISIBLE_MASK, P.PERM_ALL & ~bit('file_upload') & ~bit('file_dwnload'));
  let m = 0;
  for (const p of P.SHOWN_PERMISSIONS) m = P.togglePerm(m, p.name, true);
  assert.equal(m, P.VISIBLE_MASK, 'clicando em todas as caixas visíveis');
  assert.equal(P.presetOf(m)?.id, 'controle_total');
  assert.ok(P.isFullAccess(m));
  assert.equal(P.riskOf(m), 'alto');
  assert.equal(P.countShown(m), 11);
  // com os dois bits escondidos também é controle total (como o servidor grava)
  assert.ok(P.isFullAccess(P.PERM_ALL));
  // faltando qualquer caixa visível deixa de ser
  for (const p of P.SHOWN_PERMISSIONS) {
    if (p.impliedBy) continue;   // as implicadas não saem sozinhas
    assert.ok(!P.isFullAccess(P.togglePerm(m, p.name, false)), `sem ${p.name}`);
    assert.equal(P.presetOf(P.togglePerm(m, p.name, false))?.id === 'controle_total', false, `sem ${p.name}`);
  }
  // só os bits escondidos não dão acesso a nada visível
  assert.ok(!P.isFullAccess(bit('file_upload') | bit('file_dwnload')));
  // nenhum par de modelos fica igual depois de ignorar os bits escondidos
  const seen = new Set(P.PRESETS.map((p) => P.presetOf(p.mask).id));
  assert.equal(seen.size, P.PRESETS.length);
});

test('presetById', () => {
  assert.equal(P.presetById('jogar').label, 'Jogar');
  assert.equal(P.presetById('xxx'), null);
  assert.equal(P.presetById(P.FULL_PRESET_ID).mask, P.PERM_ALL);
});

/* ---------- Risco e estados ---------- */
test('riskOf segue a regra do schema', () => {
  assert.equal(P.riskOf(0), 'nenhum');
  assert.equal(P.riskOf(0x80000000), 'nenhum', 'só bits desconhecidos = nenhum');
  assert.equal(P.riskOf(maskOf(['list'])), 'baixo');
  assert.equal(P.riskOf(maskOf(['list', 'view', 'input_controller', 'input_touch', 'input_pen'])), 'baixo');
  for (const n of ['launch', 'input_mouse', 'input_kbd', 'clipboard_set']) assert.equal(P.riskOf(bit(n)), 'medio', n);
  for (const n of ['server_cmd', 'clipboard_read', 'file_upload', 'file_dwnload']) assert.equal(P.riskOf(bit(n)), 'alto', n);
  assert.equal(P.riskOf(bit('launch') | bit('server_cmd')), 'alto', 'o mais alto vence');
  assert.deepEqual(Object.keys(P.RISKS).sort(), ['alto', 'baixo', 'medio', 'nenhum']);
});

test('isFullAccess, revokesStreaming, countShown', () => {
  assert.ok(P.isFullAccess(P.PERM_ALL));
  assert.ok(P.isFullAccess(P.PERM_ALL + 0x80000000));
  assert.ok(!P.isFullAccess(50331648));
  assert.ok(!P.isFullAccess(P.PERM_ALL & ~bit('input_pen')));
  assert.ok(!P.isFullAccess(NaN));
  assert.ok(P.revokesStreaming(0));
  assert.ok(P.revokesStreaming(bit('list')));
  assert.ok(P.revokesStreaming(maskOf(['list', 'input_kbd'])));
  assert.ok(!P.revokesStreaming(bit('view')));
  assert.ok(!P.revokesStreaming(bit('launch')));
  assert.equal(P.countShown(0), 0);
  assert.equal(P.countShown(P.PERM_ALL), P.SHOWN_PERMISSIONS.length);
  assert.equal(P.countShown(bit('launch')), 3, 'iniciar conta assistir e listar');
  assert.equal(P.SHOWN_PERMISSIONS.length, 11, 'upload e download não aparecem');
  assert.ok(P.SHOWN_PERMISSIONS.every((p) => p.name !== 'file_upload' && p.name !== 'file_dwnload'));
});

/* ---------- Rascunho, diff, rebase ---------- */
const DEV = () => ({
  name: 'A51 da sala', uuid: 'aaaaaaaa-1111-2222-3333-444444444444', display_mode: '', perm: 50331648,
  enable_legacy_ordering: true, allow_client_commands: true, always_use_virtual_display: false, connected: true,
});

test('draftFrom: tipos certos e padrões do servidor para campos ausentes', () => {
  const d = P.draftFrom({ uuid: 'x', perm: 50331648 });
  assert.deepEqual(d, { name: '', perm: 50331648, enable_legacy_ordering: true, allow_client_commands: true, always_use_virtual_display: false, display_mode: '', do: [], undo: [] });
  const e = P.draftFrom({ name: 5, perm: '119480064', enable_legacy_ordering: 'false', allow_client_commands: 0, always_use_virtual_display: 'true', display_mode: null, do: [{ cmd: 'a', elevated: 'true' }, null, { cmd: 5 }], undo: 'x' });
  assert.equal(e.name, '');
  assert.equal(e.perm, 119480064);
  assert.equal(e.enable_legacy_ordering, false);
  assert.equal(e.allow_client_commands, false);
  assert.equal(e.always_use_virtual_display, true);
  assert.equal(e.display_mode, '');
  assert.deepEqual(e.do, [{ cmd: 'a', elevated: true }, { cmd: '', elevated: false }]);
  assert.deepEqual(e.undo, []);
  assert.deepEqual(P.draftFrom(null), P.draftFrom({}));
  // a cópia é independente do original
  const src = { do: [{ cmd: 'x', elevated: false }] };
  const dd = P.draftFrom(src);
  dd.do[0].cmd = 'mudou';
  assert.equal(src.do[0].cmd, 'x');
});

test('diffDevice / sameField', () => {
  const a = DEV();
  assert.deepEqual(P.diffDevice(a, { ...a }), []);
  assert.deepEqual(P.diffDevice(a, { ...a, connected: false }), [], 'connected não é editável');
  assert.deepEqual(P.diffDevice(a, { ...a, name: 'Outro', perm: 119480064 }), ['name', 'perm']);
  assert.deepEqual(P.diffDevice(a, { ...a, perm: 50331648 + 0x80000000 }), [], 'bit desconhecido não conta');
  assert.deepEqual(P.diffDevice(a, { ...a, name: ' A51 da sala ' }), [], 'espaço nas pontas não conta');
  assert.deepEqual(P.diffDevice(a, { ...a, do: [{ cmd: 'x', elevated: false }] }), ['do']);
  assert.deepEqual(P.diffDevice({ ...a, do: [{ cmd: '  ', elevated: false }] }, a), [], 'linha vazia == sem comando');
  assert.deepEqual(P.diffDevice(a, { ...a, enable_legacy_ordering: false, allow_client_commands: false, always_use_virtual_display: true, display_mode: '1x1x1' }),
    ['enable_legacy_ordering', 'allow_client_commands', 'always_use_virtual_display', 'display_mode']);
  assert.ok(P.sameField('perm', 50331648, '50331648'));
  assert.ok(!P.sameField('enable_legacy_ordering', true, false));
});

test('changedKeys: só conta o que o usuário mexeu E ainda difere do salvo', () => {
  const base = DEV();
  const draft = P.draftFrom(base);
  assert.deepEqual(P.changedKeys(base, draft, new Set()), []);
  draft.name = 'Novo';
  assert.deepEqual(P.changedKeys(base, draft, new Set()), [], 'sem "touched" não conta');
  assert.deepEqual(P.changedKeys(base, draft, new Set(['name'])), ['name']);
  draft.name = base.name;
  assert.deepEqual(P.changedKeys(base, draft, new Set(['name'])), [], 'voltou ao original = sem alteração');
  draft.perm = P.PERM_ALL;
  draft.display_mode = '1920x1080x60';
  assert.deepEqual(P.changedKeys(base, draft, new Set(['perm', 'display_mode'])), ['perm', 'display_mode']);
});

test('rebaseDraft: o que o usuário não mexeu acompanha o servidor; o que mexeu é preservado', () => {
  const base = DEV();
  const draft = P.draftFrom(base);
  draft.name = 'Meu nome novo';
  const touched = new Set(['name']);
  const serverNow = { ...base, perm: P.PERM_ALL, name: 'Mudado em outro lugar', display_mode: '2400x1080x60' };
  const out = P.rebaseDraft(draft, touched, serverNow);
  assert.equal(out.name, 'Meu nome novo', 'preservou a edição');
  assert.equal(out.perm, P.PERM_ALL, 'acompanhou o servidor');
  assert.equal(out.display_mode, '2400x1080x60');
  assert.notEqual(out, draft, 'não altera o original');
  assert.equal(draft.perm, 50331648);
});

test('pruneTouched: marcou e voltou ao original deixa de contar, e uma mudança externa não é desfeita', () => {
  const base = DEV();
  const draft = P.draftFrom(base);
  draft.perm = P.togglePerm(draft.perm, 'input_kbd', true);
  const touched = new Set(['perm', 'name']);
  P.pruneTouched(base, draft, touched);
  assert.deepEqual([...touched], ['perm'], 'name não mudou: sai; perm mudou: fica');
  draft.perm = P.togglePerm(draft.perm, 'input_kbd', false);
  P.pruneTouched(base, draft, touched);
  assert.deepEqual([...touched], [], 'voltou ao original');
  // cenário do revisor: o servidor muda perm em outro lugar depois de marcar/desmarcar
  const serverNow = { ...base, perm: P.PERM_ALL };
  const out = P.rebaseDraft(draft, touched, serverNow);
  assert.equal(out.perm, P.PERM_ALL, 'o rascunho acompanha o servidor');
  assert.deepEqual(P.changedKeys(serverNow, out, touched), [], 'e o cartão não fica "Não salvo"');
  // comandos: lista editada à mão e restaurada
  const b2 = { ...DEV(), do: [{ cmd: 'a', elevated: false }] };
  const d2 = P.draftFrom(b2);
  d2.do.push({ cmd: '', elevated: false });   // linha vazia nova = sem diferença
  const t2 = new Set(['do']);
  P.pruneTouched(b2, d2, t2);
  assert.equal(t2.size, 0);
});

/* ---------- Validações ---------- */
test('validateDisplayMode: vazio ok; exige LARGURAxALTURAxFPS positivos', () => {
  for (const ok of ['', '   ', '1920x1080x60', '2400x1080x59.94', ' 1280x720x120 ', '3840x2160x144.5', '1x1x1']) assert.equal(P.validateDisplayMode(ok), null, JSON.stringify(ok));
  for (const bad of ['1920x1080', '1920', 'x', '1920x1080x', '1920x1080x60x1', '1920X1080X60', 'abc', '0x0x0', '1920x1080x0', '0x1080x60', '1920x0x60', '1920x1080x0.0',
    '-1920x1080x60', '1920x1080x60.', '1920x1080x.5', '1920 x 1080 x 60', '1920x1080x6e1', '١٩٢٠x1080x60']) {
    assert.equal(P.validateDisplayMode(bad), P.DISPLAY_MODE_ERROR, JSON.stringify(bad));
  }
  assert.equal(P.validateDisplayMode(null), null);
  assert.equal(P.validateDisplayMode(undefined), null);
});

test('cleanCommands: apara, descarta vazios e força boolean em elevated', () => {
  assert.deepEqual(P.cleanCommands(undefined), []);
  assert.deepEqual(P.cleanCommands('x'), []);
  assert.deepEqual(P.cleanCommands([
    { cmd: '  calc.exe  ', elevated: true }, { cmd: '', elevated: true }, { cmd: '   ' }, null, 5, { elevated: true }, { cmd: 7 },
    { cmd: 'a', elevated: 'true' }, { cmd: 'b', elevated: 'qualquer' }, { cmd: 'c', elevated: 1 }, { cmd: 'd' },
  ]), [
    { cmd: 'calc.exe', elevated: true }, { cmd: 'a', elevated: true }, { cmd: 'b', elevated: false }, { cmd: 'c', elevated: true }, { cmd: 'd', elevated: false },
  ]);
});

test('addsElevated: só avisa para comando elevado NOVO', () => {
  const old = [{ cmd: 'a.bat', elevated: true }, { cmd: 'b.bat', elevated: false }];
  assert.equal(P.addsElevated(old, old), false);
  assert.equal(P.addsElevated(old, [...old, { cmd: 'c.bat', elevated: false }]), false);
  assert.equal(P.addsElevated(old, [...old, { cmd: 'c.bat', elevated: true }]), true);
  assert.equal(P.addsElevated(old, [{ cmd: 'b.bat', elevated: true }]), true, 'virou elevado');
  assert.equal(P.addsElevated(undefined, [{ cmd: 'x', elevated: true }]), true);
  assert.equal(P.addsElevated(old, []), false);
  assert.equal(P.addsElevated(old, [{ cmd: '', elevated: true }]), false, 'linha vazia é descartada');
});

/* ---------- Corpo do update ---------- */
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

test('buildUpdateBody: copia o objeto sem "connected" e troca só o campo pedido', () => {
  const fresh = deepFreeze(DEV());
  const body = P.buildUpdateBody(fresh, { name: 'Celular do João' });
  const expected = { ...DEV(), name: 'Celular do João' };
  delete expected.connected;
  assert.deepEqual(body, expected);
  assert.ok(!('connected' in body));
  assert.equal(fresh.name, 'A51 da sala', 'não altera o original');
});

test('buildUpdateBody: sem mudanças, devolve o dispositivo inteiro (round-trip exato) — nada some', () => {
  for (const fresh of [
    DEV(),
    { ...DEV(), perm: P.PERM_ALL, do: [{ cmd: 'a.bat', elevated: true }], undo: [{ cmd: 'b.bat', elevated: false }], display_mode: '2400x1080x60', always_use_virtual_display: true, allow_client_commands: false, enable_legacy_ordering: false },
    { ...DEV(), perm: 0, connected: false },
    { ...DEV(), perm: 117440768 + 0x80000000 },   // bit desconhecido: o servidor descartaria igual
  ]) {
    const body = P.buildUpdateBody(fresh, {});
    const want = { ...fresh }; delete want.connected; want.perm = P.coerceMask(fresh.perm);
    assert.deepEqual(body, want);
  }
});

test('buildUpdateBody: tipos estritos (perm número; flags boolean; strings; comandos limpos)', () => {
  const body = P.buildUpdateBody({ uuid: 'u', name: 'n', perm: '119480064', enable_legacy_ordering: 'true', allow_client_commands: 'false', always_use_virtual_display: 0, display_mode: ' 1920x1080x60 ', do: [{ cmd: ' x ', elevated: 'true' }, { cmd: '' }], connected: true }, {});
  assert.equal(typeof body.perm, 'number');
  assert.equal(body.perm, 119480064);
  assert.strictEqual(body.enable_legacy_ordering, true);
  assert.strictEqual(body.allow_client_commands, false);
  assert.strictEqual(body.always_use_virtual_display, false);
  assert.strictEqual(body.display_mode, '1920x1080x60', 'aparado');
  assert.deepEqual(body.do, [{ cmd: 'x', elevated: true }]);
  assert.strictEqual(typeof body.name, 'string');
  assert.ok(!('undo' in body), 'undo ausente continua ausente');
  // o JSON final só tem tipos aceitos pelo servidor
  const parsed = JSON.parse(JSON.stringify(body));
  assert.equal(typeof parsed.perm, 'number');
  for (const k of ['enable_legacy_ordering', 'allow_client_commands', 'always_use_virtual_display']) assert.equal(typeof parsed[k], 'boolean');
});

test('buildUpdateBody: mudar perm normaliza as implicações; mudar flags e modo', () => {
  const fresh = DEV();
  assert.equal(P.buildUpdateBody(fresh, { perm: bit('launch') }).perm, maskOf(['launch', 'view', 'list']));
  assert.equal(P.buildUpdateBody(fresh, { perm: P.PERM_ALL }).perm, P.PERM_ALL);
  assert.equal(P.buildUpdateBody(fresh, { perm: 'lixo' }).perm, 0, 'lixo vira sem acesso, nunca tudo');
  const b = P.buildUpdateBody(fresh, { allow_client_commands: false, enable_legacy_ordering: false, always_use_virtual_display: true, display_mode: ' 2400x1080x60 ' });
  assert.deepEqual([b.allow_client_commands, b.enable_legacy_ordering, b.always_use_virtual_display, b.display_mode], [false, false, true, '2400x1080x60']);
  assert.equal(b.perm, 50331648, 'perm intocada continua igual');
  assert.equal(b.name, 'A51 da sala');
});

test('buildUpdateBody: comandos (do/undo)', () => {
  const fresh = DEV();
  assert.ok(!('do' in P.buildUpdateBody(fresh, {})));
  assert.deepEqual(P.buildUpdateBody(fresh, { do: [{ cmd: ' calc ', elevated: false }, { cmd: '  ' }] }).do, [{ cmd: 'calc', elevated: false }]);
  assert.deepEqual(P.buildUpdateBody(fresh, { do: [] }).do, [], 'esvaziar de propósito envia lista vazia');
  const withCmds = { ...fresh, do: [{ cmd: 'a', elevated: false }], undo: [{ cmd: 'b', elevated: true }] };
  const b = P.buildUpdateBody(withCmds, { do: [] });
  assert.deepEqual(b.do, []);
  assert.deepEqual(b.undo, [{ cmd: 'b', elevated: true }], 'a outra lista é preservada');
  const kept = P.buildUpdateBody({ ...withCmds }, { name: 'x' });
  assert.deepEqual(kept.do, [{ cmd: 'a', elevated: false }]);
});

test('buildUpdateBody: modo de monitor inválido JÁ SALVO não impede gravar outros campos (só valida se o usuário mexeu nele)', () => {
  const legacy = { ...DEV(), display_mode: '1920x1080' };   // o painel antigo deixava salvar sem o FPS
  const b1 = P.buildUpdateBody(legacy, { perm: P.PERM_ALL });
  assert.equal(b1.perm, P.PERM_ALL);
  assert.equal(b1.display_mode, '1920x1080', 'reenviado como estava');
  assert.equal(P.buildUpdateBody(legacy, { name: 'Novo nome' }).name, 'Novo nome');
  assert.equal(P.buildUpdateBody(legacy, {}).display_mode, '1920x1080');
  assert.equal(P.buildUpdateBody({ ...legacy, display_mode: '  1920x1080  ' }, { name: 'x' }).display_mode, '1920x1080', 'só aparado');
  // mexer no campo continua sendo validado, inclusive para apagar (vazio é válido)
  assert.throws(() => P.buildUpdateBody(legacy, { display_mode: '1280x720' }), /LARGURAxALTURAxFPS/);
  assert.throws(() => P.buildUpdateBody(legacy, { display_mode: '1280x720x0' }), /LARGURAxALTURAxFPS/);
  assert.equal(P.buildUpdateBody(legacy, { display_mode: '' }).display_mode, '');
  assert.equal(P.buildUpdateBody(legacy, { display_mode: '1280x720x60' }).display_mode, '1280x720x60');
  // tipo estranho vindo do servidor não vira "undefined" nem quebra
  assert.equal(P.buildUpdateBody({ ...DEV(), display_mode: null }, { name: 'a' }).display_mode, '');
  assert.equal(P.buildUpdateBody({ uuid: 'u', perm: 1, display_mode: 5 }, {}).display_mode, '');
});

test('buildUpdateBody: preserva campos desconhecidos do servidor e ignora chaves não editáveis em changes', () => {
  const fresh = { ...DEV(), campo_futuro: { a: 1 } };
  const body = P.buildUpdateBody(fresh, { uuid: 'outro', connected: true, nada: 1, name: 'Z' });
  assert.deepEqual(body.campo_futuro, { a: 1 });
  assert.equal(body.uuid, fresh.uuid, 'o uuid vem sempre do servidor');
  assert.ok(!('connected' in body) && !('nada' in body));
  assert.equal(body.name, 'Z');
});

test('buildUpdateBody: recusa o que não dá para gravar com segurança', () => {
  assert.throws(() => P.buildUpdateBody(null, {}), /identificador/);
  assert.throws(() => P.buildUpdateBody({ name: 'x', perm: 1 }, {}), /identificador/);
  assert.throws(() => P.buildUpdateBody({ uuid: '', perm: 1 }, {}), /identificador/);
  assert.throws(() => P.buildUpdateBody({ uuid: 'u', name: 'x' }, { name: 'y' }), /permiss/, 'sem perm atual e sem perm nova: não grava (viraria 0)');
  assert.throws(() => P.buildUpdateBody({ uuid: 'u', perm: 'abc' }, {}), /permiss/);
  assert.throws(() => P.buildUpdateBody({ uuid: 'u', perm: NaN }, {}), /permiss/);
  assert.throws(() => P.buildUpdateBody(DEV(), { display_mode: '1920x1080' }), /LARGURAxALTURAxFPS/);
  // se a mudança traz a perm nova, a atual ausente não atrapalha
  assert.equal(P.buildUpdateBody({ uuid: 'u' }, { perm: 50331648 }).perm, 50331648);
});

test('lostFields: confere o que o servidor guardou (nome pode mudar)', () => {
  const sent = P.buildUpdateBody(DEV(), { perm: P.PERM_ALL, name: 'Novo' });
  const got = { ...sent, name: 'Novo (2)', connected: false };
  assert.deepEqual(P.lostFields(sent, got), [], 'o servidor pode acrescentar (2) ao nome');
  assert.deepEqual(P.lostFields(sent, { ...got, perm: 50331648 }), ['perm']);
  assert.deepEqual(P.lostFields(sent, { ...got, display_mode: '1x1x1', allow_client_commands: false }), ['allow_client_commands', 'display_mode']);
  assert.equal(P.lostFields(sent, undefined).length, P.FIELD_KEYS.length, 'sumiu da lista = tudo perdido');
});
