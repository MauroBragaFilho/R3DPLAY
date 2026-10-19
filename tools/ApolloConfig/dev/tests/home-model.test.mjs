// Testes do modelo da tela Início: estado do cartão principal, endereços IP, driver de tela virtual e resumo (ui/js/lib/stats.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  heroState, vdisplayWarning, VDISPLAY_HELP, isUsableIpv4, classifyIp, normalizeIps, ipsHint, summarizeClients, summaryTiles,
  isShareLibraryOn, statsFailure, STATS_RETRY_MS, STATS_BLOCKED_RETRY_MS,
} from '../../ui/js/lib/stats.js';

const APPS = [{ name: 'Desktop', uuid: 'A' }, { name: 'Dark Souls', uuid: 'B' }];

test('heroState: servidor desligado, carregando e reiniciando', () => {
  assert.equal(heroState({ loaded: false, online: false }).kind, 'loading');
  assert.equal(heroState({ loaded: true, online: false }).kind, 'offline');
  assert.equal(heroState({ loaded: true, online: false, restarting: true }).kind, 'restarting');
  assert.equal(heroState({ loaded: false, online: true }).kind, 'ready', 'já sabemos que está online: não precisa esperar');
  assert.equal(heroState({ online: true, restarting: true, currentApp: 'B', apps: APPS }).kind, 'restarting', 'reiniciar vence tudo');
  assert.equal(heroState().kind, 'offline', 'sem parâmetros: padrão seguro');
});

test('heroState: transmissão em andamento mostra o jogo (ou nada se sumiu da lista)', () => {
  assert.deepEqual(heroState({ online: true, currentApp: 'B', apps: APPS }), { kind: 'streaming', game: 'Dark Souls' });
  assert.deepEqual(heroState({ online: true, currentApp: 'Z', apps: APPS }), { kind: 'streaming', game: '' });
  assert.deepEqual(heroState({ online: true, currentApp: 'B', apps: null }), { kind: 'streaming', game: '' });
  assert.deepEqual(heroState({ online: true, currentApp: 'B', apps: [null, { name: 5 }] }), { kind: 'streaming', game: '' });
});

test('heroState: pronto, com e sem dispositivo, e atenção por causa do driver', () => {
  assert.deepEqual(heroState({ online: true, apps: APPS, deviceCount: 2 }), { kind: 'ready', needsDevice: false });
  assert.deepEqual(heroState({ online: true, apps: APPS, deviceCount: 0 }), { kind: 'ready', needsDevice: true });
  assert.deepEqual(heroState({ online: true, apps: APPS, deviceCount: null }), { kind: 'ready', needsDevice: false }, 'desconhecido não é "zero"');
  assert.equal(heroState({ online: true, vdisplayProblem: true }).kind, 'attention');
  assert.equal(heroState({ online: true, vdisplayProblem: true, currentApp: 'A', apps: APPS }).kind, 'streaming', 'transmitindo tem prioridade sobre o aviso');
});

test('vdisplayWarning: pronto, ausente e cada problema conhecido', () => {
  assert.equal(vdisplayWarning(0), null);
  assert.equal(vdisplayWarning('0'), null);
  assert.equal(vdisplayWarning(undefined), null, 'Windows only: ausente não alarma');
  assert.equal(vdisplayWarning(null), null);
  assert.equal(vdisplayWarning(''), null);
  assert.equal(vdisplayWarning(true), null);
  assert.equal(vdisplayWarning('abc'), null);
  assert.equal(vdisplayWarning(-1).label, 'Ainda não iniciou');
  assert.equal(vdisplayWarning(-2).label, 'Versão incompatível');
  assert.equal(vdisplayWarning(-3).label, 'Parou de responder');
  assert.equal(vdisplayWarning(1).label, 'Não foi possível verificar');
  assert.equal(vdisplayWarning('1').label, 'Não foi possível verificar', 'o original usa a string "1" enquanto carrega');
  assert.equal(vdisplayWarning(-99).label, 'Não foi possível verificar', 'código novo do servidor: ainda avisa');
  // sem jargão do servidor ("watchdog", "inicializado") nos textos que a pessoa lê
  for (const c of [1, -1, -2, -3, -99]) assert.doesNotMatch(vdisplayWarning(c).label, /watchdog|desconhecido|inicializ/i, String(c));
  assert.equal(vdisplayWarning(-1).help, VDISPLAY_HELP);
  assert.match(VDISPLAY_HELP, /SudoVDA/);
});

test('isUsableIpv4: só endereços que servem para conectar', () => {
  for (const ok of ['192.168.0.10', '10.0.0.2', '100.126.122.60', '26.177.83.160', ' 172.16.0.5 ']) assert.equal(isUsableIpv4(ok), true, ok);
  for (const bad of ['', null, undefined, 5, '127.0.0.1', '0.0.0.0', '169.254.10.1', '256.1.1.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', 'fe80::1', '192.168.0.1/24']) assert.equal(isUsableIpv4(bad), false, String(bad));
});

test('classifyIp: faixa e nome valem mais que o kind do app', () => {
  assert.equal(classifyIp({ ip: '192.168.0.4', kind: 'wifi', name: 'Wi-Fi' }), 'wifi');
  assert.equal(classifyIp({ ip: '192.168.0.2', kind: 'lan', name: 'Ethernet' }), 'lan');
  assert.equal(classifyIp({ ip: '100.126.122.60', kind: 'lan', name: 'Tailscale' }), 'tailscale');
  assert.equal(classifyIp({ ip: '100.64.0.1', kind: 'lan', name: 'X' }), 'tailscale');
  assert.equal(classifyIp({ ip: '100.128.0.1', kind: 'lan', name: 'X' }), 'lan', 'fora da faixa 100.64–127');
  assert.equal(classifyIp({ ip: '100.63.0.1', kind: 'lan', name: 'X' }), 'lan');
  assert.equal(classifyIp({ ip: '26.177.83.160', kind: 'lan', name: 'Radmin VPN' }), 'vpn');
  assert.equal(classifyIp({ ip: '10.5.0.2', kind: 'lan', name: 'Minha VPN' }), 'vpn');
  assert.equal(classifyIp({ ip: '10.0.0.2', kind: 'estranho', name: 'Rede' }), 'lan', 'kind desconhecido cai em cabo');
  assert.equal(classifyIp({ ip: '10.0.0.2' }), 'lan');
  assert.equal(classifyIp(), 'lan');
});

test('normalizeIps: ordem Wi-Fi, cabo, Tailscale, VPN; sem repetidos nem inválidos', () => {
  const info = {
    host: 'PC',
    ips: [
      { name: 'Radmin VPN', ip: '26.177.83.160', kind: 'lan' },
      { name: 'Tailscale', ip: '100.126.122.60', kind: 'lan' },
      { name: 'Ethernet', ip: '192.168.100.2', kind: 'lan' },
      { name: 'Wi-Fi', ip: '192.168.100.4', kind: 'wifi' },
      { name: 'Wi-Fi 2', ip: '192.168.100.4', kind: 'wifi' },   // repetido
      { name: 'Loopback', ip: '127.0.0.1', kind: 'lan' },
      { name: 'Auto', ip: '169.254.1.1', kind: 'lan' },
      null,
      { ip: 'xyz' },
    ],
  };
  const out = normalizeIps(info);
  assert.deepEqual(out.map((x) => x.ip), ['192.168.100.4', '192.168.100.2', '100.126.122.60', '26.177.83.160']);
  assert.deepEqual(out.map((x) => x.kind), ['wifi', 'lan', 'tailscale', 'vpn']);
  assert.deepEqual(out.map((x) => x.label), ['Wi-Fi', 'Cabo', 'Tailscale (fora de casa)', 'VPN']);
});

test('normalizeIps: entradas ruins viram lista vazia', () => {
  for (const bad of [null, undefined, {}, { ips: null }, { ips: 'x' }, { ips: [] }, 5, []]) assert.deepEqual(normalizeIps(bad), []);
});

test('normalizeIps: mantém a ordem original entre endereços do mesmo tipo', () => {
  const out = normalizeIps({ ips: [{ ip: '10.0.0.5', kind: 'lan', name: 'A' }, { ip: '10.0.0.6', kind: 'lan', name: 'B' }, { ip: '10.0.0.4', kind: 'wifi', name: 'C' }] });
  assert.deepEqual(out.map((x) => x.ip), ['10.0.0.4', '10.0.0.5', '10.0.0.6']);
});

test('ipsHint: orienta conforme os tipos encontrados', () => {
  assert.equal(ipsHint([]), '');
  assert.equal(ipsHint(null), '');
  assert.equal(ipsHint([{ kind: 'wifi' }, { kind: 'lan' }]), '');
  assert.match(ipsHint([{ kind: 'tailscale' }, { kind: 'vpn' }]), /Só encontrei endereços de Tailscale ou VPN/);
  assert.match(ipsHint([{ kind: 'wifi' }, { kind: 'tailscale' }]), /Em casa, use o endereço de Wi-Fi ou Cabo/);
});

test('summarizeClients: conta pareados e conectados', () => {
  assert.deepEqual(summarizeClients({ status: true, named_certs: [{ connected: true }, { connected: false }, { name: 'sem campo' }] }), { total: 3, connected: 1 });
  assert.deepEqual(summarizeClients({ named_certs: [] }), { total: 0, connected: 0 });
  assert.deepEqual(summarizeClients({ named_certs: [null, 'x', { connected: 'true' }] }), { total: 1, connected: 0 }, 'só true de verdade conta como conectado');
  for (const bad of [null, undefined, {}, { named_certs: null }, { named_certs: 'x' }, [], 'texto', 5]) assert.equal(summarizeClients(bad), null);
});

test('summaryTiles: servidor no ar', () => {
  const t = summaryTiles({ online: true, appsCount: 12, streaming: false, clients: { status: 'ok', total: 2, connected: 1 } });
  assert.deepEqual(t.map((x) => x.id), ['games', 'devices', 'streams']);
  assert.deepEqual(t.map((x) => x.tab), ['games', 'devices', 'games']);
  assert.deepEqual(t.map((x) => x.value), ['12', '2', '0']);
  assert.equal(t[1].sub, '1 conectado agora');
  assert.equal(t[2].sub, 'nenhuma agora');
});

test('summaryTiles: textos de cada situação', () => {
  const dev = (clients, extra = {}) => summaryTiles({ online: true, appsCount: 1, clients, ...extra })[1];
  assert.equal(dev({ status: 'ok', total: 0, connected: 0 }).sub, 'nenhum celular pareado');
  assert.equal(dev({ status: 'ok', total: 3, connected: 0 }).sub, 'nenhum conectado agora');
  assert.equal(dev({ status: 'ok', total: 3, connected: 3 }).sub, '3 conectados agora');
  assert.deepEqual([dev({ status: 'loading' }).value, dev({ status: 'loading' }).sub], ['…', 'verificando']);
  assert.deepEqual([dev({ status: 'error' }).value, dev({ status: 'error' }).sub], ['–', 'não foi possível ler']);
  assert.equal(dev(null).value, '…', 'sem informação ainda: carregando');
  assert.equal(summaryTiles({ online: true, appsCount: 0 })[0].sub, 'nenhum na lista');
  const live = summaryTiles({ online: true, appsCount: 4, streaming: true })[2];
  assert.deepEqual([live.value, live.sub], ['1', 'em andamento']);
});

test('summaryTiles: sem servidor mostra traços, nunca zeros', () => {
  const t = summaryTiles({ online: false, appsCount: 9, streaming: true, clients: { status: 'ok', total: 5, connected: 5 } });
  assert.deepEqual(t.map((x) => x.value), ['–', '–', '–']);
  assert.ok(t.every((x) => x.sub === 'sem conexão'));
});

test('summaryTiles: contagem de jogos inválida não quebra', () => {
  assert.equal(summaryTiles({ online: true, appsCount: -3 })[0].value, '0');
  assert.equal(summaryTiles({ online: true, appsCount: 'abc' })[0].value, '0');
  assert.equal(summaryTiles({ online: true, appsCount: 2.7 })[0].value, '2');
  assert.equal(summaryTiles()[0].value, '–');
});

test('isShareLibraryOn: só "desligado" de verdade desliga; ausente ou estranho conta como ligado', () => {
  for (const off of ['disabled', 'DISABLED', ' disabled ', 'false', 'no', 'off', '0']) assert.equal(isShareLibraryOn(off), false, off);
  for (const on of ['enabled', 'true', 'yes', 'on', '1', '', undefined, null, 0, false, 'talvez']) assert.equal(isShareLibraryOn(on), true, String(on));
});

test('statsFailure: servidor desligado explica e tenta a cada 3 s', () => {
  const f = statsFailure({ error: 'HTTP 0', shareLibrary: true, online: false });
  assert.equal(f.kind, 'offline');
  assert.equal(f.retryMs, STATS_RETRY_MS);
  assert.match(f.message, /desligado/);
  assert.equal(statsFailure({ error: 'HTTP 403', shareLibrary: false, online: false }).kind, 'offline', 'sem servidor, o motivo é este');
});

test('statsFailure: 403 = opção "Compartilhar biblioteca" desligada → mensagem específica e tentativa espaçada', () => {
  // texto real da ponte nativa (HttpClient) e do servidor de testes
  for (const error of ['Response status code does not indicate success: 403 (Forbidden).', 'HTTP 403']) {
    const f = statsFailure({ error, shareLibrary: true, online: true });
    assert.equal(f.kind, 'blocked', error);
    assert.equal(f.retryMs, STATS_BLOCKED_RETRY_MS);
    assert.match(f.message, /Compartilhar biblioteca de jogos/);
    assert.match(f.message, /reinicie/i);
    assert.doesNotMatch(f.message, /tenta de novo sozinha/, 'não promete uma leitura que não vai funcionar');
  }
  assert.ok(STATS_BLOCKED_RETRY_MS >= 10 * STATS_RETRY_MS, 'bem mais espaçado que o normal');
  assert.ok(STATS_RETRY_MS >= 3000, 'contrato: nunca menos de 3 s');
});

test('statsFailure: opção desligada na configuração desempata erros que não são de rede', () => {
  assert.equal(statsFailure({ error: '', shareLibrary: false }).kind, 'blocked');
  assert.equal(statsFailure({ error: 'resposta inválida', shareLibrary: false }).kind, 'blocked');
  assert.equal(statsFailure({ error: 'sem resposta', shareLibrary: false }).kind, 'blocked');
  // servidor lento ou recusando conexão não é "bloqueio", mesmo com a opção desligada
  for (const error of ['HTTP 0', 'A task was canceled: timed out', 'No connection could be made because the target machine actively refused it', 'tempo esgotado']) {
    assert.equal(statsFailure({ error, shareLibrary: false }).kind, 'unavailable', error);
  }
});

test('statsFailure: falha comum continua "indisponível" e nunca lança', () => {
  const f = statsFailure({ error: 'HTTP 500', shareLibrary: true });
  assert.equal(f.kind, 'unavailable');
  assert.equal(f.retryMs, STATS_RETRY_MS);
  assert.match(f.message, /Não consegui ler o uso do PC/);
  assert.equal(statsFailure().kind, 'unavailable', 'sem parâmetros');
  assert.equal(statsFailure({ error: null }).kind, 'unavailable');
  assert.equal(statsFailure({ error: 4030 }).kind, 'unavailable', '4030 não é 403');
  assert.equal(statsFailure({ error: new Error('HTTP 403') }).kind, 'blocked', 'aceita objeto de erro');
});
