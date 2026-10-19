// Teste de ponta a ponta da detecção de jogos contra um servidor falso em memória (sem DOM, sem rede):
// o core.js conversa com window.chrome.webview, que aqui é uma ponte de mentira que imita /api/apps*, scan, cover e readCover.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* ---------- Ponte e armazenamento falsos (antes de importar o core) ---------- */
const server = {
  apps: [], current: '', offline: false, log: [], covers: new Map(), failUpload: false, failPost: false,
  scan: [], coverData: {}, coverAsked: [], posts: 0, afterGet: null,
};
let listener = null;
const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
const reply = (m, extra) => ({ id: m.id, ...extra });
function handleApi(m) {
  if (server.offline) return { status: 0, body: 'sem conexão' };
  const body = m.body ? JSON.parse(m.body) : {};
  const ok = (extra = {}) => ({ status: 200, body: JSON.stringify({ status: true, ...extra }) });
  const bad = (error) => ({ status: 400, body: JSON.stringify({ status: false, error }) });
  server.log.push(`${m.method} ${m.path}`);
  if (m.method === 'GET' && m.path === '/api/apps') {
    const body = JSON.stringify({ version: 2, env: {}, apps: server.apps, current_app: server.current, host_uuid: 'H', host_name: 'PC' });
    const hook = server.afterGet; server.afterGet = null; hook?.();   // gancho de uma vez só: algo acontece logo depois desta leitura
    return { status: 200, body };
  }
  switch (m.path) {
    case '/api/apps': {
      if (server.failPost) return bad('Failed to start the specified application');
      server.posts++;
      const app = structuredClone(body);
      if (server.current) server.current = '';   // toda gravação encerra o aplicativo em execução
      if (!app.uuid) app.uuid = `NOVO-${server.apps.length + 1}`;
      const i = server.apps.findIndex((a) => a.uuid === app.uuid);
      if (i >= 0) server.apps[i] = app; else server.apps.push(app);
      return ok();
    }
    case '/api/apps/delete': server.apps = server.apps.filter((a) => a.uuid !== body.uuid); return ok();
    case '/api/apps/reorder': server.apps = body.order.map((u) => server.apps.find((a) => a.uuid === u)).filter(Boolean); return ok();
    case '/api/apps/launch': return server.apps.some((a) => a.uuid === body.uuid) ? ok() : bad('Cannot find requested application');
    case '/api/apps/close': server.current = ''; return ok();
    case '/api/covers/upload':
      if (server.failUpload) return bad('Failed to download cover');
      server.covers.set(body.key, body.data);
      return ok({ path: `C:\\dados\\covers\\${body.key}.png` });
    default: return { status: 404, body: '' };
  }
}
globalThis.window = {
  chrome: {
    webview: {
      addEventListener(_t, fn) { listener = fn; },
      postMessage(m) {
        queueMicrotask(() => {
          let r;
          switch (m.cmd) {
            case 'api': r = handleApi(m); break;
            case 'scan': r = server.scanError ? { error: 'boom' } : { games: server.scan }; break;
            case 'cover': server.coverAsked.push(m.gameId); server.onCover?.(m); r = { data: server.coverData[m.gameId] ?? null }; break;
            case 'readCover': r = { data: server.covers.size ? 'UE5H' : null }; break;
            default: r = { ok: true };
          }
          listener({ data: JSON.stringify(reply(m, r)) });
        });
      },
    },
  },
};

const core = await import('../../ui/js/core.js');
const L = await import('../../ui/js/lib/library.js');
const toasts = [];
const asks = [];
let answer = true;
L.ui.toast = (msg, kind) => toasts.push({ msg, kind });
L.ui.confirm = async (msg) => { asks.push(msg); return answer; };

const EXE = 'C:\\R3D\\ApolloConfig.exe';
const game = (id, name, dir = `D:\\Steam\\common\\${name}`) => ({
  source: 'steam', id, name, uuid: `U-${id}`,
  app: { name, uuid: `U-${id}`, 'image-path': '', detached: [`steam://rungameid/${id}`], 'terminate-on-pause': true, 'virtual-display': true, 'prep-cmd': [{ do: '', undo: `"${EXE}" --close-dir "${dir}"`, elevated: false }] },
});
const posts = () => server.log.filter((l) => l === 'POST /api/apps').length;

beforeEach(() => {
  Object.assign(server, { apps: [{ name: 'Desktop', uuid: 'DESK', 'image-path': 'desktop.png' }], current: '', offline: false, log: [], covers: new Map(), failUpload: false, failPost: false, scan: [], coverData: {}, coverAsked: [], posts: 0, scanError: false, onCover: null, afterGet: null });
  ls.clear();
  L._resetForTests();
  core.state.apps = []; core.state.currentApp = '';
  toasts.length = 0; asks.length = 0; answer = true;
});

test('adiciona os jogos novos uma única vez e a segunda busca não grava nada', async () => {
  server.scan = [game('1', 'A'), game('2', 'B')];
  const r1 = await L.detectGames({ manual: false });
  assert.equal(r1.found, 2);
  assert.equal(r1.added, 2);
  assert.deepEqual(server.apps.map((a) => a.uuid), ['DESK', 'U-1', 'U-2']);
  assert.equal(posts(), 2);
  server.log.length = 0;
  const r2 = await L.detectGames({ manual: false });
  assert.deepEqual([r2.found, r2.added], [2, 0]);
  assert.equal(posts(), 0, 'idempotente: nenhuma gravação na segunda busca');
  assert.equal(toasts.length, 0, 'busca automática é silenciosa');
});
test('autoSync é a busca silenciosa', async () => {
  server.scan = [game('1', 'A')];
  const r = await L.autoSync();
  assert.deepEqual([r.found, r.added], [1, 1]);
  assert.equal(toasts.length, 0);
});
test('busca manual mostra o resultado', async () => {
  server.scan = [game('1', 'A')];
  await L.detectGames({ manual: true });
  assert.equal(toasts.at(-1).msg, '1 jogo novo adicionado.');
  await L.detectGames({ manual: true });
  assert.equal(toasts.at(-1).msg, '1 jogo encontrado, nenhum novo.');
  server.scan = [];
  await L.detectGames({ manual: true });
  assert.match(toasts.at(-1).msg, /Nenhum jogo/);
});
test('aplica a política a jogos já existentes sem tocar nos campos do usuário, e só uma vez', async () => {
  const g = game('1', 'A');
  server.apps.push({ name: 'Meu nome', uuid: 'U-1', 'exit-timeout': 0, 'image-path': 'C:\\dados\\covers\\U-1.png', 'virtual-display': false, 'prep-cmd': [{ do: 'x', undo: 'y', elevated: true }] });
  server.scan = [g];
  const r = await L.detectGames({ manual: false });
  assert.equal(r.added, 0);
  assert.equal(r.updated, 1);
  const a = server.apps.find((x) => x.uuid === 'U-1');
  assert.equal(a.name, 'Meu nome');
  assert.equal(a['exit-timeout'], 0);
  assert.equal(a['virtual-display'], true);
  assert.equal(a['prep-cmd'].length, 2);
  assert.equal(a['prep-cmd'][0].do, 'x');
  server.log.length = 0;
  await L.detectGames({ manual: false });
  assert.equal(posts(), 0);
});
test('respeita o que o usuário desligou de propósito (opt-out) mesmo em buscas seguintes', async () => {
  const g = game('1', 'A');
  server.apps.push({ ...structuredClone(g.app), 'virtual-display': false });
  L.setOptOut('U-1', ['virtual-display']);
  server.scan = [g];
  await L.detectGames({ manual: false });
  assert.equal(server.apps.find((x) => x.uuid === 'U-1')['virtual-display'], false);
  assert.equal(posts(), 0);
});
test('com transmissão ativa a busca automática NÃO grava nada e retoma quando a transmissão acaba', async () => {
  server.scan = [game('1', 'A')];
  server.current = 'DESK';
  core.state.currentApp = 'DESK';
  const r = await L.detectGames({ manual: false });
  assert.equal(r.added, 0);
  assert.equal(r.deferred, true);
  assert.equal(posts(), 0);
  assert.equal(server.current, 'DESK', 'a transmissão continua');
  assert.equal(L._pending(), true);
  // a transmissão acaba: o evento "apps" dispara a busca pendente
  server.current = '';
  await core.loadApps();
  await new Promise((r2) => setTimeout(r2, 50));
  assert.deepEqual(server.apps.map((a) => a.uuid), ['DESK', 'U-1']);
});
test('busca manual com transmissão ativa pergunta antes; recusar não grava', async () => {
  server.scan = [game('1', 'A')];
  server.current = 'DESK';
  answer = false;
  const r = await L.detectGames({ manual: true });
  assert.equal(r.declined, true);
  assert.equal(asks.length, 1);
  assert.match(asks[0], /transmissão em andamento \(Desktop\)/);
  assert.equal(posts(), 0);
  assert.equal(toasts.at(-1).msg, 'Nada foi alterado.');
  answer = true;
  const r2 = await L.detectGames({ manual: true });
  assert.equal(r2.added, 1);
  assert.equal(server.current, '', 'o servidor encerrou ao gravar, como avisado');
});
test('sem nada a gravar, a transmissão ativa não gera pergunta nem gravação', async () => {
  const g = game('1', 'A');
  server.apps.push(structuredClone(g.app));
  server.scan = [g];
  server.current = 'U-1';
  const r = await L.detectGames({ manual: true });
  assert.equal(asks.length, 0);
  assert.equal(posts(), 0);
  assert.equal(r.deferred, false);
});
test('jogo removido pelo usuário não volta sozinho, mas volta na busca manual', async () => {
  server.scan = [game('1', 'A'), game('2', 'B')];
  await L.detectGames({ manual: false });
  await L.removeApp('U-1');
  L.rememberDismissed('U-1');
  assert.deepEqual(server.apps.map((a) => a.uuid), ['DESK', 'U-2']);
  await L.autoSync();
  assert.deepEqual(server.apps.map((a) => a.uuid), ['DESK', 'U-2'], 'busca automática respeita');
  const r = await L.detectGames({ manual: true });
  assert.equal(r.added, 1);
  assert.deepEqual(server.apps.map((a) => a.uuid).sort(), ['DESK', 'U-1', 'U-2']);
  assert.deepEqual(L.getDismissed(), [], 'deixa de constar como removido');
});
test('servidor fora do ar e scan com erro não lançam exceção', async () => {
  server.scan = [game('1', 'A')];
  server.offline = true;
  const r = await L.detectGames({ manual: true });
  assert.deepEqual([r.found, r.added], [1, 0]);
  assert.match(toasts.at(-1).msg, /não está respondendo/);
  server.offline = false;
  server.scanError = true;
  const r2 = await L.detectGames({ manual: true });
  assert.deepEqual([r2.found, r2.added], [0, 0]);
  assert.match(toasts.at(-1).msg, /procurar os jogos/);
});
test('falha ao gravar conta como falha e não derruba as demais', async () => {
  server.scan = [game('1', 'A'), game('2', 'B')];
  server.failPost = true;
  const r = await L.detectGames({ manual: true });
  assert.equal(r.failed, 2);
  assert.equal(r.added, 0);
  assert.equal(toasts.at(-1).kind, 'err');
});
test('capas: baixa só de quem não tem imagem, grava image-path e não pergunta de novo', async () => {
  server.scan = [game('1', 'A'), game('2', 'B')];
  server.coverData = { 1: 'UE5H' };      // só o jogo 1 tem capa
  await L.detectGames({ manual: false });
  const a = server.apps.find((x) => x.uuid === 'U-1');
  const b = server.apps.find((x) => x.uuid === 'U-2');
  assert.equal(a['image-path'], 'C:\\dados\\covers\\U-1.png');
  assert.equal(b['image-path'], '');
  assert.equal(server.covers.get('U-1'), 'UE5H');
  assert.deepEqual([...server.coverAsked].sort(), ['1', '2']);
  server.coverAsked.length = 0;
  await L.detectGames({ manual: false });
  assert.deepEqual(server.coverAsked, [], 'quem não tem capa só é tentado de novo depois de uma semana');
});
test('capas: não sobrescreve a imagem que o usuário escolheu enquanto a capa era baixada', async () => {
  server.scan = [game('1', 'A')];
  server.coverData = { 1: 'UE5H' };
  // no meio do download, o usuário grava outra capa pelo editor
  server.onCover = () => { server.apps.find((x) => x.uuid === 'U-1')['image-path'] = 'D:/minha/covers/x.png'; };
  await L.detectGames({ manual: false });
  assert.equal(server.apps.find((x) => x.uuid === 'U-1')['image-path'], 'D:/minha/covers/x.png');
});
test('capas: falha no envio é tentada de novo só depois de um tempo, sem derrubar a busca', async () => {
  server.scan = [game('1', 'A')];
  server.coverData = { 1: 'UE5H' };
  server.failUpload = true;
  const r = await L.detectGames({ manual: false });
  assert.equal(r.added, 1);
  assert.equal(server.apps.find((x) => x.uuid === 'U-1')['image-path'], '');
  const tried = JSON.parse(ls.get(L.STORE_KEYS.tried));
  assert.ok(tried['U-1'] > Date.now(), 'marcou para tentar mais tarde');
});
test('capas: com transmissão ativa não grava capa', async () => {
  const g = game('1', 'A');
  server.apps.push(structuredClone(g.app));
  server.scan = [g];
  server.coverData = { 1: 'UE5H' };
  server.current = 'DESK';
  await L.detectGames({ manual: false });
  assert.equal(posts(), 0);
  assert.equal(server.apps.find((x) => x.uuid === 'U-1')['image-path'], '');
});
test('origem dos jogos: o scanner decide e fica guardada para a próxima abertura', async () => {
  server.scan = [{ ...game('1', 'A'), source: 'epic' }];
  await L.detectGames({ manual: false });
  assert.equal(L.sourceForApp(server.apps.find((a) => a.uuid === 'U-1')), 'epic');
  L._resetForTests();   // "reabre a janela": memória limpa, localStorage permanece
  assert.equal(L.sourceForApp({ uuid: 'U-1', name: 'A', detached: ['steam://x'] }), 'epic');
  assert.equal(L.sourceForApp({ uuid: 'DESK', name: 'Desktop' }), 'other');
});
test('leitura de capa local usa o app nativo, guarda em cache e esquece ao invalidar', async () => {
  server.covers.set('x', 'y');
  const app = { uuid: 'U', 'image-path': 'C:\\dados\\covers\\U.png' };
  assert.equal(L.peekCover(app), '');
  const url = await L.loadCover(app);
  assert.equal(url, 'data:image/png;base64,UE5H');
  assert.equal(L.peekCover(app), url);
  L.invalidateCover(app);
  assert.equal(L.peekCover(app), '');
  assert.equal(await L.loadCover({ uuid: 'D', 'image-path': 'desktop.png' }), '');
});
test('as gravações entram numa fila: nunca se sobrepõem', async () => {
  let ativas = 0; let pico = 0;
  const tarefa = () => L.serialize(async () => { ativas++; pico = Math.max(pico, ativas); await new Promise((r) => setTimeout(r, 5)); ativas--; });
  await Promise.all([tarefa(), tarefa(), tarefa(), L.serialize(async () => { throw new Error('x'); }).catch(() => {}), tarefa()]);
  assert.equal(pico, 1);
});
test('wrappers de API devolvem mensagens em português quando o servidor recusa', async () => {
  const r = await L.launchApp('NAO-EXISTE');
  assert.equal(r.ok, false);
  assert.match(r.error, /^A abertura do aplicativo falhou: o aplicativo não foi encontrado/);
  server.offline = true;
  const r2 = await L.closeApp();
  assert.equal(r2.ok, false);
  assert.match(r2.error, /não respondeu/);
  server.offline = false;
  assert.equal((await L.reorderApps(['DESK'])).ok, true);
  assert.equal((await L.uploadCover('K', 'ABC')).path, 'C:\\dados\\covers\\K.png');
  server.failUpload = true;
  assert.equal((await L.uploadCover('K', 'ABC')).ok, false);
});
test('isDetectedGame lembra jogos detectados mesmo depois de reabrir a janela', async () => {
  server.scan = [game('1', 'A')];
  await L.detectGames({ manual: false });
  assert.equal(L.isDetectedGame('U-1'), true);
  assert.equal(L.isDetectedGame('DESK'), false);
  L._resetForTests();
  assert.equal(L.isDetectedGame('U-1'), true);
  assert.equal(L.isDetectedGame('DESK'), false);
});
test('mutateApp: app inexistente, nada a mudar e recusa com transmissão ativa', async () => {
  const gone = await L.mutateApp('NAO-EXISTE', (a) => a);
  assert.equal(gone.ok, false);
  assert.equal(gone.gone, true);
  const nada = await L.mutateApp('DESK', () => null);
  assert.deepEqual([nada.ok, nada.skipped], [true, true]);
  assert.equal(posts(), 0);
  server.current = 'DESK';
  const recusa = await L.mutateApp('DESK', (a) => ({ ...a, name: 'X' }), { refuseIfRunning: true });
  assert.deepEqual([recusa.ok, recusa.running], [true, true]);
  assert.equal(server.apps[0].name, 'Desktop');
  const forca = await L.mutateApp('DESK', (a) => ({ ...a, name: 'Y' }));
  assert.equal(forca.ok, true);
  assert.equal(server.apps[0].name, 'Y');
});
test('addApp não duplica um uuid que já existe', async () => {
  const r = await L.addApp({ name: 'Outro', uuid: 'DESK' });
  assert.deepEqual([r.ok, r.skipped], [true, true]);
  assert.equal(server.apps.length, 1);
  const n = await L.addApp({ name: 'Novo' });
  assert.equal(n.ok, true);
  assert.equal(server.apps.length, 2);
});
test('uma busca manual durante a automática soma os resultados sem gravar em dobro', async () => {
  server.scan = [game('1', 'A'), game('2', 'B')];
  const [auto, manual] = await Promise.all([L.detectGames({ manual: false }), L.detectGames({ manual: true })]);
  assert.equal(auto.added, 2);
  assert.equal(manual.added, 2, 'a busca manual relata o que a automática acabou de adicionar');
  assert.equal(posts(), 2);
  assert.equal(toasts.at(-1).msg, '2 jogos novos adicionados.');
});

/* ---------- Correções da revisão ---------- */
test('busca manual: jogo iniciado depois da checagem inicial NÃO é derrubado sem perguntar', async () => {
  server.scan = [game('1', 'A')];
  server.afterGet = () => { server.current = 'DESK'; };   // o jogo sobe logo depois da leitura da lista, antes de gravar
  answer = false;
  const r = await L.detectGames({ manual: true });
  assert.equal(asks.length, 1, 'perguntou na hora de gravar');
  assert.match(asks[0], /Desktop/);
  assert.equal(r.declined, true);
  assert.equal(posts(), 0);
  assert.equal(server.current, 'DESK', 'a transmissão continua');
  assert.equal(toasts.at(-1).msg, 'Nada foi alterado.');
  // dizendo sim, grava (e o servidor encerra, como avisado)
  server.afterGet = () => { server.current = 'DESK'; };
  answer = true;
  const r2 = await L.detectGames({ manual: true });
  assert.equal(asks.length, 2);
  assert.equal(r2.added, 1);
  assert.equal(server.current, '');
});
test('busca automática: jogo iniciado depois da checagem inicial também adia a gravação', async () => {
  server.scan = [game('1', 'A')];
  server.afterGet = () => { server.current = 'DESK'; };
  const r = await L.detectGames({ manual: false });
  assert.equal(r.deferred, true);
  assert.equal(posts(), 0);
  assert.equal(L._pending(), true);
  assert.equal(server.current, 'DESK');
  assert.equal(asks.length, 0);
});
test('capas: sem rede (nenhuma capa veio) a espera é curta e a busca manual tenta de novo na hora', async () => {
  server.scan = [game('1', 'A')];
  await L.detectGames({ manual: false });
  const tried = JSON.parse(ls.get(L.STORE_KEYS.tried));
  assert.ok(tried['U-1'] - Date.now() <= L.COVER_RETRY_MS.failure + 1000, 'não ficou 7 dias sem tentar');
  assert.deepEqual(server.coverAsked, ['1']);
  server.coverData = { 1: 'UE5H' };   // a rede voltou
  await L.autoSync();
  assert.equal(server.coverAsked.length, 1, 'a busca automática respeita a espera');
  await L.detectGames({ manual: true });
  assert.equal(server.coverAsked.length, 2, 'a manual ignora a espera');
  assert.equal(server.apps.find((x) => x.uuid === 'U-1')['image-path'], 'C:\\dados\\covers\\U-1.png');
});
test('capas: o prazo longo só vale quando outra capa do mesmo lote veio (a rede funcionou)', async () => {
  server.scan = [game('1', 'A'), game('2', 'B')];
  server.coverData = { 1: 'UE5H' };
  await L.detectGames({ manual: false });
  const tried = JSON.parse(ls.get(L.STORE_KEYS.tried));
  assert.ok(tried['U-2'] - Date.now() > L.COVER_RETRY_MS.noCover - 60000, 'B realmente não tem capa: espera uma semana');
  assert.equal(tried['U-1'], undefined, 'quem recebeu a capa não entra na lista de espera');
});
test('capas: quem tirou a capa de propósito no editor não a recebe de volta', async () => {
  server.scan = [game('1', 'A')];
  server.coverData = { 1: 'UE5H' };
  await L.detectGames({ manual: false });
  const i = server.apps.findIndex((x) => x.uuid === 'U-1');
  const original = structuredClone(server.apps[i]);
  assert.ok(original['image-path']);
  // o usuário clica em "Remover capa" e salva (o editor registra a escolha)
  const edited = { ...original, 'image-path': '' };
  server.apps[i] = edited;
  L.setOptOut('U-1', L.optOutAfterEdit(L.getOptOut('U-1'), original, edited, L.getDetected('U-1')));
  assert.deepEqual(L.getOptOut('U-1'), ['cover']);
  server.coverAsked.length = 0;
  await L.detectGames({ manual: false });
  await L.detectGames({ manual: true });
  assert.deepEqual(server.coverAsked, []);
  assert.equal(server.apps[i]['image-path'], '');
  // escolhendo uma capa de novo, a escolha de não ter capa deixa de valer
  const back = { ...edited, 'image-path': 'C:\\dados\\covers\\U-1.png' };
  L.setOptOut('U-1', L.optOutAfterEdit(L.getOptOut('U-1'), edited, back, L.getDetected('U-1')));
  assert.deepEqual(L.getOptOut('U-1'), []);
});
test('jogo detectado com "$(" sem ")" é gravado com o "$" escapado e a busca seguinte não regrava', async () => {
  server.scan = [game('1', 'Jogo $(Beta', 'D:\\Jogos\\$(Beta')];
  await L.detectGames({ manual: false });
  const a = server.apps.find((x) => x.uuid === 'U-1');
  assert.equal(a.name, 'Jogo $$(Beta');
  assert.ok(a['prep-cmd'][0].undo.includes('$$(Beta'));
  assert.equal(L.getDetected('U-1').name, 'Jogo $(Beta', 'a capa continua sendo procurada pelo nome real');
  server.log.length = 0;
  await L.detectGames({ manual: false });
  assert.equal(posts(), 0);
});
