// Testes de ui/js/lib/pairing.js: validação do PIN, nomes, detecção de aparelho NOVO (correção do grantFull), frase-senha, link e fluxo completo
// de pareamento por PIN contra um servidor falso com relógio falso. Rodar: node --test tools/ApolloConfig/dev/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../../ui/js/lib/pairing.js';
import * as P from '../../ui/js/lib/perms.js';

/* ---------- PIN ---------- */
test('validatePin: 4 dígitos ASCII, espaços ignorados, zeros à esquerda preservados', () => {
  assert.deepEqual(K.validatePin('1234'), { ok: true, pin: '1234' });
  assert.deepEqual(K.validatePin(' 12 34 '), { ok: true, pin: '1234' });
  assert.deepEqual(K.validatePin('0000'), { ok: true, pin: '0000' });
  assert.deepEqual(K.validatePin('0042'), { ok: true, pin: '0042' });
  assert.deepEqual(K.validatePin(1234), { ok: true, pin: '1234' });
  for (const bad of ['', '   ', null, undefined, '123', '12345', 'abcd', '12a4', '12-4', '١٢٣٤', '１２３４', '1234\n5', '+123', '1.23', '0x12']) {
    const r = K.validatePin(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 10, 'mensagem útil em português');
  }
  assert.match(K.validatePin('').error, /Digite/);
  assert.match(K.validatePin('12').error, /exatamente 4/);
});

/* ---------- Nomes ---------- */
test('sanitizeDeviceName: parênteses viram colchetes, controle some, espaços normalizados, limite de tamanho', () => {
  assert.equal(K.sanitizeDeviceName('  Celular do João  '), 'Celular do João');
  assert.equal(K.sanitizeDeviceName('A51 (sala)'), 'A51 [sala]');
  assert.equal(K.sanitizeDeviceName('a\nb\r\nc\td'), 'a b c d');
  assert.equal(K.sanitizeDeviceName('a   b'), 'a b');
  assert.equal(K.sanitizeDeviceName('\u0000\u0007x\u007f'), 'x');
  assert.equal(K.sanitizeDeviceName(null), '');
  assert.equal(K.sanitizeDeviceName(undefined), '');
  assert.equal(K.sanitizeDeviceName(42), '42');
  const long = 'x'.repeat(100);
  assert.equal(K.sanitizeDeviceName(long).length, K.NAME_MAX);
  assert.equal(K.sanitizeDeviceName('ab ', 2), 'ab');
  // não corta um emoji (par substituto) ao meio
  const emo = '📱'.repeat(60);
  const cut = K.sanitizeDeviceName(emo);
  assert.equal([...cut].length, K.NAME_MAX);
  assert.ok(!/[\ud800-\udbff]$/.test(cut), 'sem metade de emoji no fim');
  assert.equal(K.sanitizeDeviceName('Pixel 8 (Maria) (2)'), 'Pixel 8 [Maria] [2]');
});

test('findDuplicateName', () => {
  const list = [{ uuid: 'a', name: 'Sala' }, { uuid: 'b', name: 'Quarto' }, { uuid: 'c' }, null];
  assert.equal(K.findDuplicateName(list, 'Sala', 'zzz').uuid, 'a');
  assert.equal(K.findDuplicateName(list, ' Sala ', 'zzz').uuid, 'a');
  assert.equal(K.findDuplicateName(list, 'Sala', 'a'), null, 'o próprio dispositivo não conta');
  assert.equal(K.findDuplicateName(list, 'Cozinha'), null);
  assert.equal(K.findDuplicateName(list, ''), null);
  assert.equal(K.findDuplicateName(null, 'x'), null);
});

/* ---------- Aparelhos novos ---------- */
test('uuidsOf aceita Set, lista de uuids e lista de dispositivos; ignora lixo', () => {
  assert.deepEqual([...K.uuidsOf([{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'a' }])], ['a', 'b']);
  assert.deepEqual([...K.uuidsOf(['a', 'b', ''])], ['a', 'b']);
  assert.deepEqual([...K.uuidsOf(new Set(['x', 'y']))], ['x', 'y']);
  assert.deepEqual([...K.uuidsOf([null, undefined, 5, {}, { uuid: 5 }, { uuid: '' }])], []);
  assert.deepEqual([...K.uuidsOf(null)], []);
  assert.deepEqual([...K.uuidsOf(undefined)], []);
  assert.deepEqual([...K.uuidsOf('texto')], [], 'string solta não é lista');
});

test('findNewUuids / decideNewDevices', () => {
  const before = [{ uuid: 'a' }, { uuid: 'b' }];
  assert.deepEqual(K.findNewUuids(before, [{ uuid: 'a' }, { uuid: 'b' }]), []);
  assert.deepEqual(K.findNewUuids(before, [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }]), ['c']);
  assert.deepEqual(K.findNewUuids(before, [{ uuid: 'c' }, { uuid: 'a' }, { uuid: 'd' }, { uuid: 'c' }]), ['c', 'd'], 'sem repetir, na ordem da lista');
  assert.deepEqual(K.findNewUuids([], [{ uuid: 'a' }]), ['a']);
  assert.deepEqual(K.findNewUuids(before, []), [], 'sumir da lista não gera novo');
  assert.deepEqual(K.findNewUuids(new Set(['a']), [{ uuid: 'a' }, { uuid: 'z' }]), ['z']);
  assert.deepEqual(K.decideNewDevices(before, before), { kind: 'none', uuids: [], uuid: null });
  assert.deepEqual(K.decideNewDevices(before, [...before, { uuid: 'c' }]), { kind: 'one', uuids: ['c'], uuid: 'c' });
  assert.deepEqual(K.decideNewDevices(before, [...before, { uuid: 'c' }, { uuid: 'd' }]), { kind: 'many', uuids: ['c', 'd'], uuid: null });
});

/* ---------- Servidor falso + relógio falso ---------- */
const DEFAULT = P.PERM_DEFAULT;
const FULL = P.PERM_ALL;
const dev = (uuid, perm, extra = {}) => ({ uuid, name: `Aparelho ${uuid}`, perm, ...extra });

/**
 * Monta um servidor falso. Os aparelhos de `appear` surgem `appearAfter` ms DEPOIS de o PIN ser enviado (como no celular de verdade:
 * o uuid novo só aparece quando o pareamento termina). `onPin(world)` pode mexer na lista no momento do PIN.
 */
function world({ initial, appearAfter = null, appear = [], pinAnswer = { ok: true, accepted: true }, listFails = [], setPermFail = null, setPermThrows = false, onPin = null } = {}) {
  let t = 0;
  let pinAt = null;
  const w = { t: () => t, setPermCalls: [], pinCalls: [], stages: [], listCount: 0, devices: initial.map((d) => ({ ...d })) };
  const view = () => {
    const list = w.devices.map((d) => ({ ...d }));
    if (appearAfter !== null && pinAt !== null && t >= pinAt + appearAfter) for (const a of appear) if (!list.some((d) => d.uuid === a.uuid)) list.push({ ...a });
    return list;
  };
  w.opts = {
    listClients: async () => {
      w.listCount++;
      if (listFails.includes(w.listCount)) return null;
      return view();
    },
    postPin: async (pin, name) => {
      w.pinCalls.push({ pin, name, listCountBefore: w.listCount });
      pinAt = t;
      onPin?.(w);
      return typeof pinAnswer === 'function' ? pinAnswer() : pinAnswer;
    },
    setPerm: async (uuid, mask) => {
      w.setPermCalls.push({ uuid, mask });
      if (setPermThrows) throw new Error('rede caiu');
      if (setPermFail) return { ok: false, error: setPermFail };
      return { ok: true };
    },
    sleep: async (ms) => { t += ms; },
    now: () => t,
    onStage: (s) => w.stages.push(s),
  };
  return w;
}

test('pareamento: promove SÓ o aparelho novo; os antigos com permissão padrão ficam como estão (correção do grantFull)', async () => {
  const antigoVer = dev('antigo-ver', DEFAULT);                       // alguém que foi "Apenas ver" de propósito
  const antigoJogar = dev('antigo-jogar', 117448448);
  const novo = dev('novo', DEFAULT, { name: 'Celular novo' });
  const w = world({ initial: [antigoVer, antigoJogar], appearAfter: 1200, appear: [novo] });
  const r = await K.pairByPin({ pin: '1234', name: 'João', mask: P.PERM_ALL, ...w.opts });
  assert.equal(r.status, 'paired');
  assert.equal(r.uuid, 'novo');
  assert.equal(r.applied, true);
  assert.equal(r.skipped, false);
  assert.deepEqual(w.setPermCalls, [{ uuid: 'novo', mask: P.PERM_ALL }], 'um único update, só no uuid novo');
  assert.ok(!w.setPermCalls.some((c) => c.uuid.startsWith('antigo')), 'ninguém antigo foi promovido');
  assert.deepEqual(w.pinCalls, [{ pin: '1234', name: 'João', listCountBefore: 1 }], 'o retrato foi tirado ANTES de enviar o PIN');
  assert.deepEqual(w.stages.slice(0, 3), ['snapshot', 'sending', 'waiting']);
  assert.equal(w.stages.at(-1), 'applying');
  assert.ok(w.t() >= 1200 && w.t() < 2000, `achou logo que apareceu (${w.t()} ms)`);
});

test('pareamento: respeita o modelo escolhido (não é sempre controle total)', async () => {
  const w = world({ initial: [dev('a', FULL)], appearAfter: 0, appear: [dev('n', DEFAULT)] });
  const jogar = P.presetById('jogar').mask;
  const r = await K.pairByPin({ pin: '1111', mask: jogar, ...w.opts });
  assert.equal(r.status, 'paired');
  assert.deepEqual(w.setPermCalls, [{ uuid: 'n', mask: jogar }]);
});

test('pareamento: a máscara pedida é normalizada antes de gravar', async () => {
  const w = world({ initial: [], appearAfter: 0, appear: [dev('n', 0)] });
  await K.pairByPin({ pin: '1111', mask: P.permByName('launch').bit, ...w.opts });
  assert.deepEqual(w.setPermCalls, [{ uuid: 'n', mask: P.normalizeMask(P.permByName('launch').bit) }]);
});

test('pareamento: primeiro aparelho já nasce com tudo => não precisa gravar nada', async () => {
  const w = world({ initial: [], appearAfter: 500, appear: [dev('primeiro', FULL)] });
  const r = await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts });
  assert.equal(r.status, 'paired');
  assert.equal(r.skipped, true);
  assert.equal(r.applied, false);
  assert.deepEqual(w.setPermCalls, []);
});

test('pareamento: primeiro aparelho (nasce com tudo) mas o usuário pediu menos => rebaixa só ele', async () => {
  const w = world({ initial: [], appearAfter: 0, appear: [dev('primeiro', FULL)] });
  const r = await K.pairByPin({ pin: '1234', mask: P.presetById('apenas_ver').mask, ...w.opts });
  assert.equal(r.status, 'paired');
  assert.deepEqual(w.setPermCalls, [{ uuid: 'primeiro', mask: DEFAULT }]);
});

test('pareamento: sem modelo pedido (mask indefinida) não grava nada', async () => {
  const w = world({ initial: [], appearAfter: 0, appear: [dev('n', DEFAULT)] });
  const r = await K.pairByPin({ pin: '1234', ...w.opts });
  assert.equal(r.status, 'paired');
  assert.equal(r.skipped, true);
  assert.deepEqual(w.setPermCalls, []);
});

test('pareamento: PIN recusado pelo servidor => "rejected", sem espera nem gravação', async () => {
  const w = world({ initial: [dev('a', DEFAULT)], pinAnswer: { ok: true, accepted: false } });
  const r = await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts });
  assert.deepEqual(r, { status: 'rejected' });
  assert.equal(w.listCount, 1, 'só o retrato inicial');
  assert.deepEqual(w.setPermCalls, []);
});

test('pareamento: sem conseguir o retrato inicial, o PIN NÃO é enviado', async () => {
  const w = world({ initial: [], listFails: [1] });
  const r = await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts });
  assert.deepEqual(r, { status: 'snapshot_failed' });
  assert.equal(w.pinCalls.length, 0);
});

test('pareamento: servidor fora do ar / erro ao enviar o PIN', async () => {
  let w = world({ initial: [], pinAnswer: { ok: false, offline: true } });
  assert.deepEqual(await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts }), { status: 'offline', error: '' });
  w = world({ initial: [], pinAnswer: { ok: false, error: 'HTTP 500' } });
  assert.deepEqual(await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts }), { status: 'pin_error', error: 'HTTP 500' });
  w = world({ initial: [], pinAnswer: () => null });
  assert.equal((await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts })).status, 'pin_error');
  assert.deepEqual(w.setPermCalls, []);
});

test('pareamento: ninguém novo no prazo => "unclear" (não é erro) e NINGUÉM é promovido, mesmo havendo aparelho com permissão padrão', async () => {
  // Cenário do bug antigo: o celular já constava na lista (re-pareamento) com a permissão padrão.
  const w = world({ initial: [dev('ja-estava', DEFAULT)] });
  const r = await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts, timeoutMs: 8000, intervalMs: 500 });
  assert.deepEqual(r, { status: 'unclear' });
  assert.deepEqual(w.setPermCalls, [], 'nada de promover quem já existia');
  assert.ok(w.t() >= 8000 && w.t() <= 8500, `esperou ~8 s (esperou ${w.t()} ms)`);
  assert.ok(w.listCount >= 16 && w.listCount <= 19, `consultou a lista ~a cada 0,5 s (${w.listCount} vezes)`);
});

test('pareamento: aparelho que chega depois do prazo não é promovido por este fluxo', async () => {
  const w = world({ initial: [], appearAfter: 9000, appear: [dev('tarde', DEFAULT)] });
  const r = await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts });
  assert.equal(r.status, 'unclear');
  assert.deepEqual(w.setPermCalls, []);
});

test('pareamento: dois aparelhos novos de uma vez => "ambiguous", ninguém é promovido', async () => {
  const w = world({ initial: [dev('a', DEFAULT)], appearAfter: 300, appear: [dev('n1', DEFAULT), dev('n2', DEFAULT)] });
  const r = await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts });
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.uuids, ['n1', 'n2']);
  assert.deepEqual(w.setPermCalls, []);
});

test('pareamento: uma leitura da lista falha no meio, mas o pareamento continua e conclui', async () => {
  const w = world({ initial: [], appearAfter: 1000, appear: [dev('n', DEFAULT)], listFails: [2, 3, 4] });
  const r = await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts });
  assert.equal(r.status, 'paired');
  assert.deepEqual(w.setPermCalls, [{ uuid: 'n', mask: FULL }]);
});

test('pareamento: se TODAS as leituras depois do PIN falham, termina como "unclear" (sem travar)', async () => {
  let n = 0;
  const w = world({ initial: [dev('a', DEFAULT)] });
  w.opts.listClients = async () => (++n === 1 ? [dev('a', DEFAULT)] : null);
  const r = await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts });
  assert.equal(r.status, 'unclear');
  assert.deepEqual(w.setPermCalls, []);
});

test('pareamento: falha ao gravar o modelo => pareado, mas "applied: false" com o motivo', async () => {
  let w = world({ initial: [], appearAfter: 0, appear: [dev('n', DEFAULT)], setPermFail: 'O R3D PLAY não está respondendo.' });
  let r = await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts });
  assert.equal(r.status, 'paired');
  assert.equal(r.applied, false);
  assert.equal(r.skipped, false);
  assert.equal(r.error, 'O R3D PLAY não está respondendo.');
  w = world({ initial: [], appearAfter: 0, appear: [dev('n', DEFAULT)], setPermThrows: true });
  r = await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts });
  assert.equal(r.status, 'paired');
  assert.equal(r.applied, false);
  assert.match(r.error, /rede caiu/);
});

test('pareamento: aparelho antigo removido + aparelho novo ao mesmo tempo => acha o novo e não mexe em mais ninguém', async () => {
  const w = world({ initial: [dev('velho', DEFAULT), dev('fica', DEFAULT)], appearAfter: 0, appear: [dev('novo', DEFAULT)], onPin: (x) => { x.devices = x.devices.filter((d) => d.uuid !== 'velho'); } });
  const r = await K.pairByPin({ pin: '1234', mask: FULL, ...w.opts });
  assert.equal(r.status, 'paired');
  assert.equal(r.uuid, 'novo');
  assert.deepEqual(w.setPermCalls, [{ uuid: 'novo', mask: FULL }]);
});

test('promoteNewDevice: caminhos diretos', async () => {
  const set = [];
  const setPerm = async (u, m) => { set.push([u, m]); return { ok: true }; };
  const before = new Set(['a']);
  assert.deepEqual(await K.promoteNewDevice({ before, list: [dev('a', DEFAULT)], mask: FULL, setPerm }), { status: 'none' });
  const one = await K.promoteNewDevice({ before, list: [dev('a', DEFAULT), dev('b', DEFAULT)], mask: FULL, setPerm });
  assert.equal(one.status, 'paired');
  assert.deepEqual(set, [['b', FULL]]);
  assert.equal((await K.promoteNewDevice({ before, list: [dev('b', DEFAULT), dev('c', DEFAULT)], mask: FULL, setPerm })).status, 'ambiguous');
  assert.equal(set.length, 1);
});

/* ---------- Frase-senha ---------- */
test('generatePassphrase: 8 caracteres [0-9a-zA-Z], válida para o servidor', () => {
  for (let i = 0; i < 200; i++) {
    const s = K.generatePassphrase();
    assert.match(s, /^[0-9a-zA-Z]{8}$/);
    assert.ok(K.isValidPassphrase(s));
  }
  assert.notEqual(K.generatePassphrase(), K.generatePassphrase(), 'não se repete (chance de colisão desprezível)');
  assert.equal(K.generatePassphrase(4).length, 4);
  assert.equal(K.generatePassphrase(64).length, 64);
});

test('generatePassphrase: usa o gerador indicado e cobre o alfabeto inteiro', () => {
  const calls = [];
  const seq = [0, 9, 10, 35, 36, 61, 5, 6];
  const s = K.generatePassphrase(8, (max) => { calls.push(max); return seq[calls.length - 1]; });
  assert.deepEqual(calls, new Array(8).fill(62));
  // 0, 9, a(10), z(35), A(36), Z(61), 5, 6
  assert.equal(s, '09azAZ56');
  const all = K.generatePassphrase(62, (() => { let i = 0; return () => i++; })());
  assert.equal(all, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
});

test('generatePassphrase: tamanhos inválidos', () => {
  for (const bad of [0, 1, 3, 65, -1, 8.5, NaN, '8']) assert.throws(() => K.generatePassphrase(bad), RangeError, String(bad));
});

test('secureRandomInt: intervalo, uniformidade aproximada e erros', () => {
  const counts = new Array(62).fill(0);
  const N = 62 * 400;
  for (let i = 0; i < N; i++) {
    const v = K.secureRandomInt(62);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 62);
    counts[v]++;
  }
  const exp = N / 62;
  const chi = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
  assert.ok(chi < 130, `qui-quadrado ${chi.toFixed(1)} (61 graus de liberdade; limite folgado)`);
  assert.equal(K.secureRandomInt(1), 0);
  for (const bad of [0, -1, 257, 1.5, NaN]) assert.throws(() => K.secureRandomInt(bad), RangeError);
});

test('secureRandomInt: sem gerador seguro, falha em vez de usar Math.random', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try { assert.throws(() => K.secureRandomInt(62), /gerador seguro/); } finally { Object.defineProperty(globalThis, 'crypto', saved); }
});

test('isValidPassphrase', () => {
  for (const ok of ['abcd', 'A1b2C3d4', '00000000']) assert.ok(K.isValidPassphrase(ok));
  for (const bad of ['abc', '', 'ab cd', 'abc-def', 'ação1234', null, undefined]) assert.ok(!K.isValidPassphrase(bad), String(bad));
});

/* ---------- Endereço e link ---------- */
test('isValidHost / isValidPort', () => {
  for (const ok of ['192.168.0.10', '10.0.0.1', '255.255.255.255', '0.0.0.0', 'MNBF-NEON', 'pc.local', 'meu-pc.tail1234.ts.net', 'a', '[::1]', '::1', 'fe80::1', '2001:db8::ff00:42:8329', '[2001:db8::1]']) assert.ok(K.isValidHost(ok), ok);
  for (const bad of ['', '  ', null, undefined, '256.1.1.1', '1.2.3', '1.2.3.4.5', '999.999.999.999', 'a b', 'http://x', 'x/y', 'x?y', 'x#y', '-pc', 'pc-', 'pc..local', '.pc', 'pc_1', ':', '[::1', '::1]', 'g::1', 'a'.repeat(254), 'pc:47989', '1.2.3.4:80']) assert.ok(!K.isValidHost(bad), JSON.stringify(bad));
  for (const ok of [1, 80, '47989', 65535, ' 443 ']) assert.ok(K.isValidPort(ok), String(ok));
  for (const bad of [0, 65536, -1, 1.5, '1.5', 'abc', '', null, undefined, '１２３', '99999', '0x50']) assert.ok(!K.isValidPort(bad), String(bad));
});

test('buildPairLink: formato art://host:porta?pin=..&passphrase=..&name=..', () => {
  const r = K.buildPairLink({ host: '192.168.0.10', port: 47989, otp: '4821', passphrase: 'aB3dE9xZ', name: 'MNBF-NEON' });
  assert.deepEqual(r, { ok: true, link: 'art://192.168.0.10:47989?pin=4821&passphrase=aB3dE9xZ&name=MNBF-NEON' });
  assert.equal(K.buildPairLink({ host: '10.0.0.2', port: '47989', otp: '0007', passphrase: 'abcd1234', name: '' }).link, 'art://10.0.0.2:47989?pin=0007&passphrase=abcd1234', 'sem nome, sem &name=');
  assert.equal(K.buildPairLink({ host: '10.0.0.2', port: '47989', otp: '0007', passphrase: 'abcd1234' }).link, 'art://10.0.0.2:47989?pin=0007&passphrase=abcd1234');
  assert.equal(K.buildPairLink({ host: '::1', port: 47989, otp: '1111', passphrase: 'abcd' }).link, 'art://[::1]:47989?pin=1111&passphrase=abcd', 'IPv6 ganha colchetes');
  assert.equal(K.buildPairLink({ host: '[fe80::1]', port: 47989, otp: '1111', passphrase: 'abcd' }).link, 'art://[fe80::1]:47989?pin=1111&passphrase=abcd');
  assert.equal(K.buildPairLink({ host: ' 192.168.0.10 ', port: ' 47989 ', otp: '1111', passphrase: 'abcd' }).link, 'art://192.168.0.10:47989?pin=1111&passphrase=abcd');
});

test('buildPairLink: o nome é codificado por valor (acentos, espaço, & # = + ?)', () => {
  const name = 'PC da Sala & Quarto #1 = ok+? ção';
  const r = K.buildPairLink({ host: '192.168.0.10', port: 47989, otp: '1234', passphrase: 'abcd1234', name });
  assert.ok(r.ok);
  const u = new URL(r.link.replace('art://', 'http://'));
  assert.equal(u.searchParams.get('pin'), '1234');
  assert.equal(u.searchParams.get('passphrase'), 'abcd1234');
  assert.equal(u.searchParams.get('name'), name, 'o nome volta idêntico depois de decodificar');
  assert.equal([...u.searchParams.keys()].length, 3, 'o & do nome não cria parâmetro extra');
  assert.ok(!/[ #]/.test(r.link), 'sem espaço nem # soltos');
});

test('buildPairLink: entradas inválidas devolvem {ok:false, error em português}', () => {
  const base = { host: '192.168.0.10', port: 47989, otp: '1234', passphrase: 'abcd1234', name: 'x' };
  for (const [patch, re] of [
    [{ host: '' }, /Endereço/], [{ host: 'a b' }, /Endereço/], [{ host: 'http://x' }, /Endereço/],
    [{ port: 0 }, /Porta/], [{ port: 'abc' }, /Porta/], [{ port: 70000 }, /Porta/],
    [{ otp: '12' }, /OTP/], [{ otp: 'abcd' }, /OTP/], [{ otp: 1234 }, null], [{ otp: undefined }, /OTP/],
    [{ passphrase: 'abc' }, /Frase/], [{ passphrase: 'ab cd1234' }, /Frase/],
  ]) {
    const r = K.buildPairLink({ ...base, ...patch });
    if (re === null) { assert.ok(r.ok, 'número 1234 vira "1234"'); continue; }
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.error, re);
  }
});

test('pairPortFromUrl: porta do painel menos 1', () => {
  assert.equal(K.pairPortFromUrl('https://localhost:47990'), 47989);
  assert.equal(K.pairPortFromUrl('https://localhost:48000/algo'), 47999);
  assert.equal(K.pairPortFromUrl('https://127.0.0.1:50000'), 49999);
  for (const bad of ['', null, undefined, 'não é url', 'https://localhost', 'http://x:1', 'https://x:0']) assert.equal(K.pairPortFromUrl(bad), K.DEFAULT_PAIR_PORT, String(bad));
});

test('hostCandidates: ordem Wi-Fi > rede local > Tailscale > VPN; sugestão do servidor; sem lixo', () => {
  const ips = [
    { name: 'Tailscale', ip: '100.64.1.2', kind: 'tailscale' },
    { name: 'Ethernet', ip: '192.168.1.20', kind: 'lan' },
    { name: 'Wi-Fi', ip: '192.168.0.10', kind: 'wifi' },
    { name: 'VPN', ip: '10.8.0.2', kind: 'vpn' },
    { name: 'dup', ip: '192.168.0.10', kind: 'lan' },
    { name: 'link-local', ip: '169.254.9.9', kind: 'lan' },
    { name: 'ruim', ip: 'não é ip', kind: 'lan' },
    null, { ip: 5 },
  ];
  const c = K.hostCandidates(ips, '192.168.1.20');
  assert.deepEqual(c.map((x) => x.ip), ['192.168.0.10', '192.168.1.20', '100.64.1.2', '10.8.0.2']);
  assert.deepEqual(c.map((x) => x.kind), ['wifi', 'lan', 'tailscale', 'vpn']);
  assert.deepEqual(c.map((x) => x.recommended), [false, true, false, false], 'a sugestão do servidor (rede local) é a recomendada');
  assert.ok(c.every((x) => typeof x.label === 'string' && x.label));
  // sugestão do servidor numa rede de VPN não é recomendada: vale a primeira boa
  const v = K.hostCandidates(ips, '100.64.1.2');
  assert.equal(v.find((x) => x.recommended).ip, '192.168.0.10');
  // sugestão desconhecida entra na lista
  const extra = K.hostCandidates([{ ip: '192.168.0.10', kind: 'wifi' }], '172.16.0.5');
  assert.deepEqual(extra.map((x) => x.ip), ['192.168.0.10', '172.16.0.5']);
  assert.equal(extra[1].kind, 'api');
  assert.deepEqual(extra.map((x) => x.recommended), [true, false], 'sugestão que o app nativo não listou não passa na frente de uma placa real');
  // sem nada
  assert.deepEqual(K.hostCandidates([], ''), []);
  assert.deepEqual(K.hostCandidates(undefined, undefined), []);
  assert.deepEqual(K.hostCandidates(null, '192.168.0.9').map((x) => [x.ip, x.recommended]), [['192.168.0.9', true]]);
});

/* ---------- Validade do OTP ---------- */
test('otpSecondsLeft / formatCountdown', () => {
  const t0 = 1_000_000;
  assert.equal(K.otpSecondsLeft(t0, t0), 180);
  assert.equal(K.otpSecondsLeft(t0, t0 + 1), 180, 'arredonda para cima');
  assert.equal(K.otpSecondsLeft(t0, t0 + 1000), 179);
  assert.equal(K.otpSecondsLeft(t0, t0 + 179_999), 1);
  assert.equal(K.otpSecondsLeft(t0, t0 + 180_000), 0);
  assert.equal(K.otpSecondsLeft(t0, t0 + 999_999), 0, 'nunca negativo');
  assert.equal(K.otpSecondsLeft(t0, t0 - 5000), 180, 'relógio voltou: não passa de 180');
  assert.equal(K.otpSecondsLeft(NaN, t0), 0);
  assert.equal(K.otpSecondsLeft(t0, NaN), 0);
  assert.equal(K.otpSecondsLeft(t0, t0, 60), 60);
  assert.equal(K.formatCountdown(180), '3:00');
  assert.equal(K.formatCountdown(125), '2:05');
  assert.equal(K.formatCountdown(59), '0:59');
  assert.equal(K.formatCountdown(1), '0:01');
  assert.equal(K.formatCountdown(0), '0:00');
  assert.equal(K.formatCountdown(-5), '0:00');
  assert.equal(K.formatCountdown(NaN), '0:00');
  assert.equal(K.formatCountdown(61.9), '1:01');
  assert.equal(K.OTP_TTL_SECONDS, 180);
});
