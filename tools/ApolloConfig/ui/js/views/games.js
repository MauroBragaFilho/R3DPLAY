// Tela Jogos: grade de capas com busca e filtro por origem, AO VIVO, iniciar/encerrar, editar, excluir, reordenar
// (arrastar e soltar + botões de teclado), detecção de jogos e editor de aplicativo.
// Toda regra de dados fica em js/lib/appmodel.js (puro) e js/lib/library.js (servidor); aqui só interface.
import { h, icon, state, bus, toast, confirmDlg, loadApps, sleep, nativeFiles } from '../core.js';
import * as M from '../lib/appmodel.js';
import { detectGames, sourceForApp, isDetectedGame, peekCover, loadCover, launchApp, closeApp, removeApp, reorderApps, rememberDismissed } from '../lib/library.js';
import { openAppEditor } from '../lib/appeditor.js';
import { hasFiles } from '../lib/programs.js';
import { probeFolderDrop, dropHint, loadInstalled } from '../lib/addwizard.js';

const FILTERS = [['all', 'Todos'], ...M.SOURCE_KEYS.map((k) => [k, M.SOURCE_LABELS[k]])];

let root = null;
const els = {};
let visible = false;
let loadState = 'loading';        // loading | ready | error
let loadError = '';
let query = '';
let source = 'all';
let pendingOrder = null;          // uuid[] com a ordem ainda não salva
let busyUuid = '';                // card em ação (iniciar/encerrar/excluir)
let working = false;              // ação longa em andamento (detectar, salvar ordem)
let dragUuid = '';
let lastSig = '';
let queued = false;
let offs = [];
let dropOffs = [];               // ouvintes de arrastar e soltar arquivos (só com a tela aberta)
let dropShown = false;
let focusAfter = null;            // chaves de foco (data-fk) a restaurar depois do próximo desenho
let activeUuid = '';              // card com os botões na ordem do Tab (os demais ficam só nas setas: senão são ~5 paradas por jogo)
let lastMoved = '';               // último card movido: para onde o foco volta quando a barra "Ordem alterada" some

/* ---------- Dados derivados ---------- */
const orderIds = (list) => list.map((a) => a.uuid);
/** Só apps com uuid (o servidor ignora os sem uuid; sem ele não dá para iniciar, editar nem reordenar). */
const serverList = () => state.apps.filter((a) => a && typeof a.uuid === 'string' && a.uuid);
const currentList = () => M.orderedApps(serverList(), pendingOrder);
const canReorder = () => state.online && loadState === 'ready' && !working && serverList().length > 1 && !query.trim() && source === 'all';
const orderDirty = () => !!pendingOrder && !M.sameOrder(orderIds(currentList()), orderIds(serverList()));
const appName = (uuid) => serverList().find((a) => a.uuid === uuid)?.name || '';
/** Há alguma ação que grava no servidor em andamento? (detectar, salvar ordem, iniciar/encerrar/remover) */
const isBusy = () => working || !!busyUuid;

/* ---------- Foco do teclado ----------
   Todo desenho recria os botões; sem cuidado o foco cairia no <body> e a pessoa teria de voltar ao topo com Tab.
   Cada botão que importa tem data-fk ("chave de foco"); antes de redesenhar guardamos a do botão focado e depois a reaplicamos. */
const cardKeys = (uuid, act) => [`card:${uuid}:${act}`, `card:${uuid}:*`];
function captureFocus() {
  const ae = document.activeElement;
  const k = ae?.dataset?.fk;
  if (!k || !root.contains(ae)) return null;
  return k.startsWith('card:') ? [k, `${k.slice(0, k.lastIndexOf(':'))}:*`] : [k];
}
/** Foca a primeira chave que existir e estiver habilitada ("card:<uuid>:*" = qualquer botão daquele card). */
function applyFocus(keys, opts) {
  for (const k of keys || []) {
    const sel = k.endsWith(':*') ? `[data-fk^="${CSS.escape(k.slice(0, -1))}"]` : `[data-fk="${CSS.escape(k)}"]`;
    const el = root.querySelector(`${sel}:not([disabled])`);
    if (el) { el.focus(opts); return true; }
  }
  return false;
}
/** Depois de uma ação: se o foco se perdeu (foi para o <body>), devolve ao botão de origem ou, se ele sumiu, às chaves. */
function refocus(origin, keys) {
  const cur = document.activeElement;
  if (cur && cur !== document.body && cur !== root && !cur.disabled) return;
  if (origin?.isConnected && !origin.disabled && root.contains(origin)) { origin.focus(); return; }
  applyFocus(keys);
}

/* ---------- Montagem ---------- */
function mount(r) {
  root = r;
  root.classList.add('gm');
  els.search = h('input', { type: 'search', placeholder: 'Buscar jogo…', 'aria-label': 'Buscar jogo ou aplicativo', autocomplete: 'off', dataset: { fk: 'search' }, on: { input: () => { query = els.search.value; render(); } } });
  els.filters = h('div', { class: 'seg gm-filters', role: 'group', 'aria-label': 'Filtrar por origem' });
  els.sort = h('button', { class: 'btn ghost gm-sort', type: 'button', title: 'Ordenar de A a Z', 'aria-label': 'Ordenar de A a Z', on: { click: sortAZ } }, icon('sort_by_alpha'));
  els.detect = h('button', { class: 'btn', type: 'button', on: { click: () => runDetect() } }, icon('travel_explore'), 'Detectar jogos');
  els.add = h('button', { class: 'btn primary', type: 'button', on: { click: () => addNew() } }, icon('add'), 'Adicionar aplicativo');
  els.live = h('div', { class: 'banner gm-live', role: 'status', hidden: true });
  els.alert = h('div', { class: 'banner warn', role: 'status', hidden: true });
  els.count = h('p', { class: 'gm-count' });
  els.hint = h('p', { class: 'f-help gm-hint' });
  els.state = h('div', { hidden: true });
  els.grid = h('div', { class: 'games gm-grid', role: 'list', 'aria-label': 'Jogos e aplicativos' });
  els.savebar = h('div', { class: 'savebar gm-savebar', role: 'region', 'aria-label': 'Ordem alterada', hidden: true });
  els.sr = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  els.dropText = h('span', { text: dropHint() });
  els.drop = h('div', { class: 'gm-drop', 'aria-hidden': 'true', hidden: true },
    h('div', { class: 'gm-drop-box' }, icon('upload_file'), h('strong', { text: 'Solte aqui para adicionar' }), els.dropText));

  root.append(
    h('div', { class: 'toolbar gm-toolbar' },
      h('div', { class: 'search' }, icon('search'), els.search),
      els.filters,
      h('div', { class: 'gm-tools' }, els.sort, els.detect, els.add)),
    els.alert, els.live,
    h('div', { class: 'gm-meta' }, els.count, els.hint),
    els.state, els.grid, els.savebar, els.sr, els.drop);

  root.addEventListener('click', onClick);
  els.grid.addEventListener('focusin', (e) => { const c = e.target.closest?.('.gm-card'); if (c) setActive(c.dataset.uuid); });
  els.grid.addEventListener('keydown', onGridKey);
  els.grid.addEventListener('dragstart', onDragStart);
  els.grid.addEventListener('dragover', onDragOver);
  els.grid.addEventListener('dragleave', (e) => { if (!els.grid.contains(e.relatedTarget)) clearMarks(); });
  els.grid.addEventListener('drop', onDrop);
  els.grid.addEventListener('dragend', endDrag);
}

let warmed = false;
/** Lê a lista de programas instalados uma vez por sessão, em segundo plano (a leitura roda fora da interface no app nativo). */
function warmInstalled() {
  if (warmed) return;
  warmed = true;
  setTimeout(() => { loadInstalled().catch(() => { /* a janela de adicionar tenta de novo e mostra o erro lá */ }); }, 1500);
}

async function show(params = {}) {
  visible = true;
  if (loadState === 'loading' && serverList().length) loadState = 'ready';   // o main.js já carregou a lista: mostra já e atualiza por baixo
  // o main.js pode chamar show() de novo sem hide() (voltar do "servidor fora do ar", clicar na aba aberta): não acumula ouvintes
  offs.forEach((off) => off());
  offs = [
    bus.on('apps', () => { if (loadState !== 'ready') { loadState = 'ready'; loadError = ''; } schedule(); }),
    bus.on('online', schedule),
  ];
  hookDrop();
  probeFolderDrop();   // (sem esperar) o aviso "Solte aqui" só cita a pasta do jogo se o app nativo sabe lê-la
  warmInstalled();     // (sem esperar) a 1ª leitura dos programas instalados pode levar alguns segundos: deixa pronta antes do clique
  lastSig = '';
  render();
  await refresh();
  if (params.focus === 'search') els.search.focus();
  if (params.detect) runDetect();
  if (params.add) addNew();
}
function hide() {
  visible = false;
  offs.forEach((off) => off());
  offs = [];
  unhookDrop();
}
/** Não deixa sair com uma ordem nova sem salvar sem perguntar. */
async function canLeave() {
  if (!orderDirty()) return true;
  if (await confirmDlg('Você mudou a ordem dos jogos e ainda não salvou. Sair e descartar a nova ordem?', 'Descartar', { title: 'Ordem não salva', no: 'Continuar aqui' })) { pendingOrder = null; return true; }
  return false;
}

/* ---------- Carregamento ---------- */
function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; if (visible) render(); });
}
async function refresh() {
  const ok = await loadApps();
  if (ok) { loadState = 'ready'; loadError = ''; }
  else if (!serverList().length) { loadState = 'error'; loadError = state.online ? 'O R3D PLAY recusou a leitura da lista.' : 'O R3D PLAY não está respondendo.'; }
  else loadState = 'ready';   // mantém a última lista conhecida; o aviso de "sem conexão" aparece no topo
  lastSig = '';
  if (visible) render();
}
/** Depois de iniciar um jogo, o servidor leva um instante para marcar "AO VIVO": relê duas vezes. */
async function refreshSoon() {
  for (const ms of [1200, 3500]) { await sleep(ms); if (!visible) return; await refresh(); }
}

/* ---------- Desenho ---------- */
function render() {
  if (!root) return;
  if (pendingOrder && !orderDirty()) pendingOrder = null;
  const all = currentList();
  if (source !== 'all' && !all.some((a) => sourceForApp(a) === source)) source = 'all';
  const list = M.filterApps(all, { query, source, sourceOf: sourceForApp });
  const reorder = canReorder();
  const dirty = orderDirty();
  const sig = JSON.stringify([loadState, loadError, state.online, query, source, state.currentApp, busyUuid, working, reorder, dirty,
    all.map((a) => [a.uuid, a.name, a['image-path'], sourceForApp(a)])]);
  if (sig === lastSig) return;
  lastSig = sig;

  const want = focusAfter || captureFocus();
  focusAfter = null;
  if (!list.some((a) => a.uuid === activeUuid)) activeUuid = list[0]?.uuid || '';

  paintFilters(all);
  paintBanners();
  paintBody(all, list, reorder);
  paintSavebar(dirty);
  els.detect.disabled = !state.online || isBusy();
  els.add.disabled = !state.online || isBusy();
  els.sort.hidden = !reorder;
  els.hint.textContent = hintText(all, reorder);

  if (want) applyFocus(want);
}

function hintText(all, reorder) {
  if (!all.length || loadState !== 'ready') return '';
  const base = 'Passe o mouse sobre uma capa (ou use o Tab) para iniciar o jogo neste PC, editar ou remover. Salvar qualquer alteração aqui encerra a transmissão em andamento. '
    + 'No celular, a lista só atualiza depois de reabrir o R3D LAUNCHER. Para adicionar um programa, arraste o arquivo .exe dele para esta janela.';
  if (reorder) return `${base} Para mudar a ordem, arraste as capas ou use os botões < e > de cada uma.`;
  if (serverList().length > 1 && (query.trim() || source !== 'all')) return `${base} Para reordenar, limpe a busca e o filtro.`;
  return base;
}

function paintFilters(all) {
  const counts = {};
  for (const a of all) { const k = sourceForApp(a); counts[k] = (counts[k] || 0) + 1; }
  const used = Object.keys(counts).length;
  els.filters.hidden = used < 2;
  els.filters.replaceChildren(...FILTERS
    .filter(([k]) => k === 'all' || counts[k])
    .map(([k, label]) => h('button', {
      type: 'button', 'aria-pressed': String(source === k), class: source === k ? 'on' : '', dataset: { fk: `filter:${k}` },
      on: { click: () => { source = k; render(); } },
    }, label, h('span', { class: 'gm-n', text: k === 'all' ? all.length : counts[k] }))));
}

function paintBanners() {
  const offline = !state.online && loadState === 'ready';   // sem lista nenhuma, quem avisa é a mensagem de erro
  els.alert.hidden = !offline;
  els.alert.replaceChildren(...(offline ? [icon('cloud_off'), 'O R3D PLAY não está respondendo. Você vê a última lista conhecida; as ações que alteram a lista ficam desativadas até ele voltar.'] : []));
  const live = state.currentApp;
  els.live.hidden = !live;
  els.live.replaceChildren();
  if (live) {
    els.live.append(icon('sensors'),
      h('span', { class: 'grow' }, 'Transmitindo agora: ', h('strong', { text: appName(live) || 'um aplicativo' })),
      h('button', { class: 'btn danger', type: 'button', disabled: !state.online || isBusy(), dataset: { act: 'stop-live', fk: 'live:stop' } }, icon('stop'), 'Encerrar'));
  }
}

function placeholderEl(app) {
  const p = M.placeholderFor(app);
  return p.kind === 'icon' ? icon(p.name, 'big') : h('span', { class: 'letter', text: p.text });
}
const coverImg = (url) => { const img = h('img', { src: url, alt: '', decoding: 'async', draggable: 'false' }); img.addEventListener('error', () => img.remove()); return img; };

function paintBody(all, list, reorder) {
  els.state.hidden = true;
  els.grid.hidden = false;
  els.count.textContent = '';
  if (loadState === 'loading') {
    els.grid.setAttribute('aria-busy', 'true');
    els.grid.replaceChildren(...Array.from({ length: 8 }, () => h('div', { class: 'game gm-skel', 'aria-hidden': 'true' },
      h('div', { class: 'cover skeleton' }), h('div', { class: 'skeleton gm-skel-line' }), h('div', { class: 'skeleton gm-skel-line short' }))));
    return;
  }
  els.grid.removeAttribute('aria-busy');
  if (loadState === 'error') {
    els.grid.hidden = true;
    els.state.hidden = false;
    els.state.replaceChildren(h('div', { class: 'banner bad', role: 'alert' }, icon('error'),
      h('div', { class: 'grow' }, h('strong', { text: 'Não consegui carregar a lista de jogos. ' }), loadError, ' Confira o ícone do R3D PLAY na bandeja do Windows e tente de novo.'),
      h('button', { class: 'btn', type: 'button', dataset: { act: 'retry', fk: 'state:retry' } }, icon('refresh'), 'Tentar de novo')));
    return;
  }
  if (!all.length) {
    els.grid.hidden = true;
    els.state.hidden = false;
    els.state.replaceChildren(h('div', { class: 'empty gm-empty-state' }, icon('sports_esports'),
      h('h2', { text: 'Sua lista de jogos está vazia' }),
      h('p', { text: 'Clique em "Detectar jogos" para o R3D PLAY encontrar sozinho os jogos da Steam, Epic, GOG e Ubisoft instalados neste PC.' }),
      h('p', { text: 'Para qualquer outro jogo ou programa, use "Adicionar aplicativo": você escolhe na lista de programas instalados ou aponta o arquivo .exe do jogo.' }),
      h('div', { class: 'row-actions gm-center' },
        h('button', { class: 'btn primary', type: 'button', disabled: !state.online || isBusy(), dataset: { act: 'detect', fk: 'state:detect' } }, icon('travel_explore'), 'Detectar jogos'),
        h('button', { class: 'btn', type: 'button', disabled: !state.online || isBusy(), dataset: { act: 'add', fk: 'state:add' } }, icon('add'), 'Adicionar aplicativo')),
      h('p', { class: 'f-help gm-empty-tip' }, icon('upload_file'), 'Dica: você também pode arrastar o arquivo .exe do jogo para esta janela.')));
    return;
  }
  els.count.textContent = list.length === all.length ? M.plural(all.length, 'aplicativo', 'aplicativos') : `${list.length} de ${M.plural(all.length, 'aplicativo', 'aplicativos')}`;
  if (!list.length) {
    els.grid.hidden = true;
    els.state.hidden = false;
    els.state.replaceChildren(h('div', { class: 'empty gm-empty-state' }, icon('search_off'),
      h('h2', { text: 'Nada encontrado' }),
      h('p', { text: query.trim() ? `Nenhum aplicativo combina com "${query.trim()}"${source !== 'all' ? ' neste filtro' : ''}.` : 'Nenhum aplicativo neste filtro.' }),
      h('div', { class: 'row-actions gm-center' }, h('button', { class: 'btn', type: 'button', dataset: { act: 'clear', fk: 'state:clear' } }, icon('filter_alt_off'), 'Limpar busca e filtro'))));
    return;
  }
  els.grid.replaceChildren(...list.map((app) => card(app, list, reorder)));
  for (const app of list) if (!peekCover(app)) loadCover(app).then((url) => { if (url && visible) setCover(app.uuid, url); });
}

function setCover(uuid, url) {
  const cover = els.grid.querySelector(`[data-uuid="${CSS.escape(uuid)}"] .cover`);
  if (cover && !cover.querySelector('img')) cover.insertBefore(coverImg(url), cover.children[1] || null);
}

function card(app, list, reorder) {
  const live = app.uuid === state.currentApp;
  const name = app.name || 'Sem nome';
  const own = busyUuid === app.uuid;
  const off = !state.online || isBusy();   // com uma ação em andamento nenhum card aceita outra
  const i = list.findIndex((a) => a.uuid === app.uuid);
  const tab = app.uuid === activeUuid ? 0 : -1;   // só o card ativo entra na ordem do Tab; as setas andam entre os cards
  const btn = (ic, label, act, extra = {}) => h('button', {
    class: 'icon-btn', type: 'button', title: label, 'aria-label': `${label}: ${name}`, tabindex: tab, dataset: { act, fk: `card:${app.uuid}:${act}` }, disabled: off || extra.off,
  }, icon(ic));
  const url = peekCover(app);
  const cover = h('div', { class: 'cover' }, placeholderEl(app), url ? coverImg(url) : null,
    live ? h('span', { class: 'badge-live', text: 'AO VIVO' }) : null,
    // a ação principal vem primeiro na ordem do Tab; os botões de editar/remover/mover ficam depois
    h('div', { class: 'play-overlay' },
      h('button', {
        class: `btn ${live ? 'danger' : 'primary'}`, type: 'button', disabled: off, tabindex: tab,
        dataset: { act: live ? 'stop' : 'play', fk: `card:${app.uuid}:${live ? 'stop' : 'play'}` }, 'aria-label': `${live ? 'Encerrar' : 'Iniciar'}: ${name}`,
      }, icon(live ? 'stop' : 'play_arrow'), live ? 'Encerrar' : 'Iniciar')),
    h('div', { class: 'game-actions' },
      btn('edit', 'Editar', 'edit'), btn('delete', 'Remover da lista', 'del'),
      reorder ? [btn('chevron_left', 'Mover para antes', 'left', { off: i === 0 }), btn('chevron_right', 'Mover para depois', 'right', { off: i === list.length - 1 })] : null),
    own ? h('div', { class: 'gm-spin' }, h('span', { class: 'spinner' })) : null);
  return h('article', {
    class: `game gm-card${live ? ' live' : ''}`, role: 'listitem', dataset: { uuid: app.uuid }, draggable: reorder ? 'true' : null, 'aria-busy': own ? 'true' : null,
  }, cover, h('div', { class: 'game-info' }, h('strong', { title: name, text: name }), h('small', { text: M.sourceLabel(sourceForApp(app)) })));
}

function paintSavebar(dirty) {
  els.savebar.hidden = !dirty;
  els.savebar.replaceChildren();
  if (!dirty) return;
  els.savebar.append(
    h('span', { class: 'grow' }, h('strong', { text: 'Ordem alterada. ' }), 'Salve para a nova ordem valer no celular.'),
    h('button', { class: 'btn ghost', type: 'button', disabled: working, dataset: { act: 'order-undo', fk: 'bar:undo' } }, 'Desfazer'),
    h('button', { class: 'btn primary', type: 'button', disabled: working || !state.online, dataset: { act: 'order-save', fk: 'bar:save' } }, icon('save'), 'Salvar ordem'));
}

/* ---------- Teclado na grade ----------
   Os botões de um card só entram no Tab quando o card está "ativo"; as setas passam de um card para o outro (mesma ação,
   se existir). Assim chegar ao "Salvar ordem" depois de mover um jogo custa poucos Tab, não dezenas. */
function setActive(uuid) {
  if (!uuid || uuid === activeUuid) return;
  activeUuid = uuid;
  for (const c of els.grid.querySelectorAll('.gm-card')) {
    const on = c.dataset.uuid === uuid;
    c.querySelectorAll('button').forEach((b) => { b.tabIndex = on ? 0 : -1; });
  }
}
function onGridKey(e) {
  if (e.altKey || e.ctrlKey || e.metaKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  const b = e.target.closest?.('button');
  const c = b?.closest('.gm-card');
  if (!c) return;
  const cards = [...els.grid.querySelectorAll('.gm-card')];
  const i = cards.indexOf(c);
  const top = cards[0].offsetTop;
  const cols = Math.max(1, cards.filter((x) => x.offsetTop === top).length);   // quantas capas cabem em cada linha agora
  const to = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - cols, ArrowDown: i + cols, Home: 0, End: cards.length - 1 }[e.key];
  e.preventDefault();
  if (to < 0 || to >= cards.length || to === i) return;
  const next = cards[to];
  (next.querySelector(`[data-act="${b.dataset.act}"]:not([disabled])`) || next.querySelector('button:not([disabled])'))?.focus();
}

/* ---------- Ações ---------- */
async function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  const uuid = b.closest('.gm-card')?.dataset.uuid;
  const app = uuid ? serverList().find((a) => a.uuid === uuid) : null;
  if (app) {
    if (act === 'play') return withCard(app.uuid, () => doLaunch(app));
    if (act === 'stop') return withCard(app.uuid, () => doStop(app.name));
    if (act === 'edit') return doEdit(app, b);
    if (act === 'del') return doDeleteCard(app);
    if (act === 'left' || act === 'right') return moveStep(app, act === 'left' ? -1 : 1);
  }
  if (act === 'stop-live') return withCard(state.currentApp, () => doStop(appName(state.currentApp)));
  if (act === 'detect') return runDetect();
  if (act === 'add') return addNew();
  if (act === 'clear') { query = ''; source = 'all'; els.search.value = ''; focusAfter = ['search']; lastSig = ''; return render(); }
  if (act === 'retry') { loadState = 'loading'; lastSig = ''; render(); return refresh(); }
  if (act === 'order-undo') { pendingOrder = null; focusAfter = afterOrderKeys(); lastSig = ''; return render(); }
  if (act === 'order-save') return saveOrder();
}
/** Para onde o foco vai quando a barra "Ordem alterada" some: o jogo que foi movido (ou a busca). */
const afterOrderKeys = () => (lastMoved ? [...cardKeys(lastMoved, 'right'), 'search'] : ['search']);

/**
 * Marca o card como "ocupado" (spinner, botões desligados) enquanto fn roda, e SEMPRE libera.
 * `after` = chaves de foco para depois (padrão: o botão que estava focado; se ele sumiu, a busca).
 */
async function withCard(uuid, fn, { after } = {}) {
  if (isBusy()) return;
  const keep = [...(after || captureFocus() || []), 'search'];
  busyUuid = uuid || '__live';
  lastSig = '';
  render();
  try { await fn(); } catch (err) { toast(`Algo deu errado: ${err?.message || err}`, 'err'); } finally {
    busyUuid = '';
    focusAfter = keep;
    lastSig = '';
    if (visible) render();
    focusAfter = null;
  }
}

async function doLaunch(app) {
  const running = appName(state.currentApp);
  const msg = running ? `Isso vai encerrar "${running}" e iniciar "${app.name}" neste PC. Continuar?` : `Iniciar "${app.name}" neste PC agora? O jogo abre na tela do computador.`;
  if (!(await confirmDlg(msg, 'Iniciar', { danger: !!running, title: 'Iniciar aplicativo' }))) return;
  const r = await launchApp(app.uuid);
  if (!r.ok) { toast(r.error, 'err'); return; }
  toast(`Iniciando "${app.name}"…`, 'ok');
  refreshSoon();
}
async function doStop(name) {
  if (!(await confirmDlg(`Encerrar a transmissão${name ? ` de "${name}"` : ''}? O jogo será fechado.`, 'Encerrar', { title: 'Encerrar transmissão' }))) return;
  const r = await closeApp();
  if (!r.ok) { toast(r.error, 'err'); return; }
  toast('Transmissão encerrada.', 'ok');
  await refresh();
}
/** Remover pelo card: se o card some, o foco vai para o vizinho (senão cairia no <body>). */
function doDeleteCard(app) {
  const list = M.filterApps(currentList(), { query, source, sourceOf: sourceForApp });
  const i = list.findIndex((a) => a.uuid === app.uuid);
  const near = list[i + 1] || list[i - 1];
  return withCard(app.uuid, () => doDelete(app), { after: [...cardKeys(app.uuid, 'del'), ...(near ? [`card:${near.uuid}:*`] : [])] });
}
async function doDelete(app) {
  const detected = isDetectedGame(app.uuid);
  const live = !!state.currentApp;
  const msg = `Remover "${app.name}" da lista? O jogo não é desinstalado do PC.`
    + (detected ? ' Ele não volta sozinho; para trazê-lo de volta, use "Detectar jogos".' : '')
    + (live ? ' Isso também encerra a transmissão em andamento.' : '');
  if (!(await confirmDlg(msg, 'Remover', { title: 'Remover da lista' }))) return;
  const r = await removeApp(app.uuid);
  if (!r.ok) { toast(r.error, 'err'); return; }
  if (detected) rememberDismissed(app.uuid);
  if (pendingOrder) pendingOrder = pendingOrder.filter((u) => u !== app.uuid);
  toast(`"${app.name}" foi removido da lista.`, 'ok');
  await refresh();
}
async function doEdit(app, origin) {
  if (isBusy()) return;
  const r = await openAppEditor({ app });
  if (r.saved) await refresh();
  else if (r.unchanged) toast('Nenhuma alteração para salvar.');
  refocus(origin, cardKeys(app.uuid, 'edit'));
}
/** Abre "Adicionar aplicativo". dropped = promessa de nativeFiles('droppedFiles', …) quando a pessoa soltou um arquivo na tela. */
async function addNew({ dropped = null } = {}) {
  if (isBusy() || !state.online) return;
  const origin = document.activeElement;
  const r = await openAppEditor({ dropped });
  if (r.saved) {
    // o novo app entra no fim da lista: limpa busca e filtro para ele aparecer e leva a pessoa até ele
    if (query || source !== 'all') { query = ''; source = 'all'; els.search.value = ''; }
    await refresh();
    if (showNew(r.uuid)) return;   // o foco já foi para o card novo
  }
  refocus(origin, ['search']);
}
/** Rola até o app recém-criado e o destaca por um instante (a lista pode ter dezenas de jogos e o novo fica no fim). */
function showNew(uuid) {
  const c = uuid && els.grid.querySelector(`[data-uuid="${CSS.escape(uuid)}"]`);
  if (!c) return false;
  c.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  c.classList.add('gm-flash');
  setTimeout(() => c.classList.remove('gm-flash'), 2400);
  els.sr.textContent = `${appName(uuid)} foi adicionado ao fim da lista.`;
  return applyFocus(cardKeys(uuid, 'play'), { preventScroll: true });   // quem usa o teclado continua dali
}
async function runDetect() {
  if (isBusy() || !state.online) return;
  const origin = document.activeElement;
  working = true;
  lastSig = '';
  render();
  els.detect.replaceChildren(h('span', { class: 'spinner' }), 'Procurando…');
  try { await detectGames({ manual: true }); } catch (err) { toast(`Não consegui procurar os jogos: ${err?.message || err}`, 'err'); } finally {
    working = false;
    els.detect.replaceChildren(icon('travel_explore'), 'Detectar jogos');
  }
  await refresh();
  refocus(origin, ['search']);
}

/* ---------- Arrastar um arquivo para a tela ----------
   Vale para a tela inteira enquanto ela está aberta. Um arquivo solto NUNCA pode navegar a página: por isso todo arrasto de arquivos
   recebe preventDefault, mesmo quando não dá para aceitar agora. O arrasto das capas (reordenar) não traz arquivos e segue o caminho de sempre. */
const dialogOpen = () => !!document.querySelector('dialog[open]');
const canAcceptDrop = () => visible && state.online && loadState === 'ready' && !isBusy() && !dialogOpen();
function markDrop(on) {
  if (dropShown === on) return;
  dropShown = on;
  if (on) els.dropText.textContent = dropHint();
  els.drop.hidden = !on;
}
function onFileDragOver(e) {
  if (!hasFiles(e) || dialogOpen()) return;   // com uma janela aberta, quem decide é ela
  e.preventDefault();
  const ok = canAcceptDrop();
  if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? 'copy' : 'none';
  markDrop(ok);
}
function onFileDragLeave(e) { if (!e.relatedTarget) markDrop(false); }
function onFileDrop(e) {
  if (!hasFiles(e) || dialogOpen()) return;
  e.preventDefault();
  markDrop(false);
  if (!canAcceptDrop()) { if (!state.online) toast('O R3D PLAY não está respondendo. Tente de novo quando ele voltar.', 'err'); return; }
  // a ponte precisa receber os arquivos enquanto o evento ainda está ativo: nada de await antes desta linha
  const dropped = nativeFiles('droppedFiles', e.dataTransfer.files);
  dropped.catch(() => {});   // quem lê a resposta trata o erro; isto só evita um aviso de "promessa sem dono" se a janela nem chegar a abrir
  addNew({ dropped });
}
function hookDrop() {
  unhookDrop();
  const on = (t, fn) => { document.addEventListener(t, fn); return () => document.removeEventListener(t, fn); };
  dropOffs = [on('dragover', onFileDragOver), on('dragleave', onFileDragLeave), on('drop', onFileDrop), on('dragend', () => markDrop(false))];
}
function unhookDrop() {
  dropOffs.forEach((off) => off());
  dropOffs = [];
  markDrop(false);
}

/* ---------- Ordem ---------- */
function announce(app, order) {
  els.sr.textContent = `${app.name}: posição ${order.indexOf(app.uuid) + 1} de ${order.length}. Ordem alterada: depois de organizar, vá ao botão Salvar ordem.`;
}
function applyOrder(order, keys, uuid) {
  pendingOrder = order;
  if (uuid) lastMoved = uuid;
  focusAfter = keys || null;
  lastSig = '';
  render();
}
function moveStep(app, delta) {
  const order = M.stepUuid(orderIds(currentList()), app.uuid, delta);
  applyOrder(order, cardKeys(app.uuid, delta < 0 ? 'left' : 'right'), app.uuid);
  announce(app, order);
}
function sortAZ() {
  const order = orderIds(M.sortByName(currentList()));
  if (M.sameOrder(order, orderIds(currentList()))) { toast('Os aplicativos já estão em ordem alfabética.'); return; }
  applyOrder(order);
}
async function saveOrder() {
  if (isBusy()) return;
  if (state.currentApp && !(await confirmDlg(`Salvar a nova ordem encerra a transmissão em andamento${appName(state.currentApp) ? ` (${appName(state.currentApp)})` : ''}. Continuar?`, 'Salvar e encerrar', { title: 'Transmissão em andamento' }))) return;
  working = true;
  lastSig = '';
  render();
  try {
    const r = await reorderApps(orderIds(currentList()));
    if (!r.ok) toast(r.error, 'err');   // a ordem nova continua na tela, com os botões liberados, para tentar de novo ou desfazer
    else {
      toast('Ordem salva. Reabra o R3D LAUNCHER no celular para ver a nova ordem.', 'ok');
      await refresh();   // traz a ordem gravada; o render() larga a ordem pendente quando ela já é a do servidor (sem piscar a ordem antiga)
    }
  } finally {
    working = false;
    focusAfter = afterOrderKeys();
    lastSig = '';
    if (visible) render();   // sempre redesenha: sem isso, uma falha deixava os botões desativados até a próxima atualização
    focusAfter = null;
  }
}

/* Arrastar e soltar */
function clearMarks() { els.grid.querySelectorAll('.drop-before, .drop-after').forEach((c) => c.classList.remove('drop-before', 'drop-after')); }
function endDrag() { dragUuid = ''; clearMarks(); els.grid.querySelectorAll('.dragging').forEach((c) => c.classList.remove('dragging')); }
const afterHalf = (e, card) => { const r = card.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
function onDragStart(e) {
  const c = e.target.closest?.('.gm-card');
  if (!c || !canReorder() || isBusy()) { e.preventDefault(); return; }
  dragUuid = c.dataset.uuid;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragUuid);
  requestAnimationFrame(() => c.classList.add('dragging'));
}
function onDragOver(e) {
  if (!dragUuid) return;
  e.preventDefault();
  clearMarks();
  const c = e.target.closest?.('.gm-card');
  if (!c || c.dataset.uuid === dragUuid) return;
  e.dataTransfer.dropEffect = 'move';
  c.classList.add(afterHalf(e, c) ? 'drop-after' : 'drop-before');
}
function onDrop(e) {
  e.preventDefault();
  const c = e.target.closest?.('.gm-card');
  if (c && dragUuid && c.dataset.uuid !== dragUuid) {
    const order = M.moveUuid(orderIds(currentList()), dragUuid, c.dataset.uuid, afterHalf(e, c));
    const app = serverList().find((a) => a.uuid === dragUuid);
    applyOrder(order, cardKeys(dragUuid, 'edit'), dragUuid);
    if (app) announce(app, order);
  }
  endDrag();
}

export default { id: 'games', tab: 'Jogos', title: 'Jogos', mount, show, hide, canLeave };
