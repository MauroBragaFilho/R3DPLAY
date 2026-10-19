// Testes do catálogo (js/lib/schema.js) com os schemas REAIS de ui/schema/*.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, readSchema, loadRaws } from './settings.fixtures.test.mjs';
import {
  CATEGORIES, platformOk, evalCond, isActive, groupActive, groupTitle, dependsOn, labelFor, helpFor, placeholderFor, extrasFor,
  choicesFor, defaultLabel, describeCond, norm, searchCatalog, parseKeepRule, activeRemapList, vdisplayInfo, VDISPLAY_WARNING,
  liveNotes, portTable, brandSafe, buildCatalog, plainDefault, isShown, riskNotes, restoreValue, PANEL_PORT,
} from '../../ui/js/lib/schema.js';

const get = (obj) => (k) => obj[k] ?? '';

test('catálogo: 104 opções, chaves únicas, contagem por categoria', () => {
  assert.equal(catalog.options.length, 104);
  assert.equal(new Set(catalog.options.map((o) => o.key)).size, 104);
  const counts = Object.fromEntries(catalog.categories.map((c) => [c.id, c.sections.reduce((n, s) => n + s.options.length, 0)]));
  assert.deepEqual(counts, { general: 11, audiovideo: 23, encoders: 25, inputs: 17, network: 14, advanced: 11, outros: 3 });
  assert.deepEqual(catalog.categories.map((c) => c.label), ['Geral', 'Áudio e vídeo', 'Codificadores', 'Entradas', 'Rede e arquivos', 'Avançado', 'Outras']);
  assert.equal(catalog.categories.length, CATEGORIES.length);
});

test('catálogo: seções de áudio e vídeo (audio, captura, tela) e uid único (existem 2 seções "tela")', () => {
  const av = catalog.categories.find((c) => c.id === 'audiovideo');
  assert.deepEqual(av.sections.map((s) => s.id), ['audio', 'captura', 'tela']);
  const uids = catalog.categories.flatMap((c) => c.sections.map((s) => s.uid));
  assert.equal(new Set(uids).size, uids.length);
  assert.ok(uids.includes('outros.tela') && uids.includes('audiovideo.tela'));
});

test('catálogo: tipos de valor', () => {
  const kinds = {};
  for (const o of catalog.options) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
  assert.deepEqual(kinds, { bool: 43, choice: 28, text: 16, int: 11, real: 2, json: 4 });
  assert.equal(catalog.byKey.get('key_repeat_frequency').kind, 'real');
  assert.equal(catalog.byKey.get('minimum_fps_target').kind, 'real');
  assert.equal(catalog.byKey.get('port').kind, 'int');
});

test('catálogo: consistência interna dos schemas', () => {
  for (const o of catalog.options) {
    for (const k of dependsOn(o.showIf)) assert.ok(catalog.byKey.has(k), `${o.key}: showIf aponta para ${k}, que não existe`);
    for (const k of dependsOn(o.helpShowIf)) assert.ok(catalog.byKey.has(k), `${o.key}: helpShowIf aponta para ${k}`);
    if (o.group) {
      const sec = catalog.categories.flatMap((c) => c.sections).find((s) => s.uid === o.sec);
      assert.ok(sec.groups.some((g) => g.id === o.group), `${o.key}: grupo ${o.group} não existe na seção`);
    }
    if (o.kind === 'bool') assert.ok(['enabled', 'disabled'].includes(o.default), `${o.key}: default de toggle`);
    if (o.kind === 'choice') {
      const values = o.choices.map((c) => c.value);
      assert.equal(new Set(values).size, values.length, `${o.key}: valores repetidos`);
      assert.ok(values.includes(String(o.default)), `${o.key}: o padrão ${o.default} não está nas opções`);
    }
    if (o.kind === 'json') assert.ok(o.widget, `${o.key}: lista sem widget`);
  }
});

test('plataforma: platformOk e contagem de opções visíveis por sistema', () => {
  assert.equal(platformOk(null, 'windows'), true);
  assert.equal(platformOk([], 'linux'), true);
  assert.equal(platformOk(['windows'], 'linux'), false);
  assert.equal(platformOk(['windows', 'linux'], 'linux'), true);
  const count = (p) => catalog.options.filter((o) => platformOk(o.platform, p)).length;
  assert.equal(count('windows'), 99);   // 53 de todas + 35 só Windows + 11 Windows/Linux
  assert.equal(count('linux'), 66);
  assert.equal(count('macos'), 56);
  // Windows esconde as opções de macOS e Linux
  const hiddenWin = catalog.options.filter((o) => !platformOk(o.platform, 'windows')).map((o) => o.key);
  assert.ok(hiddenWin.includes('vt_coder') && hiddenWin.includes('vaapi_strict_rc_buffer') && hiddenWin.includes('ds5_inputtino_randomize_mac'));
  assert.ok(!hiddenWin.includes('port') && !hiddenWin.includes('nvenc_preset'));
});

test('plataforma: escolhas de select filtradas (gamepad, capture, encoder)', () => {
  const gp = catalog.byKey.get('gamepad');
  assert.deepEqual(choicesFor(gp, 'windows').map((c) => c.value), ['auto', 'ds4', 'x360']);
  assert.deepEqual(choicesFor(gp, 'linux').map((c) => c.value), ['auto', 'ds5', 'switch', 'xone']);
  assert.deepEqual(choicesFor(catalog.byKey.get('capture'), 'windows').map((c) => c.value), ['', 'ddx', 'wgc']);
  assert.deepEqual(choicesFor(catalog.byKey.get('encoder'), 'windows').map((c) => c.value), ['', 'nvenc', 'quicksync', 'amdvce', 'software']);
});

test('textos por plataforma: rótulo, ajuda, placeholder e extras', () => {
  const sink = catalog.byKey.get('audio_sink');
  assert.match(helpFor(sink, 'windows'), /ID do dispositivo/);
  assert.match(helpFor(sink, 'linux'), /pulseaudio/);
  assert.equal(placeholderFor(sink, 'linux'), 'alsa_output.pci-0000_09_00.3.analog-stereo');
  assert.match(placeholderFor(sink, 'windows'), /Alto-falantes/);
  assert.equal(extrasFor(sink, 'windows')[0].text, 'tools\\audio-info.exe');
  assert.deepEqual(extrasFor(sink, 'freebsd'), []);
  assert.equal(labelFor(catalog.byKey.get('output_name'), 'linux'), 'Número do monitor');
  assert.equal(labelFor(catalog.byKey.get('output_name'), 'windows'), 'ID do monitor');
});

test('marca: nenhum texto visível cita Apollo/Sunshine/Moonlight/Artemis', () => {
  const bad = /apollo|sunshine|moonlight|artemis/i;
  const texts = [];
  for (const o of catalog.options) {
    texts.push([o.key + '.label', o.label], [o.key + '.help', o.help], [o.key + '.secTitle', o.secTitle]);
    for (const c of o.choices || []) texts.push([o.key + '.choice', c.label]);
    for (const m of [o.labelByPlatform, o.helpByPlatform]) for (const v of Object.values(m || {})) texts.push([o.key + '.byPlatform', v]);
    for (const l of Object.values(o.widgetConfig?.helpLines?.sops || {})) if (l) texts.push([o.key + '.sops', brandSafe(l)]);
  }
  for (const c of catalog.categories) for (const s of c.sections) for (const g of s.groups) texts.push([g.id, g.title], [g.id + '.notice', g.notice?.text || '']);
  for (const [where, t] of texts) assert.doesNotMatch(t || '', bad, `${where}: "${t}"`);
  assert.equal(brandSafe('cliente Moonlight'), 'aplicativo do celular');
  assert.equal(brandSafe('dos clientes Moonlight'), 'dos aplicativos do celular');
  assert.equal(brandSafe('cliente Artemis/Moonlight'), 'aplicativo do celular');
  assert.equal(brandSafe('pelo Moonlight'), 'pelo aplicativo do celular');
  assert.equal(brandSafe('Sunshine e Apollo'), 'R3D PLAY e R3D PLAY');
  assert.equal(brandSafe(42), 42);
});

test('showIf: in, and, aninhado, chave desconhecida', () => {
  const cond = { key: 'a', in: ['x', 'y'], and: [{ key: 'b', in: ['1'] }] };
  assert.equal(evalCond(cond, get({ a: 'x', b: '1' })), true);
  assert.equal(evalCond(cond, get({ a: 'y', b: '1' })), true);
  assert.equal(evalCond(cond, get({ a: 'z', b: '1' })), false);
  assert.equal(evalCond(cond, get({ a: 'x', b: '2' })), false);
  assert.equal(evalCond(cond, get({})), false);
  assert.equal(evalCond(null, get({})), true);
  assert.equal(evalCond({ key: 'a', notIn: ['x'] }, get({ a: 'y' })), true);
  assert.equal(evalCond({ key: 'a', notIn: ['x'] }, get({ a: 'x' })), false);
  assert.equal(evalCond({ or: [{ key: 'a', in: ['1'] }, { key: 'b', in: ['1'] }] }, get({ b: '1' })), true);
  assert.deepEqual([...dependsOn(cond)].sort(), ['a', 'b']);
});

test('showIf entre categorias: dd_wa_hdr_toggle_delay (Outras) depende de dd_configuration_option (Áudio e vídeo)', () => {
  const o = catalog.byKey.get('dd_wa_hdr_toggle_delay');
  assert.notEqual(o.cat, catalog.byKey.get('dd_configuration_option').cat);
  assert.equal(isActive(o, get({ dd_configuration_option: 'disabled' }), 'windows'), false);
  assert.equal(isActive(o, get({ dd_configuration_option: 'ensure_primary' }), 'windows'), true);
  assert.equal(isActive(o, get({ dd_configuration_option: 'ensure_primary' }), 'linux'), false);   // plataforma manda primeiro
});

test('showIf: dd_manual_resolution exige as duas condições', () => {
  const o = catalog.byKey.get('dd_manual_resolution');
  assert.equal(isActive(o, get({ dd_configuration_option: 'ensure_active', dd_resolution_option: 'manual' }), 'windows'), true);
  assert.equal(isActive(o, get({ dd_configuration_option: 'disabled', dd_resolution_option: 'manual' }), 'windows'), false);
  assert.equal(isActive(o, get({ dd_configuration_option: 'ensure_active', dd_resolution_option: 'auto' }), 'windows'), false);
});

test('grupos: título por gamepad, visibilidade e plataforma', () => {
  const sec = catalog.categories.find((c) => c.id === 'inputs').sections.find((s) => s.id === 'gamepad');
  const g = sec.groups[0];
  assert.equal(groupTitle(g, get({ gamepad: 'ds4' })), 'Opções de seleção DS4');
  assert.equal(groupTitle(g, get({ gamepad: 'auto' })), 'Opções de seleção automática');
  assert.equal(groupTitle(g, get({ gamepad: 'zzz' })), 'Opções de seleção automática');
  assert.equal(groupActive(g, get({ controller: 'enabled', gamepad: 'auto' }), 'windows'), true);
  assert.equal(groupActive(g, get({ controller: 'disabled', gamepad: 'auto' }), 'windows'), false);
  assert.equal(groupActive(g, get({ controller: 'enabled', gamepad: 'x360' }), 'windows'), false);
  assert.equal(groupActive(g, get({ controller: 'enabled', gamepad: 'auto' }), 'macos'), false);
  const dd = catalog.categories.find((c) => c.id === 'audiovideo').sections.find((s) => s.id === 'tela').groups[0];
  assert.equal(dd.open, false);
  assert.equal(groupActive(dd, get({}), 'windows'), true);
  assert.equal(groupActive(dd, get({}), 'linux'), false);
  assert.match(dd.notice.text, /Não é recomendado/);
});

test('describeCond: explica a dependência em português', () => {
  const man = catalog.byKey.get('dd_manual_resolution');
  const t = describeCond(man.showIf, catalog, 'windows');
  assert.match(t, /“Resolução”/);
  assert.match(t, /Usar resolução inserida manualmente/);
  assert.match(t, / e /);
  assert.match(describeCond(catalog.byKey.get('high_resolution_scrolling').showIf, catalog, 'windows'), /“Ativar entrada do mouse” estiver ativado/);
  assert.match(describeCond(catalog.byKey.get('dd_resolution_option').showIf, catalog, 'windows'), /não estiver em “Desativado”/);
  assert.equal(describeCond(null, catalog, 'windows'), '');
});

test('defaultLabel: rótulo do padrão por tipo', () => {
  assert.equal(defaultLabel(catalog.byKey.get('upnp'), 'windows'), 'Desativado');
  assert.equal(defaultLabel(catalog.byKey.get('mouse'), 'windows'), 'Ativado');
  assert.equal(defaultLabel(catalog.byKey.get('ping_timeout'), 'windows'), '10000 ms');
  assert.equal(defaultLabel(catalog.byKey.get('qp'), 'windows'), '28');
  assert.equal(defaultLabel(catalog.byKey.get('address_family'), 'windows'), 'Somente IPv4');
  assert.equal(defaultLabel(catalog.byKey.get('capture'), 'windows'), 'Autodetecção (recomendado)');
  assert.equal(defaultLabel(catalog.byKey.get('sunshine_name'), 'windows'), '');
  assert.equal(defaultLabel(catalog.byKey.get('global_prep_cmd'), 'windows'), 'lista vazia');
});

test('busca: sem acento, várias palavras, ignora o filtro Essenciais e a plataforma errada', () => {
  assert.equal(norm('Configuração À'), 'configuracao a');
  const keys = (q, p = 'windows') => searchCatalog(catalog, q, p).map((r) => r.opt.key);
  assert.ok(keys('taxa de bits').includes('max_bitrate'));
  assert.ok(keys('TAXA DE BITS').includes('max_bitrate'));
  assert.ok(keys('qualidade').includes('max_bitrate'));                   // sinônimo
  assert.ok(keys('upnp').includes('upnp'));                               // chave
  assert.ok(keys('fec_percentage').includes('fec_percentage'));
  assert.ok(keys('porcentagem fec').includes('fec_percentage'));          // avançada: aparece mesmo assim
  assert.ok(catalog.byKey.get('fec_percentage').advanced);
  assert.ok(keys('correcao de erros').includes('fec_percentage'));        // vem da ajuda
  assert.deepEqual(keys('zzzzqqq'), []);
  assert.deepEqual(keys('   '), []);
  assert.ok(!keys('videotoolbox').includes('vt_coder'));                  // macOS não aparece no Windows
  assert.ok(keys('videotoolbox', 'macos').includes('vt_coder'));
  // relevância: rótulo vence ajuda
  const r = searchCatalog(catalog, 'porta', 'windows');
  assert.equal(r[0].opt.key, 'port');
  assert.ok(r.every((x, i) => i === 0 || r[i - 1].score >= x.score));
});

test('parseKeepRule: lê a regra sem eval', () => {
  assert.deepEqual(parseKeepRule("trim(do) != '' || trim(undo) != ''"), { mode: 'any', fields: ['do', 'undo'] });
  assert.deepEqual(parseKeepRule("trim(name) != '' && trim(cmd) != ''"), { mode: 'all', fields: ['name', 'cmd'] });
  assert.equal(parseKeepRule("trim(a) != '' || trim(b) != '' && trim(c) != ''"), null);
  assert.equal(parseKeepRule('process.exit()'), null);
  assert.equal(parseKeepRule(undefined), null);
  assert.equal(parseKeepRule(''), null);
  for (const k of ['global_prep_cmd', 'global_state_cmd', 'server_cmd']) assert.ok(parseKeepRule(catalog.byKey.get(k).widgetConfig.keepItemWhen), k);
});

test('activeRemapList: mesma regra do painel original', () => {
  const al = (o) => activeRemapList(get(o));
  assert.equal(al({ dd_configuration_option: 'disabled' }), null);
  assert.equal(al({ dd_configuration_option: 'ensure_primary', dd_resolution_option: 'auto', dd_refresh_rate_option: 'auto' }), 'mixed');
  assert.equal(al({ dd_configuration_option: 'ensure_primary', dd_resolution_option: 'auto', dd_refresh_rate_option: 'manual' }), 'resolution_only');
  assert.equal(al({ dd_configuration_option: 'ensure_primary', dd_resolution_option: 'manual', dd_refresh_rate_option: 'auto' }), 'refresh_rate_only');
  assert.equal(al({ dd_configuration_option: 'ensure_primary', dd_resolution_option: 'manual', dd_refresh_rate_option: 'manual' }), null);
  assert.equal(al({ dd_configuration_option: 'ensure_primary', dd_resolution_option: 'disabled', dd_refresh_rate_option: 'auto' }), 'refresh_rate_only');
  assert.equal(al({ dd_configuration_option: 'ensure_only_display' }), 'mixed');   // sem as outras chaves: padrões "auto"
});

test('vdisplayStatus: textos e níveis iguais aos de system.json (info)', () => {
  const info = readSchema('system').info.find((i) => i.key === 'vdisplayStatus');
  for (const [code, v] of Object.entries(info.valores)) {
    const got = vdisplayInfo(Number(code));
    assert.equal(got.text, v.texto, `código ${code}`);
    assert.equal(got.level, v.nivel === 'ok' ? 'ok' : 'warn', `nível do código ${code}`);
    assert.equal(got.hint, v.nivel === 'ok' ? '' : VDISPLAY_WARNING);
  }
  assert.match(VDISPLAY_WARNING, /SudoVDA/);
  assert.equal(vdisplayInfo('0').text, 'Pronto');              // texto numérico também vale
  assert.equal(vdisplayInfo(undefined), null);
  assert.equal(vdisplayInfo(null), null);
  assert.equal(vdisplayInfo('abc'), null);
  assert.equal(vdisplayInfo(7).level, 'warn');                 // código novo = aviso
  assert.match(vdisplayInfo(7).text, /7/);
});

test('avisos ao vivo: porta fora da faixa e acesso pela Internet', () => {
  assert.equal(liveNotes('port', get({ port: '47989' })).length, 0);
  assert.equal(liveNotes('port', get({ port: '1025' })).length, 1);        // 1025 - 5 < 1024
  assert.equal(liveNotes('port', get({ port: '65530' })).length, 1);       // + 21 > 65535
  assert.equal(liveNotes('origin_web_ui_allowed', get({ origin_web_ui_allowed: 'lan' })).length, 0);
  assert.equal(liveNotes('origin_web_ui_allowed', get({ origin_web_ui_allowed: 'wan' })).length, 1);
  const both = liveNotes('origin_web_ui_allowed', get({ origin_web_ui_allowed: 'wan', upnp: 'enabled' }));
  assert.equal(both.length, 2);
  assert.equal(both[1].kind, 'bad');
  assert.deepEqual(liveNotes('qp', get({})), []);
});

test('avisos ao vivo: mudar a porta ou os arquivos de identidade só avisa depois de editar', () => {
  assert.equal(PANEL_PORT, '47989');
  assert.equal(liveNotes('port', get({ port: '48000' })).length, 0);                       // sem edição: nada
  const mudou = liveNotes('port', get({ port: '48000' }), { dirty: true });
  assert.equal(mudou.length, 1);
  assert.equal(mudou[0].kind, 'bad');
  assert.match(mudou[0].text, /47989/);
  assert.match(mudou[0].text, /perde a conexão/);
  assert.equal(liveNotes('port', get({ port: '47989' }), { dirty: true }).length, 0);       // voltar ao padrão não assusta
  assert.equal(liveNotes('port', get({ port: '' }), { dirty: true }).length, 0);            // vazio = padrão
  for (const k of ['file_state', 'credentials_file', 'pkey', 'cert']) {
    assert.equal(liveNotes(k, get({ [k]: 'x.json' })).length, 0, k);
    assert.equal(liveNotes(k, get({ [k]: 'x.json' }), { dirty: true }).length, 1, k);
  }
  assert.equal(liveNotes('qp', get({ qp: '30' }), { dirty: true }).length, 0);
});

test('riscos ao salvar: porta diferente da padrão e arquivos de identidade', () => {
  const body = { port: '48000', pkey: 'k.pem', qp: '30' };
  const r = riskNotes(['port', 'pkey', 'qp'], (k) => body[k]);
  assert.deepEqual(r.map((x) => x.key), ['port', 'pkey']);
  assert.match(r[0].text, /48000/);
  assert.deepEqual(riskNotes(['port'], () => undefined), []);                  // chave removida = porta padrão
  assert.deepEqual(riskNotes(['port'], () => '47989'), []);
  assert.equal(riskNotes(['file_state'], () => undefined).length, 1);          // tirar o arquivo também troca o arquivo usado
  assert.deepEqual(riskNotes([], () => 'x'), []);
});

test('isShown: considera também o showIf e a plataforma do GRUPO (campo ativo dentro de grupo escondido não aparece)', () => {
  const m = catalog.byKey.get('motion_as_ds4');
  assert.ok(m.groupUid);
  assert.ok(catalog.groupByUid.get(m.groupUid));
  const g = (o) => (k) => o[k] ?? '';
  assert.equal(isShown(m, catalog, g({ controller: 'enabled', gamepad: 'auto' }), 'windows'), true);
  assert.equal(isShown(m, catalog, g({ controller: 'disabled', gamepad: 'auto' }), 'windows'), false);
  assert.equal(isShown(m, catalog, g({ controller: 'enabled', gamepad: 'auto' }), 'macos'), false);
  assert.equal(isShown(catalog.byKey.get('port'), catalog, g({}), 'windows'), true);
});

test('groupTitle: valor estranho no arquivo ("constructor") não vira título', () => {
  const grp = catalog.categories.find((c) => c.id === 'inputs').sections[0].groups[0];
  assert.ok(grp.titleBy);
  assert.equal(groupTitle(grp, get({ gamepad: 'ds4' })), 'Opções de seleção DS4');
  assert.equal(groupTitle(grp, get({ gamepad: 'constructor' })), grp.title);
  assert.equal(groupTitle(grp, get({ gamepad: 'toString' })), grp.title);
});

test('textos: sem restos de tradução, de interface antiga ou erros de digitação', () => {
  const ruim = /\(traduzido\)|Solução de Problemas|\balgums\b|\bForce um\b|launcher R3D PLAY|UI da [Ww]eb|123\.456\.789/;
  const texts = [];
  for (const o of catalog.options) {
    texts.push([`${o.key}.label`, o.label], [`${o.key}.help`, o.help], [`${o.key}.placeholder`, o.placeholder]);
    for (const v of Object.values(o.helpByPlatform || {})) texts.push([`${o.key}.helpBy`, v]);
    for (const c of o.choices || []) texts.push([`${o.key}.choice.${c.value}`, c.label]);
  }
  for (const [where, t] of texts) assert.doesNotMatch(t || '', ruim, `${where}: "${t}"`);
  assert.doesNotMatch(helpFor(catalog.byKey.get('keybindings'), 'windows'), /^\(/);
  assert.match(helpFor(catalog.byKey.get('output_name'), 'windows'), /aba Sistema, em Registro/);
  assert.match(helpFor(catalog.byKey.get('output_name'), 'linux'), /aba Sistema, em Registro/);
  assert.equal(catalog.byKey.get('external_ip').placeholder, '203.0.113.25');
  assert.equal(brandSafe('(traduzido) Texto'), 'Texto');
  assert.match(labelFor(catalog.byKey.get('share_library'), 'windows'), /R3D LAUNCHER/);
  assert.match(helpFor(catalog.byKey.get('share_library'), 'windows'), /R3D LAUNCHER/);
  assert.match(helpFor(catalog.byKey.get('limit_framerate'), 'windows'), /alguns/);
  assert.match(helpFor(catalog.byKey.get('encoder'), 'windows'), /^Use um codificador/);
  assert.doesNotMatch(helpFor(catalog.byKey.get('fallback_mode'), 'windows'), /UI da/);
});

test('textos: vocabulário do painel (celular / este PC) nas ajudas de entrada e rede', () => {
  const h = (k) => helpFor(catalog.byKey.get(k), 'windows');
  assert.match(h('controller'), /quem usa o celular controle este PC/);
  assert.match(h('keyboard'), /controle o teclado deste PC/);
  assert.match(h('mouse'), /controle o mouse deste PC/);
  assert.match(h('enable_discovery'), /endereço IP deste PC no aplicativo do celular/);
  assert.match(labelFor(catalog.byKey.get('motion_as_ds4'), 'windows'), /controle do celular/);
  for (const k of ['controller', 'keyboard', 'mouse', 'gamepad', 'enable_discovery']) assert.doesNotMatch(h(k), /convidado|do servidor|no servidor|host no cliente/, k);
});

test('escolhas: rótulos únicos dentro de cada select (o usuário distingue as opções)', () => {
  for (const o of catalog.options.filter((x) => x.kind === 'choice')) {
    for (const plat of ['windows', 'linux', 'macos']) {
      const labels = choicesFor(o, plat).map((c) => c.label);
      assert.equal(new Set(labels).size, labels.length, `${o.key} (${plat}): rótulos repetidos: ${labels.join(' | ')}`);
    }
  }
  const q = Object.fromEntries(choicesFor(catalog.byKey.get('qsv_preset'), 'windows').map((c) => [c.value, c.label]));
  assert.notEqual(q.slower, q.veryslow);
  assert.notEqual(q.veryfast, q.faster);
  const a = choicesFor(catalog.byKey.get('amd_quality'), 'windows').map((c) => c.label);
  assert.deepEqual(a, ['Velocidade', 'Equilibrado (padrão)', 'Qualidade']);
  const o = choicesFor(catalog.byKey.get('origin_web_ui_allowed'), 'windows');
  assert.deepEqual(o.map((c) => c.value), ['pc', 'lan', 'wan']);
  assert.equal(o[0].label, 'Somente este PC');
  assert.equal(labelFor(catalog.byKey.get('origin_web_ui_allowed'), 'windows'), 'Quem pode abrir este painel');
  assert.doesNotMatch(helpFor(catalog.byKey.get('origin_web_ui_allowed'), 'windows'), /é deve/);
});

test('tabela de portas a partir da base', () => {
  const t = portTable(47989);
  assert.deepEqual(t.map((r) => r.port), ['47984', '47989', '47990', '48010', '47998 a 48000']);
  assert.deepEqual(portTable('abc'), []);
});

test('buildCatalog: erros claros', () => {
  assert.throws(() => buildCatalog({}), /schema ausente/);
  const raws = loadRaws();
  raws.advanced.sections[0].options.push(raws.general.sections[0].options[0]);   // 'locale' repetida
  assert.throws(() => buildCatalog(raws), /chave repetida/);
  const bad = loadRaws();
  bad.general.sections[0].options[0].ui = 'radio';
  assert.throws(() => buildCatalog(bad), /ui desconhecida/);
});

test('busca: casa com o começo da palavra ("porta" não acha "suporta")', () => {
  const keys = (q) => searchCatalog(catalog, q, 'windows').map((r) => r.opt.key);
  assert.ok(keys('porta').includes('port'));
  assert.ok(keys('porta').includes('upnp'));        // "portas" na ajuda
  assert.ok(!keys('porta').includes('qp'));         // "suportar" não conta
  assert.ok(keys('reso').includes('dd_resolution_option'));
  assert.doesNotThrow(() => searchCatalog(catalog, '[a-z]( .* \\ ^$ +?', 'windows'));   // caracteres especiais não quebram a expressão
  assert.deepEqual(keys('('), []);
});

test('plainDefault: tira "(padrão)" para não repetir "Padrão: … (padrão)"', () => {
  assert.equal(plainDefault('Desativado (padrão)'), 'Desativado');
  assert.equal(plainDefault('P1 (mais rápido, padrão)'), 'P1 (mais rápido)');
  assert.equal(plainDefault('ultralowlatency - baixa (mais rápido; padrão)'), 'ultralowlatency - baixa (mais rápido)');
  assert.equal(plainDefault('Informação'), 'Informação');
  assert.equal(defaultLabel(catalog.byKey.get('nvenc_preset'), 'windows'), 'P1 (mais rápido)');
});

test('padrão do R3D PLAY: a tela chama de padrão o que o main.js grava (ensure_primary), não o "disabled" do motor', () => {
  const o = catalog.byKey.get('dd_configuration_option');
  assert.equal(o.default, 'disabled');                      // padrão do motor, usado para ler chave ausente
  assert.equal(restoreValue(o), 'ensure_primary');
  assert.equal(defaultLabel(o, 'windows'), 'Ativar a tela automaticamente e torná-la a tela primária');
  assert.equal(restoreValue(catalog.byKey.get('upnp')), 'disabled');
  assert.equal(choicesFor(o, 'windows').find((c) => c.value === 'disabled').label, 'Desativado');   // não é mais "(padrão)"
});
