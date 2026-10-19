// Biblioteca de jogos do R3D PLAY: detecção (Steam/Epic/GOG/Ubisoft), política dos jogos detectados, capas, e as chamadas de
// gravação de /api/apps* (todas em fila: o servidor lê o arquivo, altera e grava sem trava, então duas ao mesmo tempo perdem dados).
//
// Lições da versão antiga (ui/app.js) que este módulo corrige:
//  - toda gravação em /api/apps* ENCERRA o aplicativo que estiver em transmissão: a busca automática nunca grava com transmissão ativa
//    (fica pendente e roda quando a transmissão acabar); a manual pede confirmação;
//  - a política antiga regravava o app a cada busca (detached comparado de forma torta) e trocava prep-cmd/detached inteiros,
//    apagando comandos do usuário: agora a política mexe SÓ nos campos dela e é idempotente (policyUpdate devolve null se nada muda);
//  - um jogo removido pelo usuário voltava a cada abertura da janela: agora a busca automática respeita os removidos;
//  - capas eram gravadas a partir de uma lista velha (podia desfazer edições): agora cada gravação relê o app antes (mutateApp).
import { api, native, state, bus, loadApps, toast, confirmDlg, log } from '../core.js';
import { deepEqual, deepClone, isObj, knownSource, sourceOf, plural, sanitizeInterpolations, RUNTIME_KEYS } from './appmodel.js';

/* ---------- Ganchos de interface (os testes trocam estes dois) ---------- */
export const ui = {
  toast(msg, kind = '') { try { toast(msg, kind); } catch { /* sem DOM (testes) */ } },
  confirm: (msg, yes, opts) => confirmDlg(msg, yes, opts),
};

/* ---------- localStorage (sempre com try/catch: pode estar bloqueado ou cheio) ---------- */
const KEYS = {
  tried: 'r3d.games.coversTried.v2',      // uuid -> instante a partir do qual vale tentar a capa de novo
  sources: 'r3d.games.sources.v1',        // uuid -> origem (steam/epic/gog/ubisoft) vista pelo scanner
  dismissed: 'r3d.games.dismissed.v1',    // uuids de jogos detectados que o usuário removeu da lista
  optOut: 'r3d.games.optOut.v1',          // uuid -> partes da política que o usuário desligou de propósito no editor
};
export const store = {
  read(key, fallback) { try { const raw = localStorage.getItem(key); const v = raw ? JSON.parse(raw) : null; return v ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
};
export const STORE_KEYS = KEYS;

/* ---------- Erros do servidor em português ---------- */
export const MSG = {
  launch: 'A abertura do aplicativo falhou: ',
  save: 'Falha ao salvar o aplicativo: ',
  close: 'O encerramento do aplicativo falhou: ',
  remove: 'A remoção do aplicativo falhou: ',
  reorder: 'Falha ao reordenar os aplicativos: ',
  cover: 'Falha ao enviar a capa: ',
};
const KNOWN_ERRORS = [
  [/Cannot find requested application/i, 'o aplicativo não foi encontrado. Atualize a lista e tente de novo.'],
  [/Failed to initialize video capture/i, 'não foi possível iniciar a captura de vídeo. Confira se há um monitor ligado ou se o monitor virtual está instalado e funcionando.'],
  [/Failed to start the specified application/i, 'o programa não abriu. Confira o comando do aplicativo e os comandos de preparo no editor.'],
  [/Missing or invalid uuid/i, 'o identificador do aplicativo é inválido.'],
  [/Invalid UUID string length/i, 'o identificador (UUID) do aplicativo tem tamanho inválido.'],
  [/Cover key is required/i, 'não consegui dar nome ao arquivo da capa.'],
  [/Failed to download cover|Only images\.igdb\.com/i, 'não consegui baixar a capa.'],
  [/Missing or invalid 'order'/i, 'a nova ordem não foi aceita.'],
  [/Content type/i, 'o pedido saiu em formato inválido.'],
];
/** Texto amigável para uma resposta de erro de api() ({status, json, text}). */
export function describeApiError(r) {
  const status = r?.status ?? 0;
  if (status === 0) return 'o R3D PLAY não respondeu. Confira se ele está ligado.';
  if (status === 401 || status === 403) return 'o acesso foi recusado (a sessão expirou). Feche e abra o painel de novo.';
  if ([301, 302, 303, 307, 308].includes(status)) return 'o R3D PLAY ainda não tem usuário e senha. Crie o acesso primeiro.';
  const raw = String(r?.json?.error ?? '').trim();
  for (const [re, msg] of KNOWN_ERRORS) if (re.test(raw)) return msg;
  if (raw) return `o R3D PLAY respondeu "${raw}".`;
  return `o R3D PLAY recusou o pedido (código ${status}).`;
}
const okResp = (r) => !!r && r.ok && r.json?.status === true;
const outcome = (r, prefix) => (okResp(r) ? { ok: true } : { ok: false, status: r?.status ?? 0, error: prefix + describeApiError(r) });

/* ---------- Fila de gravações ---------- */
let chain = Promise.resolve();
/** Executa fn depois de tudo que já está na fila. Nunca rejeita a fila inteira por causa de uma falha. Não chame serialize() de dentro de fn. */
export function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

/** Lê o arquivo de aplicativos (não passa pela fila: só leitura). null se o servidor não respondeu. */
export async function fetchApps() {
  const r = await api('GET', '/api/apps');
  return r.ok && isObj(r.json) ? r.json : null;
}
/** Grava um aplicativo (com uuid edita; sem uuid cria). */
export const postApp = (app) => serialize(async () => outcome(await api('POST', '/api/apps', app), MSG.save));
/**
 * Relê o aplicativo, deixa fn(app, dados) devolver a versão nova (ou null para não mexer) e grava. Atômico em relação à fila.
 * refuseIfRunning: não grava se houver transmissão (a gravação a encerraria). Devolve {ok, skipped?, running?, current?, gone?, error?}.
 * Como a conferência acontece dentro da fila, ela vale também para um jogo iniciado um instante antes (current = uuid do que está rodando).
 */
export function mutateApp(uuid, fn, { refuseIfRunning = false } = {}) {
  return serialize(async () => {
    const data = await fetchApps();
    if (!data) return { ok: false, error: MSG.save + 'não consegui ler a lista de aplicativos.' };
    if (refuseIfRunning && data.current_app) return { ok: true, skipped: true, running: true, current: data.current_app };
    const cur = (data.apps || []).find((a) => a.uuid === uuid);
    if (!cur) return { ok: false, gone: true, error: MSG.save + 'o aplicativo não existe mais.' };
    const next = fn(deepClone(cur), data);
    if (!next) return { ok: true, skipped: true };
    return outcome(await api('POST', '/api/apps', next), MSG.save);
  });
}
/** Cria um aplicativo (a menos que o uuid já exista). refuseIfRunning como em mutateApp. */
export function addApp(app, { refuseIfRunning = false } = {}) {
  return serialize(async () => {
    const data = await fetchApps();
    if (!data) return { ok: false, error: MSG.save + 'não consegui ler a lista de aplicativos.' };
    if (refuseIfRunning && data.current_app) return { ok: true, skipped: true, running: true, current: data.current_app };
    if (app.uuid && (data.apps || []).some((a) => a.uuid === app.uuid)) return { ok: true, skipped: true };
    return outcome(await api('POST', '/api/apps', app), MSG.save);
  });
}
export const removeApp = (uuid) => serialize(async () => outcome(await api('POST', '/api/apps/delete', { uuid }), MSG.remove));
export const reorderApps = (order) => serialize(async () => outcome(await api('POST', '/api/apps/reorder', { order }), MSG.reorder));
export const launchApp = (uuid) => serialize(async () => outcome(await api('POST', '/api/apps/launch', { uuid }), MSG.launch));
export const closeApp = () => serialize(async () => outcome(await api('POST', '/api/apps/close', {}), MSG.close));
/** Envia uma capa (PNG em base64). key = uuid do app: a mesma chave sobrescreve o arquivo em vez de acumular capas. Não grava apps.json. */
export async function uploadCover(key, base64) {
  const r = await api('POST', '/api/covers/upload', { key, data: base64 });
  const path = r.json?.path;
  if (okResp(r) && typeof path === 'string' && path) { invalidateCover(path); return { ok: true, path }; }
  return { ok: false, error: MSG.cover + describeApiError(r) };
}

/* ---------- Política dos jogos detectados (funções puras) ---------- */
/** Partes da política: ligar encerrar-ao-pausar e tela virtual, fechar o jogo ao fim (--close-dir) e abrir pelo comando detectado. */
export const POLICY_FLAGS = ['terminate-on-pause', 'virtual-display'];
export const isCloseDirCmd = (cmd) => /--close-dir\b/i.test(String(cmd || ''));
/** Compara comandos sem ligar para maiúsculas nem espaços repetidos (caminhos do Windows não diferenciam maiúsculas). */
export const sameCmdText = (a, b) => String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Este comando de "detached" é o que o scanner gera para abrir ESTE jogo (mesmo que o caminho do launcher tenha mudado)? */
export function isManagedLaunch(cmd, det) {
  const c = String(cmd || '');
  const want = Array.isArray(det?.app?.detached) ? det.app.detached[0] : null;
  if (want && sameCmdText(c, want)) return true;
  const id = det?.id === undefined || det?.id === null ? '' : String(det.id);
  if (!id) return false;
  const e = escapeRe(id);
  switch (det.source) {
    case 'steam': return new RegExp(`steam://rungameid/${e}(?!\\d)`, 'i').test(c) || new RegExp(`--launch-steam\\s+${e}(?!\\d)`, 'i').test(c) || new RegExp(`-applaunch\\s+${e}(?!\\d)`, 'i').test(c);
    case 'epic': return /com\.epicgames\.launcher:\/\/apps\//i.test(c) && new RegExp(`%3A${e}(?:[?&#]|$)`, 'i').test(c);
    case 'ubisoft': return new RegExp(`uplay://launch/${e}(?:/|$)`, 'i').test(c);
    default: return false;
  }
}

/**
 * Aplica a política ao aplicativo `app` de um jogo detectado `detected` ({source,id,name,uuid,app}).
 * Devolve o app novo, ou null se NADA muda (idempotente: rodar duas vezes não regrava).
 * Só mexe em: terminate-on-pause, virtual-display, no item "--close-dir" do prep-cmd e no comando de abertura em detached.
 * Os outros campos e os outros itens das listas ficam como o usuário deixou. `skip` = partes que o usuário desligou de propósito:
 * 'terminate-on-pause', 'virtual-display', 'close-dir', 'detached' ('cover' também fica na lista, mas só a busca de capas olha para ela).
 */
export function policyUpdate(app, detectedRaw, { skip = [] } = {}) {
  if (!isObj(app) || !isObj(detectedRaw?.app)) return null;
  const detected = { ...detectedRaw, app: sanitizeInterpolations(detectedRaw.app) };   // nunca grava um "$(" sem ")"
  const off = new Set(skip || []);
  const next = { ...app };

  for (const f of POLICY_FLAGS) if (!off.has(f) && next[f] !== true) next[f] = true;

  if (!off.has('close-dir')) {
    const want = (Array.isArray(detected.app['prep-cmd']) ? detected.app['prep-cmd'] : []).find((c) => isCloseDirCmd(c?.undo));
    if (want) {
      const list = Array.isArray(app['prep-cmd']) ? app['prep-cmd'] : [];
      const mine = list.filter((c) => isCloseDirCmd(c?.undo));
      if (!(mine.length === 1 && sameCmdText(mine[0].undo, want.undo))) {
        const out = [];
        let placed = false;
        for (const c of list) {
          if (!isCloseDirCmd(c?.undo)) { out.push(c); continue; }
          if (!placed) { out.push({ do: '', undo: want.undo, elevated: false }); placed = true; }   // troca no mesmo lugar; duplicatas somem
        }
        if (!placed) out.push({ do: '', undo: want.undo, elevated: false });   // por último: o "undo" roda primeiro e fecha o jogo antes dos demais
        next['prep-cmd'] = out;
      }
    }
  }

  if (!off.has('detached')) {
    const want = Array.isArray(detected.app.detached) ? detected.app.detached[0] : null;
    if (typeof want === 'string' && want) {
      const ds = Array.isArray(app.detached) ? app.detached : [];
      const out = [];
      let placed = false;
      for (const c of ds) {
        if (typeof c === 'string' && isManagedLaunch(c, detected)) {
          if (!placed) { out.push(sameCmdText(c, want) ? c : want); placed = true; }
          continue;
        }
        out.push(c);
      }
      if (!placed) out.unshift(want);
      if (!deepEqual(out, ds)) next.detached = out;
    }
  }
  return deepEqual(next, app) ? null : next;
}

/**
 * Depois de o usuário salvar uma edição, descobre quais partes da política ele desligou de propósito (para a busca não religar).
 * Só conta o que ele MUDOU nesta edição: um app antigo sem a política, salvo só com outro nome, continua recebendo a política.
 * `original` e `edited` são apps normalizados; `prev` = lista atual de partes desligadas.
 */
export function optOutAfterEdit(prev, original, edited, detected) {
  const skip = new Set(prev || []);
  for (const f of POLICY_FLAGS) {
    if (!!original?.[f] === !!edited?.[f]) continue;
    if (edited?.[f] === true) skip.delete(f); else skip.add(f);
  }
  const has = (a) => (Array.isArray(a?.['prep-cmd']) ? a['prep-cmd'] : []).some((c) => isCloseDirCmd(c?.undo));
  if (has(original) !== has(edited)) { if (has(edited)) skip.delete('close-dir'); else skip.add('close-dir'); }
  const want = Array.isArray(detected?.app?.detached) ? detected.app.detached[0] : null;
  const dOld = Array.isArray(original?.detached) ? original.detached : [];
  const dNew = Array.isArray(edited?.detached) ? edited.detached : [];
  if (want && !deepEqual(dOld, dNew)) { if (dNew.some((c) => sameCmdText(c, want))) skip.delete('detached'); else skip.add('detached'); }
  // capa: quem tira a capa de propósito não quer que a busca baixe outra; escolher uma capa de novo religa
  const img = (a) => String(a?.['image-path'] || '').trim();
  if (img(original) && !img(edited)) skip.add('cover');
  else if (!img(original) && img(edited)) skip.delete('cover');
  return [...skip];
}

/**
 * Decide o que gravar numa busca: jogos novos (menos os removidos pelo usuário, salvo busca manual) e ajustes de política.
 * Puro: não grava nada.
 */
export function planDetection({ apps, found, dismissed = [], optOut = {}, manual = false } = {}) {
  const have = new Map((apps || []).map((a) => [a.uuid, a]));
  const removed = new Set(dismissed || []);
  const seen = new Set();
  const toAdd = [];
  const toUpdate = [];
  const revived = [];
  for (const g of found || []) {
    if (!g || typeof g.uuid !== 'string' || !isObj(g.app) || seen.has(g.uuid)) continue;
    seen.add(g.uuid);
    const cur = have.get(g.uuid);
    if (!cur) {
      if (removed.has(g.uuid) && !manual) continue;
      toAdd.push(g);
      if (removed.has(g.uuid)) revived.push(g.uuid);
    } else {
      const next = policyUpdate(cur, g, { skip: optOut?.[g.uuid] });
      if (next) toUpdate.push({ uuid: g.uuid, game: g, next });
    }
  }
  return { toAdd, toUpdate, revived };
}
/** O objeto que vai no POST de um jogo novo: o que o scanner montou, com uuid garantido e sem chaves de execução. */
export function appForAdd(g) {
  const app = sanitizeInterpolations(deepClone(g.app));
  for (const k of RUNTIME_KEYS) delete app[k];
  if (!app.uuid) app.uuid = g.uuid;
  return app;
}
/** Mensagem do resultado de uma busca manual. */
export function detectionMessage({ found = 0, added = 0, updated = 0, failed = 0, error = '', declined = false } = {}) {
  if (error) return { text: error, kind: 'err' };
  if (declined) return { text: 'Nada foi alterado.', kind: '' };
  if (failed) return { text: `Não consegui gravar ${plural(failed, 'jogo', 'jogos')}. Tente de novo.`, kind: 'err' };
  if (!found) return { text: 'Nenhum jogo encontrado neste PC. O R3D PLAY procura jogos instalados da Steam, Epic, GOG e Ubisoft.', kind: '' };
  const ajustados = updated ? ` ${plural(updated, 'jogo foi ajustado', 'jogos foram ajustados')}.` : '';
  if (added) return { text: `${plural(added, 'jogo novo adicionado', 'jogos novos adicionados')}.${ajustados}`, kind: 'ok' };
  return { text: `${plural(found, 'jogo encontrado', 'jogos encontrados')}, nenhum novo.${ajustados}`, kind: 'ok' };
}

/* ---------- Jogos detectados (memória desta janela + origem no localStorage) ---------- */
const detected = new Map();   // uuid -> jogo da última busca
let sourcesCache = null;
const sourceMap = () => (sourcesCache ??= store.read(KEYS.sources, {}));
export const getDetected = (uuid) => detected.get(uuid) || null;
/** Este aplicativo veio da detecção de jogos (nesta janela ou numa abertura anterior)? */
export const isDetectedGame = (uuid) => detected.has(uuid) || !!sourceMap()[uuid];
/** Origem de um aplicativo para o filtro: scanner > palpite pelos comandos > "other". */
export const sourceForApp = (app) => sourceOf(app, detected.get(app?.uuid)?.source || sourceMap()[app?.uuid]);
function rememberDetected(games) {
  const map = sourceMap();
  let changed = false;
  for (const g of games) {
    detected.set(g.uuid, g);
    const s = knownSource(g.source);
    if (s && map[g.uuid] !== s) { map[g.uuid] = s; changed = true; }
  }
  if (changed) store.write(KEYS.sources, map);
}
const validGame = (g) => isObj(g) && typeof g.uuid === 'string' && g.uuid && isObj(g.app) && typeof g.app.name === 'string';
/**
 * Jogo da busca pronto para gravar, ou null se malformado. Nome e pasta vêm da loja e do disco, não de quem usa o painel:
 * um "$(" sem ")" ali faria o servidor perder TODOS os aplicativos ao carregar, então os "$" são escapados (ver safeInterpolation).
 */
export function prepareGame(g) {
  if (!validGame(g)) return null;
  const app = sanitizeInterpolations(g.app);
  // (sem a ponte nativa, como nos testes de lógica pura, log() rejeitaria uma promessa sem dono)
  if (!deepEqual(app, g.app) && globalThis.window?.chrome?.webview) log(`jogo "${g.name || g.app.name}": símbolo "$" escapado nos comandos para o servidor conseguir ler`);
  return { ...g, app };
}

/* Removidos pelo usuário e partes da política desligadas no editor */
export const getDismissed = () => store.read(KEYS.dismissed, []);
export function rememberDismissed(uuid) {
  const list = getDismissed();
  if (!list.includes(uuid)) store.write(KEYS.dismissed, [...list, uuid]);
}
function forgetDismissed(uuids) {
  if (!uuids.length) return;
  store.write(KEYS.dismissed, getDismissed().filter((u) => !uuids.includes(u)));
}
export const getOptOutAll = () => store.read(KEYS.optOut, {});
export const getOptOut = (uuid) => getOptOutAll()[uuid] || [];
export function setOptOut(uuid, parts) {
  const all = getOptOutAll();
  if (parts.length) all[uuid] = parts; else delete all[uuid];
  store.write(KEYS.optOut, all);
}

/* ---------- Capas ---------- */
export const COVER_RETRY_MS = { noCover: 7 * 24 * 3600 * 1000, failure: 3600 * 1000 };
/** Vale tentar baixar a capa deste app agora? (só quem não tem imagem e não foi tentado há pouco). Puro. */
export function shouldTryCover(app, tried, now = Date.now()) {
  if (!app || String(app['image-path'] || '').trim()) return false;
  return now >= (Number(tried?.[app.uuid]) || 0);
}
/** Caminho lido pelo app nativo: só um .png dentro de uma pasta "covers" com caminho completo (o resto é imagem interna do servidor). */
export function coverPathOf(app) {
  const p = String(app?.['image-path'] || '').trim().replace(/\\/g, '/');
  return /^(?:[A-Za-z]:)?\/.*\/covers\/[^/]+\.png$/i.test(p) ? p : '';
}
const covers = new Map();   // caminho -> { url, at, promise }
/** Capa já lida (síncrono) ou ''. */
export function peekCover(app) { const p = coverPathOf(app); return (p && covers.get(p)?.url) || ''; }
/** Lê a capa pelo app nativo (data URL), com cache; falha vira '' e só é tentada de novo depois de 30 s. */
export function loadCover(app) {
  const p = coverPathOf(app);
  if (!p) return Promise.resolve('');
  const hit = covers.get(p);
  if (hit) {
    if (hit.promise) return hit.promise;
    if (hit.url || Date.now() - hit.at < 30000) return Promise.resolve(hit.url);
  }
  const entry = { url: '', at: Date.now(), promise: null };
  entry.promise = Promise.resolve(native('readCover', { path: p }))
    .then((r) => { entry.url = r?.data ? `data:image/png;base64,${r.data}` : ''; return entry.url; })
    .catch(() => '')
    .finally(() => { entry.at = Date.now(); entry.promise = null; });
  covers.set(p, entry);
  return entry.promise;
}
/** Esquece a capa guardada (o arquivo foi sobrescrito). Aceita app ou caminho. */
export function invalidateCover(pathOrApp) {
  const p = typeof pathOrApp === 'string' ? String(pathOrApp).trim().replace(/\\/g, '/') : coverPathOf(pathOrApp);
  covers.delete(p);
}

let coversBusy = false;
/** Quanto esperar antes de pedir de novo a capa de quem veio sem nada. Puro. O app nativo devolve "sem capa" tanto para "este jogo não tem"
 *  quanto para "sem internet": só confiamos no prazo longo quando outra capa do mesmo lote veio (a rede funcionou). */
export function emptyCoverWait(gotAny, online = true) {
  return gotAny && online !== false ? COVER_RETRY_MS.noCover : COVER_RETRY_MS.failure;
}
/**
 * Baixa a capa dos jogos detectados que ainda não têm imagem, envia ao servidor e grava o image-path.
 * Não faz nada com transmissão ativa (gravar a encerraria). Devolve quantas capas novas foram gravadas.
 * force: ignora o prazo de espera (busca manual: a pessoa pediu agora). Quem tirou a capa de propósito no editor nunca é tentado.
 */
export async function syncCovers({ force = false } = {}) {
  if (coversBusy) return 0;
  const tried = store.read(KEYS.tried, {});
  const todo = state.apps.filter((a) => detected.has(a.uuid) && !getOptOut(a.uuid).includes('cover') && shouldTryCover(a, force ? {} : tried));
  if (todo.length && state.currentApp) { pendingSync = true; return 0; }   // gravar a capa encerraria a transmissão: fica para depois
  if (!todo.length) return 0;
  coversBusy = true;
  let done = 0;
  const empty = [];      // sem capa neste lote (sem rede ou sem capa: só sabemos depois de ver o lote todo)
  let gotAny = false;
  try {
    for (const app of todo) {
      const g = detected.get(app.uuid);
      let c = null;
      try { c = await native('cover', { source: g.source, gameId: g.id, name: g.name }); } catch { /* sem capa */ }
      if (!c?.data) { empty.push(app.uuid); continue; }
      gotAny = true;
      const up = await uploadCover(app.uuid, c.data);
      if (!up.ok) { log(`capa de ${g.name}: ${up.error}`); tried[app.uuid] = Date.now() + COVER_RETRY_MS.failure; continue; }
      const w = await mutateApp(app.uuid, (cur) => (String(cur['image-path'] || '').trim() ? null : { ...cur, 'image-path': up.path }), { refuseIfRunning: true });
      if (w.running) { pendingSync = true; break; }
      if (!w.ok) { log(`capa de ${g.name}: ${w.error}`); tried[app.uuid] = Date.now() + COVER_RETRY_MS.failure; continue; }
      if (!w.skipped) done++;
      if (done && done % 4 === 0) await loadApps();   // a grade vai ganhando capas aos poucos
    }
    const wait = emptyCoverWait(gotAny, typeof navigator === 'undefined' ? true : navigator.onLine);
    for (const u of empty) tried[u] = Date.now() + wait;
    store.write(KEYS.tried, tried);
    if (done) await loadApps();
  } catch (e) { log(`syncCovers: ${e}`); } finally { coversBusy = false; }
  return done;
}

/* ---------- Detecção de jogos ---------- */
let pendingSync = false;   // havia o que gravar mas existia transmissão: tenta de novo quando ela acabar
let retryHooked = false;
let inflight = null;

function hookRetry() {
  if (retryHooked) return;
  retryHooked = true;
  bus.on('apps', () => {
    if (!pendingSync || state.currentApp || inflight) return;
    pendingSync = false;
    detectGames({ manual: false }).catch((e) => log(`autoSync pendente: ${e}`));
  });
}

async function runDetection(manual) {
  const res = { found: 0, added: 0, updated: 0, failed: 0, error: '', declined: false, deferred: false };
  let scan;
  try { scan = await native('scan'); } catch (e) { scan = { error: String(e) }; }
  if (!Array.isArray(scan?.games)) { log(`scan: ${scan?.error || 'resposta inválida'}`); res.error = 'Não consegui procurar os jogos neste PC.'; return res; }
  const games = scan.games.map(prepareGame).filter(Boolean);
  res.found = games.length;
  rememberDetected(games);

  if (!(await loadApps())) { res.error = 'O R3D PLAY não está respondendo. Tente de novo em instantes.'; return res; }
  const plan = planDetection({ apps: state.apps, found: games, dismissed: getDismissed(), optOut: getOptOutAll(), manual });
  const writes = plan.toAdd.length + plan.toUpdate.length;

  // Toda gravação encerra a transmissão. A automática nunca derruba uma; a manual pergunta (uma vez) e só então grava sem trava.
  let mayStop = false;
  const askStop = async (uuid) => {
    const nome = state.apps.find((a) => a.uuid === uuid)?.name || 'um jogo';
    mayStop = await ui.confirm(`Há uma transmissão em andamento (${nome}). Para atualizar a lista de jogos, o R3D PLAY precisa encerrá-la. Continuar?`, 'Encerrar e atualizar', { title: 'Transmissão em andamento' });
    if (!mayStop) res.declined = true;
    return mayStop;
  };
  if (writes && state.currentApp) {
    if (!manual) { pendingSync = true; res.deferred = true; return res; }
    if (!(await askStop(state.currentApp))) return res;
  }
  // A conferência "tem transmissão?" também roda DENTRO da fila de gravações: um jogo iniciado depois da pergunta acima
  // (ou enquanto a busca esperava a vez) é pego aqui, e a manual pergunta de novo em vez de derrubá-lo sem aviso.
  const write = async (run) => {
    let r = await run({ refuseIfRunning: !mayStop });
    if (r.running && manual && !mayStop) {
      if (!(await askStop(r.current))) return null;
      r = await run({ refuseIfRunning: false });
    }
    return r;
  };
  for (const g of plan.toAdd) {
    const r = await write((guard) => addApp(appForAdd(g), guard));
    if (!r) break;
    if (r.running) { pendingSync = true; res.deferred = true; break; }
    if (!r.ok) { res.failed++; log(`adicionar ${g.name}: ${r.error}`); } else if (!r.skipped) res.added++;
  }
  if (!res.deferred && !res.declined) {
    for (const u of plan.toUpdate) {
      const r = await write((guard) => mutateApp(u.uuid, (cur) => policyUpdate(cur, u.game, { skip: getOptOut(u.uuid) }), guard));
      if (!r) break;
      if (r.running) { pendingSync = true; res.deferred = true; break; }
      if (!r.ok) { if (!r.gone) { res.failed++; log(`ajustar ${u.game.name}: ${r.error}`); } } else if (!r.skipped) res.updated++;
    }
  }
  if (res.declined && (res.added || res.updated)) res.declined = false;   // já gravou parte: o resumo conta o que foi feito
  forgetDismissed(plan.revived);
  await loadApps();
  if (!res.deferred && !res.declined) await syncCovers({ force: manual });
  return res;
}

/**
 * Procura jogos no PC, adiciona os novos e aplica a política. manual=true mostra o resultado em um aviso.
 * Devolve { found, added } (e extras: updated, failed, error, declined, deferred).
 */
export async function detectGames({ manual = false } = {}) {
  hookRetry();
  let prev = null;
  if (inflight) {
    prev = await inflight.catch(() => null);
    if (!manual) return prev || { found: 0, added: 0 };
  }
  const p = runDetection(manual);
  inflight = p;
  let res;
  try { res = await p; } catch (e) { log(`detectGames: ${e}`); res = { found: 0, added: 0, updated: 0, failed: 0, error: 'Não consegui procurar os jogos neste PC.', declined: false, deferred: false }; } finally { if (inflight === p) inflight = null; }
  if (prev) res = { ...res, added: res.added + prev.added, updated: res.updated + prev.updated };
  if (manual) { const m = detectionMessage(res); ui.toast(m.text, m.kind); }
  return res;
}
/** Busca silenciosa (o main.js chama depois do login). Nunca derruba transmissão e nunca mostra aviso. */
export const autoSync = () => detectGames({ manual: false });

/** Só para os testes: limpa a memória do módulo. */
export function _resetForTests() {
  detected.clear(); covers.clear(); sourcesCache = null; pendingSync = false; coversBusy = false; inflight = null; chain = Promise.resolve();
}
export const _pending = () => pendingSync;
