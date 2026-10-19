// Testes da política dos jogos detectados e do planejamento da busca (funções puras de ui/js/lib/library.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../../ui/js/lib/library.js';

const EXE = 'C:\\Program Files\\R3D PLAY\\ApolloConfig.exe';
const close = (dir, exe = EXE) => ({ do: '', undo: `"${exe}" --close-dir "${dir}"`, elevated: false });
/** O que o GameScanner.cs devolve para um jogo da Steam. */
function steamGame({ id = '220', name = 'Half-Life 2', uuid = 'UUID-' + id, launch, dir = 'D:\\Steam\\steamapps\\common\\HL2', exe = EXE } = {}) {
  return {
    source: 'steam', id, name, uuid,
    app: { name, uuid, 'image-path': '', detached: [launch ?? `steam://rungameid/${id}`], 'terminate-on-pause': true, 'virtual-display': true, 'prep-cmd': [close(dir, exe)] },
  };
}
const detectedApp = (g) => structuredClone(g.app);

test('app que já segue a política: nada a fazer (idempotente)', () => {
  const g = steamGame();
  assert.equal(L.policyUpdate(detectedApp(g), g), null);
});
test('liga terminate-on-pause e virtual-display que faltam e completa o que a política pede', () => {
  const g = steamGame();
  const velho = { name: 'Half-Life 2', uuid: g.uuid, 'image-path': 'C:/x/covers/a.png' };
  const novo = L.policyUpdate(velho, g);
  assert.equal(novo['terminate-on-pause'], true);
  assert.equal(novo['virtual-display'], true);
  assert.deepEqual(novo.detached, ['steam://rungameid/220']);
  assert.deepEqual(novo['prep-cmd'], g.app['prep-cmd']);
  assert.equal(novo['image-path'], 'C:/x/covers/a.png');
  // segunda rodada sobre o resultado: nada muda
  assert.equal(L.policyUpdate(novo, g), null);
});
test('valores em texto ("true") não contam como ligado', () => {
  const g = steamGame();
  const app = { ...detectedApp(g), 'virtual-display': 'true' };
  assert.equal(L.policyUpdate(app, g)['virtual-display'], true);
});
test('NUNCA mexe em campos fora da política (nome, cmd, tempos, listas do usuário)', () => {
  const g = steamGame();
  const meu = {
    name: 'Meu nome', uuid: g.uuid, cmd: 'meu.exe --x', 'working-dir': 'D:\\x', 'image-path': 'C:/covers/a.png', 'exit-timeout': 0,
    'scale-factor': 130, 'wait-all': false, gamepad: 'x360', output: 'log.txt', outra_chave: { a: 1 },
    'state-cmd': [{ do: 'a', undo: 'b', elevated: true }],
    'prep-cmd': [{ do: 'ligar luz', undo: 'desligar luz', elevated: true }],
    detached: ['meu-script.bat'],
    // terminate/virtual desligados -> a política religa
  };
  const novo = L.policyUpdate(meu, g);
  const politica = new Set(['terminate-on-pause', 'virtual-display', 'prep-cmd', 'detached']);
  for (const [k, v] of Object.entries(meu)) {
    if (politica.has(k)) continue;
    assert.deepEqual(novo[k], v, `campo ${k} não pode mudar`);
  }
  // listas: os itens do usuário continuam, a política só acrescenta o dela
  assert.deepEqual(novo['prep-cmd'][0], meu['prep-cmd'][0]);
  assert.equal(novo['prep-cmd'].length, 2);
  assert.match(novo['prep-cmd'][1].undo, /--close-dir/);
  assert.ok(novo.detached.includes('meu-script.bat'));
  assert.ok(novo.detached.includes('steam://rungameid/220'));
  assert.equal(novo.detached.length, 2);
});
test('close-dir desatualizado (exe mudou de lugar) é trocado no mesmo lugar, sem duplicar nem apagar os outros itens', () => {
  const g = steamGame({ exe: 'D:\\Novo\\ApolloConfig.exe' });
  const app = {
    ...detectedApp(g),
    'prep-cmd': [{ do: 'a', undo: 'b', elevated: false }, close('D:\\Steam\\steamapps\\common\\HL2', 'C:\\Velho\\ApolloConfig.exe'), { do: 'c', undo: 'd', elevated: false }],
  };
  const novo = L.policyUpdate(app, g);
  assert.equal(novo['prep-cmd'].length, 3);
  assert.equal(novo['prep-cmd'][0].do, 'a');
  assert.equal(novo['prep-cmd'][1].undo, g.app['prep-cmd'][0].undo);
  assert.equal(novo['prep-cmd'][2].do, 'c');
  assert.equal(L.policyUpdate(novo, g), null);
});
test('close-dir duplicado vira um só', () => {
  const g = steamGame();
  const app = { ...detectedApp(g), 'prep-cmd': [g.app['prep-cmd'][0], g.app['prep-cmd'][0]] };
  assert.equal(L.policyUpdate(app, g)['prep-cmd'].length, 1);
});
test('close-dir só difere em maiúsculas/espaços: considera igual (não regrava)', () => {
  const g = steamGame({ dir: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Wallpaper_Engine' });
  const app = { ...detectedApp(g) };
  app['prep-cmd'] = [{ do: '', undo: g.app['prep-cmd'][0].undo.toLowerCase(), elevated: false }];
  assert.equal(L.policyUpdate(app, g), null);
});
test('jogo que abre por cmd (GOG) não mexe em detached do usuário e não regrava (bug do app.js antigo)', () => {
  const g = { source: 'gog', id: '1', name: 'Jogo GOG', uuid: 'G1', app: { name: 'Jogo GOG', uuid: 'G1', cmd: '"D:\\GOG\\j.exe"', 'working-dir': 'D:\\GOG', 'image-path': '', 'terminate-on-pause': true, 'virtual-display': true, 'prep-cmd': [close('D:\\GOG')] } };
  const app = { ...structuredClone(g.app), detached: ['meu-comando.bat'] };
  assert.equal(L.policyUpdate(app, g), null);
});
test('comando de abertura da Steam: troca o antigo do mesmo jogo, preserva os de outros jogos e do usuário', () => {
  const g = steamGame({ launch: `"${EXE}" --launch-steam 220 source` });
  const app = { ...detectedApp(g), detached: ['meu.bat', 'steam://rungameid/220', 'steam://rungameid/2200'] };
  const novo = L.policyUpdate(app, g);
  assert.deepEqual(novo.detached, ['meu.bat', `"${EXE}" --launch-steam 220 source`, 'steam://rungameid/2200']);
  assert.equal(L.policyUpdate(novo, g), null);
});
test('isManagedLaunch: por jogo e por loja (sem confundir ids parecidos)', () => {
  const s = steamGame({ id: '22' });
  assert.equal(L.isManagedLaunch('steam://rungameid/22', s), true);
  assert.equal(L.isManagedLaunch('steam://rungameid/220', s), false);
  assert.equal(L.isManagedLaunch('"x.exe" --launch-steam 22 unity', s), true);
  assert.equal(L.isManagedLaunch('"steam.exe" -applaunch 22 -windowed', s), true);
  assert.equal(L.isManagedLaunch('outro.bat', s), false);
  const e = { source: 'epic', id: 'abc123', app: { detached: ['com.epicgames.launcher://apps/ns%3Aitem%3Aabc123?action=launch&silent=true'] } };
  assert.equal(L.isManagedLaunch('com.epicgames.launcher://apps/ns%3Aitem%3Aabc123?action=launch&silent=true', e), true);
  assert.equal(L.isManagedLaunch('com.epicgames.launcher://apps/ns%3Aitem%3Aabc1234?action=launch', e), false);
  const u = { source: 'ubisoft', id: '720', app: { detached: ['uplay://launch/720/0'] } };
  assert.equal(L.isManagedLaunch('uplay://launch/720/0', u), true);
  assert.equal(L.isManagedLaunch('uplay://launch/7200/0', u), false);
  assert.equal(L.isManagedLaunch('x', { source: 'gog', id: '1', app: {} }), false);
});
test('skip: partes que o usuário desligou de propósito não são religadas', () => {
  const g = steamGame();
  const app = { name: 'x', uuid: g.uuid, 'virtual-display': false, 'terminate-on-pause': false, 'prep-cmd': [], detached: [] };
  const todos = L.policyUpdate(app, g);
  assert.equal(todos['virtual-display'], true);
  const sem = L.policyUpdate(app, g, { skip: ['virtual-display', 'close-dir'] });
  assert.equal(sem['virtual-display'], false);
  assert.equal(sem['terminate-on-pause'], true);
  assert.deepEqual(sem['prep-cmd'], []);
  assert.equal(L.policyUpdate(app, g, { skip: ['virtual-display', 'terminate-on-pause', 'close-dir', 'detached'] }), null);
});
test('entradas inválidas devolvem null em vez de quebrar', () => {
  assert.equal(L.policyUpdate(null, steamGame()), null);
  assert.equal(L.policyUpdate({ name: 'x' }, null), null);
  assert.equal(L.policyUpdate({ name: 'x' }, { app: null }), null);
  assert.equal(L.policyUpdate({ name: 'x', 'prep-cmd': 'quebrado', detached: 5 }, steamGame()) !== undefined, true);
});
test('policyUpdate não altera o objeto original', () => {
  const g = steamGame();
  const app = { name: 'x', uuid: g.uuid, 'prep-cmd': [{ do: 'a', undo: 'b', elevated: false }], detached: ['z'] };
  const copia = structuredClone(app);
  L.policyUpdate(app, g);
  assert.deepEqual(app, copia);
});

/* ---------- Escolhas do usuário no editor ---------- */
test('optOutAfterEdit: só conta o que o usuário mudou nesta edição', () => {
  const g = steamGame();
  const completo = detectedApp(g);
  // desligou a tela virtual
  let skip = L.optOutAfterEdit([], completo, { ...completo, 'virtual-display': false }, g);
  assert.deepEqual(skip, ['virtual-display']);
  // religou depois
  skip = L.optOutAfterEdit(skip, { ...completo, 'virtual-display': false }, completo, g);
  assert.deepEqual(skip, []);
  // app antigo sem a política, salvo só com outro nome: NÃO vira opt-out
  const antigo = { name: 'x', uuid: g.uuid };
  assert.deepEqual(L.optOutAfterEdit([], antigo, { ...antigo, name: 'y' }, g), []);
  // removeu o item close-dir
  skip = L.optOutAfterEdit([], completo, { ...completo, 'prep-cmd': [] }, g);
  assert.deepEqual(skip, ['close-dir']);
  // trocou o comando de abertura por outro
  skip = L.optOutAfterEdit([], completo, { ...completo, detached: ['meu.bat'] }, g);
  assert.deepEqual(skip, ['detached']);
  // mexeu na lista mas manteve o comando detectado
  skip = L.optOutAfterEdit(['detached'], completo, { ...completo, detached: [...completo.detached, 'extra.bat'] }, g);
  assert.deepEqual(skip, []);
  // preserva o que já estava
  assert.deepEqual(L.optOutAfterEdit(['virtual-display'], completo, { ...completo, name: 'z' }, g), ['virtual-display']);
});

/* ---------- Planejamento da busca ---------- */
test('planDetection: separa novos e ajustes; ignora removidos na busca automática', () => {
  const a = steamGame({ id: '1', name: 'A' });
  const b = steamGame({ id: '2', name: 'B' });
  const c = steamGame({ id: '3', name: 'C' });
  const apps = [{ name: 'Desktop', uuid: 'D' }, { name: 'B', uuid: b.uuid }, detectedApp(c)];
  const auto = L.planDetection({ apps, found: [a, b, c], dismissed: [a.uuid] });
  assert.deepEqual(auto.toAdd.map((g) => g.uuid), []);
  assert.deepEqual(auto.toUpdate.map((u) => u.uuid), [b.uuid]);
  const manual = L.planDetection({ apps, found: [a, b, c], dismissed: [a.uuid], manual: true });
  assert.deepEqual(manual.toAdd.map((g) => g.uuid), [a.uuid]);
  assert.deepEqual(manual.revived, [a.uuid]);
  const semRemovidos = L.planDetection({ apps, found: [a, b, c] });
  assert.deepEqual(semRemovidos.toAdd.map((g) => g.uuid), [a.uuid]);
  assert.deepEqual(semRemovidos.revived, []);
});
test('planDetection: uuid repetido, jogo malformado e lista vazia não quebram', () => {
  const a = steamGame({ id: '1' });
  const p = L.planDetection({ apps: [], found: [a, a, null, { uuid: 5 }, { uuid: 'X' }, { uuid: 'Y', app: null }] });
  assert.equal(p.toAdd.length, 1);
  assert.deepEqual(L.planDetection({}), { toAdd: [], toUpdate: [], revived: [] });
  assert.deepEqual(L.planDetection({ apps: [{ uuid: 'x' }], found: [] }).toUpdate, []);
});
test('planDetection é idempotente: depois de aplicar o plano, o próximo plano é vazio', () => {
  const games = [steamGame({ id: '1', name: 'A' }), steamGame({ id: '2', name: 'B' })];
  const apps = [{ name: 'A', uuid: games[0].uuid }];
  const p1 = L.planDetection({ apps, found: games });
  const depois = [...apps.map((a) => (p1.toUpdate.find((u) => u.uuid === a.uuid)?.next ?? a)), ...p1.toAdd.map(L.appForAdd)];
  const p2 = L.planDetection({ apps: depois, found: games });
  assert.equal(p2.toAdd.length + p2.toUpdate.length, 0);
});
test('appForAdd garante uuid e remove chaves de execução', () => {
  const g = steamGame();
  delete g.app.uuid;
  g.app.launching = true;
  const app = L.appForAdd(g);
  assert.equal(app.uuid, g.uuid);
  assert.equal(app.launching, undefined);
  assert.equal(g.app.launching, true, 'não altera o original');
});

/* ---------- Capas ---------- */
test('shouldTryCover: só quem não tem imagem e não foi tentado há pouco', () => {
  const now = 1_000_000;
  assert.equal(L.shouldTryCover({ uuid: 'a', 'image-path': '' }, {}, now), true);
  assert.equal(L.shouldTryCover({ uuid: 'a' }, {}, now), true);
  assert.equal(L.shouldTryCover({ uuid: 'a', 'image-path': 'C:/covers/a.png' }, {}, now), false);
  assert.equal(L.shouldTryCover({ uuid: 'a', 'image-path': '   ' }, {}, now), true);
  assert.equal(L.shouldTryCover({ uuid: 'a' }, { a: now + 10 }, now), false);
  assert.equal(L.shouldTryCover({ uuid: 'a' }, { a: now - 10 }, now), true);
  assert.equal(L.shouldTryCover(null, {}, now), false);
});
test('coverPathOf só aceita .png dentro de uma pasta covers com caminho completo', () => {
  assert.equal(L.coverPathOf({ 'image-path': 'C:\\Program Files\\Apollo\\config/covers/ABC.png' }), 'C:/Program Files/Apollo/config/covers/ABC.png');
  assert.equal(L.coverPathOf({ 'image-path': 'C:\\dev\\covers\\x.PNG' }), 'C:/dev/covers/x.PNG');
  assert.equal(L.coverPathOf({ 'image-path': 'desktop.png' }), '');
  assert.equal(L.coverPathOf({ 'image-path': 'covers/x.png' }), '');
  assert.equal(L.coverPathOf({ 'image-path': 'C:\\dev\\outra\\x.png' }), '');
  assert.equal(L.coverPathOf({ 'image-path': 'C:\\dev\\covers\\x.jpg' }), '');
  assert.equal(L.coverPathOf({}), '');
});

/* ---------- Mensagens ---------- */
test('describeApiError traduz os erros conhecidos e nunca devolve texto vazio', () => {
  assert.match(L.describeApiError({ status: 0 }), /não respondeu/);
  assert.match(L.describeApiError({ status: 401 }), /sessão/);
  assert.match(L.describeApiError({ status: 307 }), /usuário e senha/);
  assert.match(L.describeApiError({ status: 400, json: { error: 'Failed to start the specified application' } }), /programa não abriu/);
  assert.match(L.describeApiError({ status: 400, json: { error: 'Failed to initialize video capture/encoding. Is a display connected and turned on?' } }), /captura de vídeo/);
  assert.match(L.describeApiError({ status: 400, json: { error: 'Cannot find requested application' } }), /não foi encontrado/);
  assert.match(L.describeApiError({ status: 400, json: { error: 'algo novo' } }), /"algo novo"/);
  assert.match(L.describeApiError({ status: 500 }), /código 500/);
  assert.match(L.describeApiError(undefined), /não respondeu/);
});
test('detectionMessage cobre cada resultado com plural correto', () => {
  assert.match(L.detectionMessage({ found: 0 }).text, /Nenhum jogo/);
  assert.equal(L.detectionMessage({ found: 5, added: 1 }).text, '1 jogo novo adicionado.');
  assert.equal(L.detectionMessage({ found: 5, added: 3, updated: 2 }).text, '3 jogos novos adicionados. 2 jogos foram ajustados.');
  assert.equal(L.detectionMessage({ found: 1 }).text, '1 jogo encontrado, nenhum novo.');
  assert.equal(L.detectionMessage({ found: 4 }).text, '4 jogos encontrados, nenhum novo.');
  assert.equal(L.detectionMessage({ found: 4, updated: 1 }).text, '4 jogos encontrados, nenhum novo. 1 jogo foi ajustado.');
  assert.equal(L.detectionMessage({ error: 'falhou' }).kind, 'err');
  assert.equal(L.detectionMessage({ found: 3, failed: 2 }).kind, 'err');
  assert.equal(L.detectionMessage({ declined: true, found: 3 }).text, 'Nada foi alterado.');
});

/* ---------- Correções da revisão ---------- */
test('optOutAfterEdit: tirar a capa de propósito liga o opt-out "cover"; escolher uma capa de novo desliga', () => {
  const g = steamGame();
  const comCapa = { ...detectedApp(g), 'image-path': 'C:\\dados\\covers\\a.png' };
  const semCapa = { ...comCapa, 'image-path': '' };
  let skip = L.optOutAfterEdit([], comCapa, semCapa, g);
  assert.deepEqual(skip, ['cover']);
  skip = L.optOutAfterEdit(skip, semCapa, comCapa, g);
  assert.deepEqual(skip, []);
  // app que já estava sem capa e foi salvo só com outro nome: a busca continua podendo baixar a capa
  assert.deepEqual(L.optOutAfterEdit([], semCapa, { ...semCapa, name: 'y' }, g), []);
  // trocar uma capa por outra não mexe no opt-out
  assert.deepEqual(L.optOutAfterEdit([], comCapa, { ...comCapa, 'image-path': 'C:\\dados\\covers\\b.png' }, g), []);
  // preserva os outros opt-outs
  assert.deepEqual(L.optOutAfterEdit(['virtual-display'], comCapa, semCapa, g).sort(), ['cover', 'virtual-display']);
});
test('opt-out "cover" não atrapalha policyUpdate (que só olha as quatro partes da política)', () => {
  const g = steamGame();
  assert.equal(L.policyUpdate(detectedApp(g), g, { skip: ['cover'] }), null);
});
test('emptyCoverWait: prazo longo só quando a rede claramente funcionou', () => {
  assert.equal(L.emptyCoverWait(true, true), L.COVER_RETRY_MS.noCover);
  assert.equal(L.emptyCoverWait(true, undefined), L.COVER_RETRY_MS.noCover);
  assert.equal(L.emptyCoverWait(false, true), L.COVER_RETRY_MS.failure, 'nenhuma capa veio: pode ser falta de internet');
  assert.equal(L.emptyCoverWait(true, false), L.COVER_RETRY_MS.failure, 'o navegador sabe que está sem rede');
  assert.ok(L.COVER_RETRY_MS.failure < L.COVER_RETRY_MS.noCover);
});
test('"$(" sem ")" vindo da loja ou do disco nunca vai cru para o servidor', () => {
  const g = steamGame({ name: 'Jogo $(Beta', dir: 'D:\\Jogos\\$(Beta' });
  const pronto = L.prepareGame(g);
  assert.equal(pronto.app.name, 'Jogo $$(Beta');
  assert.equal(pronto.name, 'Jogo $(Beta', 'o nome para buscar a capa continua o original');
  assert.ok(pronto.app['prep-cmd'][0].undo.includes('$$(Beta'));
  const add = L.appForAdd(g);
  assert.equal(add.name, 'Jogo $$(Beta');
  assert.ok(add['prep-cmd'][0].undo.includes('$$(Beta'));
  // policyUpdate também escapa, mesmo recebendo o jogo cru, e continua idempotente
  const velho = { name: 'x', uuid: g.uuid };
  const novo = L.policyUpdate(velho, g);
  assert.ok(novo['prep-cmd'][0].undo.includes('$$(Beta'));
  assert.equal(L.policyUpdate(novo, g), null);
  // jogo sem problema volta igual e malformado vira null
  const ok = steamGame();
  assert.deepEqual(L.prepareGame(ok), ok);
  assert.equal(L.prepareGame({ uuid: 'x' }), null);
  assert.equal(L.prepareGame(null), null);
});
