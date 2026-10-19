// Ida e volta de TODAS as 104 chaves dos schemas: arquivo (texto do GET) -> tela (draft) -> edição -> corpo do POST -> servidor -> GET de novo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, serverWrite } from './settings.fixtures.test.mjs';
import { createModel, defaultDraft, parseFile, toFile, sortKeysDeep, NEVER_SEND } from '../../ui/js/lib/serialize.js';
import { choicesFor, KEEP_EXPLICIT, restoreValue } from '../../ui/js/lib/schema.js';
import { sameValue as configSameValue, META_KEYS } from '../../ui/js/lib/config.js';

const platformOf = (opt) => (!opt.platform || opt.platform.includes('windows') ? 'windows' : opt.platform[0]);
// Chaves do arquivo que a tela não conhece e precisam sobreviver; dd_configuration_option liga a lista de remapeamento; os campos manuais evitam o aviso de "preencha".
const ENV = { dd_configuration_option: 'ensure_primary', dd_manual_resolution: '2560x1440', dd_manual_refresh_rate: '60', flags: '0', future_key: 'x y z', share_library_extra: 'sim' };
const TEXT_SAMPLES = {
  dd_manual_resolution: ['2560x1440', '1280x720'],
  dd_manual_refresh_rate: ['59.9558', '144'],
  fallback_mode: ['1280x720x120', '3840x2160x30'],
  keybindings: ['[0x10,0xA0,0x4A,0x4B]', '[0x4A,0x4B]'],
  external_ip: ['203.0.113.7', '198.51.100.2'],
};
const LIST_A = (p) => [{ do: 'cmd /c a.bat', undo: 'cmd /c b.bat', ...(p === 'windows' ? { elevated: true } : {}) }];
const LIST_B = (p) => [{ do: 'x', undo: '', ...(p === 'windows' ? { elevated: false } : {}) }, { do: '', undo: 'y', ...(p === 'windows' ? { elevated: false } : {}) }];
const SERVER_A = (p) => [{ name: 'Bolhas', cmd: 'bubbles.scr', ...(p === 'windows' ? { elevated: false } : {}) }];
const SERVER_B = (p) => [{ name: 'Outro', cmd: 'calc.exe', ...(p === 'windows' ? { elevated: true } : {}) }];
const REMAP_A = { mixed: [{ final_refresh_rate: '119.95', final_resolution: '2560x1440', requested_fps: '60', requested_resolution: '1920x1080' }], refresh_rate_only: [], resolution_only: [] };
const REMAP_B = { mixed: [{ final_refresh_rate: '', final_resolution: '3840x2160', requested_fps: '', requested_resolution: '' }], refresh_rate_only: [], resolution_only: [{ final_resolution: '1280x720', requested_resolution: '1920x1080' }] };

/** Valores diferentes do padrão para a opção: [{draft, file}] onde file é o que deve parar no arquivo (texto ou array/objeto JSON). */
function variants(opt) {
  const p = platformOf(opt);
  switch (opt.kind) {
    case 'bool': {
      const on = opt.default !== 'enabled';
      return [{ draft: on, file: on ? 'enabled' : 'disabled' }];
    }
    case 'choice':
      // o padrão do motor vai por último: com a chave ausente ele é o valor lido, então não "suja" como primeira variação
      return choicesFor(opt, p).filter((c) => c.value !== String(restoreValue(opt)) && c.value !== '')
        .sort((a, b) => Number(a.value === String(opt.default)) - Number(b.value === String(opt.default)))
        .map((c) => ({ draft: c.value, file: c.value }));
    case 'text': {
      const [a, b] = TEXT_SAMPLES[opt.key] || ['teste um', 'teste-dois'];
      return [{ draft: `  ${a} `, file: a }, { draft: b, file: b }];
    }
    case 'int': {
      const d = Number(opt.default);
      const ok = (n) => n !== d && (opt.min === undefined || n >= opt.min) && (opt.max === undefined || n <= opt.max);
      const cands = [d + 1, d + 2, d - 1, d - 2, opt.min, opt.max, 7].filter((n) => n !== undefined && ok(n));
      const uniq = [...new Set(cands)].slice(0, 2);
      return uniq.map((n, i) => ({ draft: i === 0 ? ` ${n} ` : String(n), file: String(n) }));
    }
    case 'real': return opt.key === 'key_repeat_frequency'
      ? [{ draft: '30', file: '30' }, { draft: '12,50', file: '12.5' }]
      : [{ draft: '30', file: '30' }, { draft: '59.940', file: '59.94' }];
    case 'json':
      if (opt.widget === 'display_mode_remapping') return [{ draft: { ...REMAP_A, mixed: [{ ...REMAP_A.mixed[0], final_refresh_rate: '119,95' }] }, file: REMAP_A }, { draft: REMAP_B, file: sortKeysDeep(REMAP_B) }];
      if (opt.key === 'server_cmd') return [{ draft: SERVER_A(p).map((x) => ({ ...x, name: ` ${x.name} ` })), file: SERVER_A(p) }, { draft: SERVER_B(p), file: SERVER_B(p) }];
      return [{ draft: LIST_A(p).map((x) => ({ ...x, do: `  ${x.do}` })), file: LIST_A(p) }, { draft: [...LIST_B(p), { do: '  ', undo: '', ...(p === 'windows' ? { elevated: false } : {}) }], file: LIST_B(p) }];
    default: throw new Error(opt.kind);
  }
}
const asRaw = (file) => (typeof file === 'string' ? file : JSON.stringify(sortKeysDeep(file)));

test('as 104 chaves têm pelo menos uma variação testável', () => {
  assert.equal(catalog.options.length, 104);
  for (const opt of catalog.options) assert.ok(variants(opt).length >= 1, `${opt.key} sem variações`);
});

test('as chaves de metadados de config.js são as mesmas que serialize.js nunca envia', () => {
  assert.deepEqual([...NEVER_SEND].sort(), [...META_KEYS].sort());
});

for (const opt of catalog.options) {
  const platform = platformOf(opt);
  const env = { ...ENV }; delete env[opt.key];
  const vs = variants(opt);

  test(`ida e volta: ${opt.key} (${opt.kind})`, () => {
    // 0) Ausente do arquivo = padrão; gravar o padrão remove a chave (exceto as que precisam ficar explícitas).
    const m0 = createModel(catalog, { platform });
    m0.load(env);
    assert.deepEqual(m0.draft[opt.key], defaultDraft(opt));
    assert.equal(m0.isDirty(opt.key), false);
    // chave ausente = padrão do motor; só dd_configuration_option tem um padrão do R3D PLAY diferente (ensure_primary)
    assert.equal(m0.isDefault(opt.key), opt.panelDefault == null);
    assert.equal(m0.buildSave(env).ok, true);
    assert.deepEqual(m0.buildSave(env).body, env, 'sem edição, o corpo é o arquivo');

    // 1) Arquivo com a variação A: lê, não fica sujo, e sem edição o texto original é preservado byte a byte.
    const A = vs[0];
    const fileA = { ...env, [opt.key]: asRaw(A.file) };
    const mA = createModel(catalog, { platform });
    mA.load(fileA);
    assert.equal(mA.isDirty(opt.key), false, 'ler do arquivo não suja');
    assert.equal(mA.parseErrors[opt.key], undefined);
    assert.equal(mA.isDefault(opt.key), false, 'a variação não é o padrão');
    const keepA = mA.buildSave(fileA);
    assert.deepEqual(keepA.body, fileA);
    assert.equal(typeof keepA.body[opt.key], 'string');

    // 2) Restaurar o padrão: a chave sai do arquivo (ou vira o padrão explícito).
    mA.reset(opt.key);
    assert.equal(mA.isDirty(opt.key), true);
    const reset = mA.buildSave(fileA);
    assert.equal(reset.ok, true, JSON.stringify(reset.errors));
    if (KEEP_EXPLICIT.has(opt.key)) assert.equal(reset.body[opt.key], String(restoreValue(opt)));
    else assert.equal(opt.key in reset.body, false);
    for (const k of Object.keys(env)) assert.equal(reset.body[k], env[k], `preserva ${k}`);

    // 3) Da tela vazia para a variação A (com espaços/vírgulas a normalizar) e depois para as demais.
    for (const [i, v] of vs.entries()) {
      const m = createModel(catalog, { platform });
      m.load(i === 0 ? env : { ...env, [opt.key]: asRaw(vs[0].file) });
      m.set(opt.key, v.draft);
      assert.equal(m.isDirty(opt.key), true, `variação ${i} deve sujar`);
      const save = m.buildSave(i === 0 ? env : { ...env, [opt.key]: asRaw(vs[0].file) });
      assert.equal(save.ok, true, `variação ${i}: ${JSON.stringify(save.errors)}`);
      assert.deepEqual(save.body[opt.key], opt.kind === 'json' ? sortKeysDeep(v.file) : v.file, `variação ${i}`);
      for (const k of Object.keys(env)) assert.equal(save.body[k], env[k]);
      for (const k of NEVER_SEND) assert.equal(k in save.body, false);
      if (opt.kind !== 'json') assert.equal(typeof save.body[opt.key], 'string', 'valores simples vão como texto puro');

      // 4) O servidor grava, o GET devolve texto, a verificação de config.js confere e a tela relê o mesmo valor.
      const written = serverWrite(save.body);
      assert.equal(configSameValue(save.body[opt.key], written[opt.key]), true, 'writeConfig confere com sameValue');
      const m2 = createModel(catalog, { platform });
      m2.load(written);
      assert.equal(m2.isDirty(opt.key), false);
      assert.equal(m2.parseErrors[opt.key], undefined);
      assert.equal(m2.isDefault(opt.key), false);
      assert.equal(m2.buildSave(written).body[opt.key], written[opt.key], 'segunda gravação sem edição não muda nada');
      // e é idempotente: gravar a leitura dá o mesmo arquivo
      assert.deepEqual(serverWrite(m2.buildSave(written).body), written);
    }
  });
}

test('toFile/parseFile: ausente vira padrão e o padrão sai do arquivo, para todas as chaves', () => {
  for (const opt of catalog.options) {
    const platform = platformOf(opt);
    const r = parseFile(opt, undefined, { platform });
    assert.equal(r.absent, true, opt.key);
    const out = toFile(opt, r.value, { platform, get: () => 'auto' });
    if (KEEP_EXPLICIT.has(opt.key)) assert.equal(out.value, String(opt.default), opt.key);
    else assert.equal(out.remove, true, opt.key);
  }
});

test('"#" em QUALQUER campo de texto é bloqueado: o servidor cortaria o valor e a conferência por GET falharia', () => {
  const textos = catalog.options.filter((o) => o.kind === 'text');
  assert.ok(textos.length >= 16);
  for (const opt of textos) {
    const platform = platformOf(opt);
    const m = createModel(catalog, { platform });
    m.load({ ...ENV, dd_resolution_option: 'manual', dd_refresh_rate_option: 'manual' });
    m.set(opt.key, 'abc #1');
    const s = m.buildSave(m.values);
    assert.equal(s.ok, false, `${opt.key}: deveria bloquear`);
    assert.ok(s.errors[opt.key], opt.key);
    assert.equal(opt.key in s.body && s.body[opt.key] === 'abc #1', false, opt.key);
  }
  // por que bloquear: o servidor simulado devolve o valor cortado e o writeConfig reprovaria
  const lido = serverWrite({ sunshine_name: 'Sala #1' });
  assert.equal(lido.sunshine_name, 'Sala ');
  assert.equal(configSameValue('Sala #1', lido.sunshine_name), false);
  assert.equal('sunshine_name' in serverWrite({ sunshine_name: '#x' }), false);
  // listas: o "#" dentro de um comando é bloqueado na validação (validateList), nunca chega ao corpo
  for (const key of ['global_prep_cmd', 'global_state_cmd']) {
    const m = createModel(catalog, { platform: 'windows' });
    m.load({});
    m.set(key, [{ do: 'echo #1', undo: '', elevated: false }]);
    assert.equal(m.buildSave({}).ok, false, key);
  }
  const sc = createModel(catalog, { platform: 'windows' });
  sc.load({});
  sc.set('server_cmd', [{ name: 'A #1', cmd: 'a.exe', elevated: false }]);
  assert.equal(sc.buildSave({}).ok, false);
});

test('o arquivo real de exemplo da documentação sobrevive intacto a uma gravação sem edição', () => {
  const sample = {
    dd_configuration_option: 'ensure_primary', gamepad: 'auto', locale: 'pt_BR', origin_web_ui_allowed: 'pc',
    server_cmd: '[{"cmd":"bubbles.scr","elevated":false,"name":"Bubbles"}]', upnp: 'enabled',
    status: true, platform: 'windows', version: '0.0.0.98695412.dirty', vdisplayStatus: 0,
  };
  const m = createModel(catalog, { platform: 'windows' });
  const { status, platform, version, vdisplayStatus, ...file } = sample;
  m.load(sample);                                   // metadados misturados não entram no modelo
  assert.deepEqual(m.values, file);
  const save = m.buildSave(sample);                 // nem saem no corpo
  assert.deepEqual(save.body, file);
  assert.equal(m.dirtyKeys().length, 0);
  assert.equal(m.draft.upnp, true);
  assert.equal(m.draft.gamepad, 'auto');
  assert.equal(m.draft.server_cmd[0].name, 'Bubbles');
});
