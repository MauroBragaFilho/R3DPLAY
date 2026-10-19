// Tela Configurações: TODAS as opções do sunshine.conf (schemas em ui/schema), inclusive as avançadas, numa tela só.
//   Menu lateral por categoria · busca global · Essenciais/Todas · barra de alterações · Salvar / Salvar e reiniciar.
// A lógica fica em js/lib (schema.js = catálogo e condições, serialize.js = conversão/validação/modelo, widgets/ = listas); aqui só há DOM.
// Só a categoria visível é desenhada; ao editar, os campos são ATUALIZADOS no lugar (nada é recriado a cada tecla).
import { h, icon, state, bus, toast, confirmDlg, busy, restartServer, log } from '../core.js';
import { readConfig, writeConfig } from '../lib/config.js';
import {
  CATEGORIES, loadCatalog, platformOk, isActive, groupActive, groupTitle, labelFor, helpFor, placeholderFor, extrasFor, choicesFor,
  defaultLabel, describeCond, searchCatalog, vdisplayInfo, liveNotes, portTable, evalCond, riskNotes,
} from '../lib/schema.js';
import { createModel, parseNumberText } from '../lib/serialize.js';
import { getWidget } from '../lib/widgets/index.js';

/* ---------- Estado da tela ---------- */
const MODE_KEY = 'r3d.settings.mode';
const readMode = () => { try { return localStorage.getItem(MODE_KEY) === 'all' ? 'all' : 'essential'; } catch { return 'essential'; } };
const writeMode = (m) => { try { localStorage.setItem(MODE_KEY, m); } catch { /* sem armazenamento: vale só nesta abertura */ } };

const ui = {
  mode: readMode(),          // 'essential' (padrão) | 'all'
  query: '',                 // busca global; vazio = categoria normal
  catId: CATEGORIES[0].id,
  loading: true,
  loadError: '',             // falha ao ler o arquivo de configuração
  catalogError: '',          // falha ao ler os schemas
  showErrors: false,         // depois de um Salvar que falhou na validação, os erros passam a aparecer ao vivo
  saving: false,
  discarding: false,
  pending: null,             // Set de chaves salvas que só valem depois de reiniciar
  restart: null,             // null | {phase:'running'|'done'|'failed'}
  openGroups: new Map(),     // uid do grupo -> aberto?
};
let root = null;
let catalog = null;
let model = null;
const els = {};
let fields = new Map();      // chave -> controlador do campo desenhado
let groupCtls = [];
let vdCtls = [];
let loadToken = 0;
let offs = [];
let searchTimer = 0;
let doneTimer = 0;
let visible = false;
let focusBeforeLock = '';    // id do campo com foco quando o salvamento travou o painel
let lastErrs = null;         // últimos erros mostrados (para a barra de alterações não perdê-los quando só o estado do reinício muda)

const platform = () => state.meta?.platform || 'windows';
const INT32_MAX = 2147483647;
const plain = (t) => String(t || '').replace(/:$/, '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** "a", "a e b", "a, b e c", "a, b, c e mais 2". */
function joinNames(list, max = 3) {
  if (list.length <= 1) return list.join('');
  if (list.length <= max) return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
  return `${list.slice(0, max).join(', ')} e mais ${list.length - max}`;
}
const scroller = () => root?.closest('.content');

/* ---------- Pequenos componentes ---------- */
function banner(kind, iconName, content, ...actions) {
  return h('div', { class: `banner ${kind}`.trim(), role: kind === 'bad' ? 'alert' : 'status' },
    iconName === 'spinner' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon(iconName),
    h('div', { class: 'st-grow' }, content), ...actions);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado.', 'ok'); } catch { toast('Não foi possível copiar. Selecione o texto e copie com Ctrl+C.', 'err'); }
}
function extraBlock(x) {
  if (x.kind === 'code' || x.kind === 'sample') {
    const pre = h('pre', { class: 'st-code mono', text: x.text });
    if (x.kind === 'sample') return pre;
    return h('div', { class: 'st-codebox' }, pre, h('button', { class: 'icon-btn', type: 'button', title: 'Copiar', 'aria-label': 'Copiar o comando', on: { click: () => copyText(x.text) } }, icon('content_copy')));
  }
  if (x.kind === 'italic') return h('p', { class: 'f-help' }, h('em', { text: x.text }));
  if (x.kind === 'link') return h('p', { class: 'f-help', text: `${x.text}: ${x.url}` });
  return h('p', { class: 'f-help', text: x.text });
}

/* ---------- Catálogo e leitura do arquivo ---------- */
async function initCatalog() {
  try {
    catalog = await loadCatalog();
    model = createModel(catalog, { platform: platform() });
    ui.catalogError = '';
    buildNav();
  } catch (e) {
    catalog = null; model = null;
    ui.catalogError = String(e?.message || e);
    log(`settings: schemas: ${e && e.stack || e}`);
  }
}

const LOAD_MESSAGES = (status) => {
  if (status === 0) return 'O R3D PLAY não está respondendo. Confira se ele está aberto (ícone na bandeja do Windows) e tente de novo.';
  if ([301, 302, 303, 307, 308, 401, 403].includes(status)) return 'O R3D PLAY pediu o login de novo. Feche e abra este painel.';
  return `O R3D PLAY respondeu com erro (HTTP ${status}).`;
};

async function reload() {
  const token = ++loadToken;
  ui.loading = true; ui.loadError = '';
  paint();
  const r = await readConfig();
  if (token !== loadToken) return;       // chegou outra leitura depois
  ui.loading = false;
  // A pessoa saiu desta aba enquanto o arquivo era lido: não redesenha (mexeria na rolagem da tela que está aberta); show() lê de novo ao voltar.
  if (!visible) return;
  if (!r.ok) {
    ui.loadError = LOAD_MESSAGES(r.status);
  } else {
    try {
      model.setPlatform(platform());
      model.load(r.values);
      ui.showErrors = false;
    } catch (e) {          // um valor que a tela não entende não pode deixar o esqueleto de carregamento para sempre
      log(`settings: leitura do arquivo: ${e && e.stack || e}`);
      ui.loadError = 'O arquivo de configuração tem um valor que esta tela não entende. Confira o arquivo sunshine.conf ou use a aba Sistema > Registro para ver o que aconteceu.';
    }
  }
  paint();
}

/* ---------- Menu lateral e barras ---------- */
function buildNav() {
  els.nav.replaceChildren(...CATEGORIES.map((c) => h('button', {
    type: 'button', dataset: { cat: c.id }, on: { click: () => selectCategory(c.id) },
  }, icon(c.icon), h('span', { text: c.label }), h('span', { class: 'count', text: '' }))));
}

/** Opções que contam no menu: da plataforma, no filtro atual e com as dependências (showIf) satisfeitas. */
function countFor(cat) {
  const plat = platform();
  let n = 0;
  for (const s of cat.sections) for (const o of s.options) {
    if (!platformOk(o.platform, plat) || (ui.mode === 'essential' && o.advanced)) continue;
    if (isActive(o, model.get, plat)) n++;
  }
  return n;
}
function updateNav() {
  if (!catalog || !model) return;
  const matches = ui.query ? new Map() : null;
  if (matches) for (const r of searchCatalog(catalog, ui.query, platform())) matches.set(r.opt.cat, (matches.get(r.opt.cat) || 0) + 1);
  for (const btn of els.nav.children) {
    const cat = catalog.categories.find((c) => c.id === btn.dataset.cat);
    const on = !ui.query && cat.id === ui.catId;
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    btn.querySelector('.count').textContent = String(matches ? (matches.get(cat.id) || 0) : countFor(cat));
  }
}
function updateModeSeg() {
  for (const b of els.modeSeg.children) {
    const on = b.dataset.mode === ui.mode;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}
function setMode(mode) {
  if (ui.mode === mode) return;
  ui.mode = mode;
  writeMode(mode);
  paint({ keepScroll: true });
}
function selectCategory(id) {
  ui.catId = id;
  if (ui.query) { ui.query = ''; els.search.value = ''; els.clear.hidden = true; }
  paint();
  const sc = scroller(); if (sc) sc.scrollTop = 0;
}
function clearSearch() {
  els.search.value = ''; els.clear.hidden = true;
  if (ui.query) { ui.query = ''; paint(); }
}
function onSearchInput() {
  els.clear.hidden = !els.search.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { ui.query = els.search.value.trim(); paint(); const sc = scroller(); if (sc) sc.scrollTop = 0; }, 150);
}

/*
 * A barra de baixo (sticky, sempre à vista) tem 5 estados: alterações não salvas · salvo, falta reiniciar · reiniciando ·
 * não voltou · pronto. O aviso "só vale depois de reiniciar" mora aqui (e não no topo da tela) porque a pessoa costuma estar rolada.
 */
function buildSavebar() {
  els.count = h('strong', { text: '' });
  els.tail = h('span', { text: ' não salvas' });
  els.saveMsg = h('span', { class: 'st-save-msg' });
  els.sbNote = h('span', { class: 'st-save-note' });
  els.sbDirty = h('div', { class: 'grow' }, els.count, els.tail, els.saveMsg, els.sbNote);
  els.sbIcon = h('span', { class: 'st-sb-icon', 'aria-hidden': 'true' });
  els.sbText = h('span', { class: 'st-sb-text' });
  els.sbInfo = h('div', { class: 'grow st-sb-info', role: 'status', 'aria-live': 'polite' }, els.sbIcon, els.sbText);
  els.btnDiscard = h('button', { class: 'btn ghost', type: 'button', on: { click: () => busy(els.btnDiscard, onDiscard) } }, icon('undo'), 'Descartar');
  els.btnSave = h('button', { class: 'btn', type: 'button', on: { click: () => busy(els.btnSave, () => save({ restart: false })) } }, icon('save'), 'Salvar');
  els.btnSaveRestart = h('button', { class: 'btn primary', type: 'button', on: { click: () => busy(els.btnSaveRestart, () => save({ restart: true })) } }, icon('restart_alt'), 'Salvar e reiniciar');
  els.btnRestartNow = h('button', { class: 'btn primary', type: 'button', on: { click: () => busy(els.btnRestartNow, () => restartNow(false)) } }, icon('restart_alt'), 'Reiniciar agora');
  els.btnRetry = h('button', { class: 'btn', type: 'button', on: { click: () => busy(els.btnRetry, () => restartNow(true)) } }, icon('restart_alt'), 'Tentar de novo');
  return h('div', { class: 'savebar st-savebar', role: 'region', 'aria-label': 'Alterações e reinício', hidden: true },
    els.sbDirty, els.sbInfo, els.btnDiscard, els.btnSave, els.btnSaveRestart, els.btnRestartNow, els.btnRetry);
}
/** Qual dos estados da barra vale agora. */
function savebarMode() {
  const r = ui.restart;
  if (r?.phase === 'running') return 'restarting';
  if ((model?.dirty.size || 0) > 0) return 'dirty';
  if (r?.phase === 'failed') return 'failed';
  if (r?.phase === 'done') return 'done';
  if (ui.pending?.size) return 'pending';
  return 'hidden';
}
function pendingNames() {
  const names = [...(ui.pending || [])].map((k) => plain(labelFor(catalog.byKey.get(k), platform())));
  return joinNames(names);
}
function updateSavebar(errs = lastErrs) {
  const mode = savebarMode();
  els.savebar.hidden = mode === 'hidden';
  for (const m of ['dirty', 'pending', 'restarting', 'failed', 'done']) els.savebar.classList.toggle(`st-sb-${m}`, mode === m);
  const dirtyMode = mode === 'dirty';
  els.sbDirty.hidden = !dirtyMode;
  els.sbInfo.hidden = dirtyMode;
  els.btnDiscard.hidden = els.btnSave.hidden = els.btnSaveRestart.hidden = !dirtyMode;
  els.btnRestartNow.hidden = mode !== 'pending';
  els.btnRetry.hidden = mode !== 'failed';
  if (dirtyMode) {
    const n = model.dirty.size;
    els.count.textContent = plural(n, 'alteração', 'alterações');
    els.tail.textContent = n === 1 ? ' não salva' : ' não salvas';
    const bad = errs ? Object.keys(errs).length : 0;
    els.saveMsg.textContent = bad ? ` · ${plural(bad, 'campo precisa', 'campos precisam')} de atenção` : '';
    els.saveMsg.classList.toggle('bad', bad > 0);
    // o que já foi salvo antes continua pendente de reinício: a pessoa não pode esquecer disso
    els.sbNote.textContent = ui.pending?.size ? ' · As alterações já salvas ainda precisam do reinício do R3D PLAY.' : '';
  } else if (mode !== 'hidden') {
    const spec = {
      restarting: ['spinner', 'Reiniciando o R3D PLAY… isso leva alguns segundos. Não feche esta janela.'],
      failed: ['error', 'O R3D PLAY não voltou a responder. Abra-o pela bandeja do Windows ou tente reiniciar de novo.'],
      done: ['check_circle', 'Pronto! O R3D PLAY reiniciou e as alterações já estão valendo.'],
      pending: ['info', `Alterações salvas. As mudanças em ${pendingNames()} só valem depois de reiniciar o R3D PLAY.`],
    }[mode];
    els.sbIcon.replaceChildren(spec[0] === 'spinner' ? h('span', { class: 'spinner' }) : icon(spec[0]));
    els.sbText.textContent = spec[1];
  }
  if (ui.saving) els.btnDiscard.setAttribute('disabled', ''); else if (!ui.discarding) els.btnDiscard.removeAttribute('disabled');
}

/** Faixa do topo: só o aviso de servidor fora do ar (o estado de salvar/reiniciar fica na barra de baixo). */
function paintBanners() {
  const nodes = [];
  if (!state.online && ui.restart?.phase !== 'running') {
    nodes.push(banner('warn', 'warning', 'O R3D PLAY não está respondendo agora. Você pode mexer nas opções, mas só consegue salvar quando ele voltar.'));
  }
  els.banners.replaceChildren(...nodes);
}

/* ---------- Desenho do painel ---------- */
function paint({ keepScroll = false } = {}) {
  const sc = scroller();
  const top = keepScroll && sc ? sc.scrollTop : 0;
  fields = new Map(); groupCtls = []; vdCtls = [];
  els.modeSeg && updateModeSeg();
  paintBanners();
  if (ui.catalogError) {
    els.panel.replaceChildren(banner('bad', 'error', 'Não foi possível carregar a lista de opções desta tela.',
      h('button', { class: 'btn', type: 'button', on: { click: (e) => busy(e.currentTarget, retry) } }, icon('refresh'), 'Tentar de novo')));
    els.savebar.hidden = true;
    return;
  }
  if (ui.loading || !catalog) {      // carregando: esqueleto no lugar do conteúdo
    els.panel.replaceChildren(h('div', { class: 'st-loading', role: 'status', 'aria-label': 'Carregando as configurações' },
      h('div', { class: 'skeleton', style: { height: '28px', width: '40%' } }), ...[0, 1, 2].map(() => h('div', { class: 'skeleton', style: { height: '110px' } }))));
    if (catalog) { updateNav(); updateSavebar(); } else els.savebar.hidden = true;
    return;
  }
  if (ui.loadError) {
    els.panel.replaceChildren(banner('bad', 'error', ui.loadError,
      h('button', { class: 'btn', type: 'button', on: { click: (e) => busy(e.currentTarget, reload) } }, icon('refresh'), 'Tentar de novo')));
    els.savebar.hidden = true;
    return;
  }
  els.panel.replaceChildren(...(ui.query ? renderSearch() : renderCategory(catalog.categories.find((c) => c.id === ui.catId))));
  refreshAll();
  if (sc && visible) sc.scrollTop = top;       // a rolagem é compartilhada com as outras telas: só mexe quando esta está aberta
}
async function retry() { await initCatalog(); if (catalog) await reload(); else paint(); }

/** Opções da seção que aparecem agora: plataforma certa e, no modo Essenciais, só as não avançadas. */
function listedIn(section) {
  const plat = platform();
  return section.options.filter((o) => platformOk(o.platform, plat) && (ui.mode === 'all' || !o.advanced));
}

function renderCategory(cat) {
  const out = [];
  out.push(h('div', { class: 'st-cathead' }, h('h2', { text: cat.label }), h('p', { class: 'muted', text: cat.intro })));
  const plat = platform();
  // Aviso discreto: quantas avançadas estão escondidas (e quantas delas já foram mudadas do padrão).
  const sections = cat.sections.map((s) => ({ s, list: listedIn(s) })).filter((x) => x.list.length);
  if (ui.mode === 'essential' && sections.length) {
    const hidden = cat.sections.flatMap((s) => s.options).filter((o) => o.advanced && platformOk(o.platform, plat) && isActive(o, model.get, plat));
    if (hidden.length) {
      const changed = hidden.filter((o) => !model.isDefault(o.key)).length;
      out.push(banner('', 'tune',
        `${plural(hidden.length, 'opção avançada está escondida', 'opções avançadas estão escondidas')} nesta categoria${changed ? ` (${plural(changed, 'tem valor diferente do padrão', 'têm valor diferente do padrão')})` : ''}.`,
        h('button', { class: 'btn', type: 'button', on: { click: () => setMode('all') } }, 'Mostrar todas')));
    }
  }
  for (const { s: section, list } of sections) out.push(buildSection(section, list));
  if (!sections.length) {
    out.push(h('div', { class: 'empty card' }, icon('tune'), h('p', { text: 'Todas as opções desta categoria são avançadas.' }),
      h('button', { class: 'btn', type: 'button', on: { click: () => setMode('all') } }, 'Mostrar todas as opções')));
  }
  return out;
}

function renderSearch() {
  const res = searchCatalog(catalog, ui.query, platform());
  const out = [];
  out.push(h('div', { class: 'st-cathead', role: 'status' }, h('h2', { text: 'Resultados da busca' }),
    h('p', { class: 'muted', text: res.length ? `${plural(res.length, 'opção encontrada', 'opções encontradas')} para “${ui.query}”. A busca inclui as opções avançadas.` : '' })));
  if (!res.length) {
    out.push(h('div', { class: 'empty card' }, icon('search'), h('p', { text: `Nenhuma opção encontrada para “${ui.query}”.` }), h('p', { class: 'muted', text: 'Tente outra palavra, por exemplo “porta”, “áudio” ou “tela”.' }),
      h('button', { class: 'btn', type: 'button', on: { click: clearSearch } }, 'Limpar a busca')));
    return out;
  }
  for (const cat of catalog.categories) {
    const mine = res.filter((r) => r.opt.cat === cat.id);
    if (!mine.length) continue;
    const id = `st-res-${cat.id}`;
    const card = h('section', { class: 'card st-section', 'aria-labelledby': id }, h('h3', { id, text: `${cat.label} · ${mine.length}` }));
    const wrap = h('div', { class: 'st-fields' });
    for (const { opt } of mine) wrap.append(buildField(opt, { search: true }).el);
    card.append(wrap);
    out.push(card);
  }
  return out;
}

function buildSection(section, list) {
  const id = `st-sec-${section.uid.replace(/\./g, '-')}`;
  const card = h('section', { class: 'card st-section', 'aria-labelledby': id }, h('h3', { id, text: section.title }));
  for (const w of section.statusWidgets) if (w.id === 'sudovda_status' && platformOk(w.platform, platform())) card.append(buildVdisplay());
  const wrap = h('div', { class: 'st-fields' });
  const done = new Set();
  for (const opt of list) {
    if (opt.group) {
      if (done.has(opt.group)) continue;
      done.add(opt.group);
      const g = section.groups.find((x) => x.id === opt.group);
      if (g) { wrap.append(buildGroup(g, list.filter((o) => o.group === g.id)).el); continue; }
    }
    wrap.append(buildField(opt).el);
  }
  card.append(wrap);
  return card;
}

function buildGroup(group, members, open) {
  const text = h('span', { text: group.title });
  const body = h('div', { class: 'fold-body' });
  const el = h('details', { class: 'fold st-group' }, h('summary', {}, text), body);
  el.open = open ?? ui.openGroups.get(group.uid) ?? group.open;
  el.addEventListener('toggle', () => ui.openGroups.set(group.uid, el.open));
  if (group.notice) body.append(banner('', 'info', group.notice.text));
  const own = members.map((o) => buildField(o));
  body.append(...own.map((c) => c.el));
  const ctl = {
    el,
    refresh() {
      const plat = platform();
      const shown = groupActive(group, model.get, plat) && members.some((o) => isActive(o, model.get, plat));
      el.hidden = !shown;
      text.textContent = groupTitle(group, model.get);
    },
  };
  groupCtls.push(ctl);
  return ctl;
}

function buildVdisplay() {
  const title = h('strong');
  const hint = h('div', { class: 'f-help' });
  const el = h('div', { class: 'banner st-vd', role: 'status' }, icon('monitor'), h('div', { class: 'st-grow' }, title, hint));
  const ctl = {
    refresh() {
      const info = vdisplayInfo(state.meta?.vdisplayStatus);
      el.hidden = !info;
      if (!info) return;
      el.classList.toggle('ok', info.level === 'ok');
      el.classList.toggle('warn', info.level !== 'ok');
      title.textContent = `Driver de tela virtual: ${info.text}`;
      hint.textContent = info.hint;
      hint.hidden = !info.hint;
    },
  };
  vdCtls.push(ctl);
  return el;
}

/* ---------- Campo de uma opção ---------- */
function depthOf(opt) {
  let d = 0; let cur = opt;
  while (cur.showIf?.key && d < 3) {
    const p = catalog.byKey.get(cur.showIf.key);
    if (!p || p.sec !== opt.sec) break;
    d++; cur = p;
  }
  return d;
}

function hintText(opt, plat) {
  const def = defaultLabel(opt, plat);
  const parts = [];
  if (opt.kind === 'text') parts.push(def ? `Padrão: ${def}` : (opt.engineDefault ? `Em branco: usa ${opt.engineDefault}` : 'Padrão: em branco'));
  else parts.push(`Padrão: ${def}`);
  if (opt.kind === 'int' || opt.kind === 'real') {
    // 2147483647 é só o limite técnico do inteiro de 32 bits: mostrar como "máximo" assusta e não ajuda ninguém
    const max = typeof opt.max === 'number' && opt.max < INT32_MAX ? opt.max : null;
    if (typeof opt.min === 'number' && max !== null) parts.push(`de ${opt.min} a ${max}`);
    else if (typeof opt.min === 'number') parts.push(`mínimo ${opt.min}`);
    else if (max !== null) parts.push(`máximo ${max}`);
  }
  return parts.join(' · ');
}

function buildField(opt, { search = false } = {}) {
  const plat = platform();
  const key = opt.key;
  const id = `st-${key}`;
  const ctl = { opt, touched: false, el: null, focus: null, refresh: null };
  const isBool = opt.kind === 'bool';
  const advBadge = opt.advanced ? h('span', { class: 'badge warn st-adv', title: 'Opção avançada: os valores padrão funcionam bem para a maioria dos casos.', text: 'Avançada' }) : null;
  const dirtyBadge = h('span', { class: 'badge st-unsaved', text: 'não salvo', hidden: true });
  const labelEl = h('label', { class: 'f-label', for: isBool ? id : opt.kind === 'json' ? null : id, id: `${id}-label` }, plain(labelFor(opt, plat)), advBadge, dirtyBadge);
  const helpText = helpFor(opt, plat);
  const helpEl = h('div', { class: 'f-help', id: `${id}-help`, text: helpText, hidden: !helpText });
  const extras = extrasFor(opt, plat).map(extraBlock);
  const learn = opt.learnMore && !/\s/.test(opt.learnMore.url || '') ? h('p', { class: 'f-help' }, `${opt.learnMore.label}: `, h('span', { class: 'mono', text: opt.learnMore.url }),
    ' ', h('button', { class: 'btn ghost st-copy', type: 'button', on: { click: () => copyText(opt.learnMore.url) } }, icon('content_copy'), 'Copiar link')) : null;
  const notesEl = h('div', { class: 'st-notes' });
  const extraEl = h('div', { class: 'st-extra' });   // blocos que dependem do valor (tabela de portas)
  const searchInfo = search ? h('div', { class: 'st-searchinfo' }) : null;
  const errEl = h('div', { class: 'f-error', id: `${id}-err`, role: 'alert', hidden: true });
  const restore = h('button', { class: 'btn ghost st-restore', type: 'button', hidden: true, 'aria-label': `Restaurar o padrão de ${plain(labelFor(opt, plat))}`, on: { click: onRestore } }, icon('restart_alt'), 'Restaurar padrão');
  const meta = h('div', { class: 'st-meta' }, h('span', { class: 'f-hint', text: hintText(opt, plat) }), restore);

  let control = null;
  const change = (v) => {
    model.set(key, v);
    refreshAll();
  };
  function onRestore() {
    model.reset(key);
    ctl.touched = false;
    refreshAll();
  }

  /* Controle de edição por tipo */
  const broken = model.parseErrors[key];
  if (broken) {
    control = { el: h('div', { class: 'st-broken' },
      banner('warn', 'warning', `${broken} Ele continua como está e só muda se você descartá-lo.`),
      h('pre', { class: 'st-code mono', text: String(model.values[key] ?? '') }),
      h('button', { class: 'btn danger', type: 'button', on: { click: async () => {
        if (!(await confirmDlg('O valor ilegível será apagado do arquivo quando você salvar e a opção volta ao padrão. Continuar?', 'Descartar valor', { title: 'Valor ilegível' }))) return;
        model.overrideBroken(key); paint({ keepScroll: true });
      } } }, icon('delete'), 'Descartar o valor ilegível')), sync() {} };
  } else if (isBool) {
    const input = h('input', { type: 'checkbox', id, role: 'switch', 'aria-describedby': `${id}-help ${id}-err`, on: { change: () => change(input.checked) } });
    const stateTxt = h('span', { class: 'st-state', 'aria-hidden': 'true' });
    control = { el: h('div', { class: 'st-switch' }, stateTxt, h('label', { class: 'switch' }, input, h('span', { class: 'track' }))), focusEl: input,
      sync() { input.checked = !!model.draft[key]; stateTxt.textContent = input.checked ? 'Ligado' : 'Desligado'; stateTxt.classList.toggle('on', input.checked); } };
  } else if (opt.kind === 'choice') {
    control = buildChoice(opt, id, change, plat);
  } else if (opt.kind === 'text') {
    const input = h('input', { type: 'text', id, class: opt.mono ? 'mono' : '', placeholder: placeholderFor(opt, plat), autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${id}-help ${id}-err`,
      on: { input: () => change(input.value), blur: () => { ctl.touched = true; const t = input.value.trim(); if (t !== input.value) { input.value = t; change(t); } else refreshAll(); } } });
    control = { el: input, focusEl: input, sync() { if (input.value !== model.draft[key]) input.value = model.draft[key]; } };
  } else if (opt.kind === 'int' || opt.kind === 'real') {
    control = buildNumber(opt, id, change, ctl, plat);
  } else {
    const factory = opt.widget && getWidget(opt.widget);
    if (!factory) {
      control = { el: banner('bad', 'error', `O editor desta opção (${opt.widget || 'sem nome'}) não está disponível.`), sync() {} };
    } else {
      const w = factory({
        opt, platform: plat, id, get: model.get, value: () => model.draft[key],
        set: (v) => change(v), touch: () => { ctl.touched = true; refreshAll(); },
      });
      control = { el: w.el, sync() {}, widget: w };
    }
  }
  ctl.control = control;

  /* Montagem */
  const el = h('div', { class: `field st-field${isBool ? ' row' : ''}`, dataset: { key } });
  const text = h('div', { class: isBool ? 'f-text' : 'st-textblock' }, labelEl, searchInfo, helpEl, ...extras, learn);
  if (isBool) {
    text.append(meta, errEl, notesEl, extraEl);
    el.append(text, control.el);
  } else {
    const wrap = h('div', { class: 'st-control' }, control.el);
    if (opt.kind === 'json') { wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-labelledby', `${id}-label`); }
    el.append(text, wrap, meta, errEl, notesEl, extraEl);
  }
  if (!search) { const d = depthOf(opt); if (d) el.classList.add('st-child', `st-d${Math.min(d, 2)}`); }
  if (opt.kind === 'json') el.classList.add('st-wide');
  ctl.el = el;
  ctl.focus = () => (el.querySelector('[aria-invalid="true"]') || control.focusEl || el.querySelector('input,select,button'))?.focus();

  /* Atualiza o que depende do estado (chamado a cada mudança em qualquer campo) */
  let notesKey = '';
  let portBody = null;
  ctl.refresh = (errs) => {
    const active = isActive(opt, model.get, plat);
    if (search) {
      el.classList.toggle('st-inactive', !active);
      searchInfo.replaceChildren(...[
        h('div', { class: 'f-hint', text: opt.secTitle }),
        opt.advanced ? h('div', { class: 'st-advnote' }, icon('warning'), 'Opção avançada: só mexa se souber o que está fazendo.') : null,
        active ? null : h('div', { class: 'st-advnote muted' }, icon('subdirectory_arrow_right'), `Esta opção só vale quando ${describeCond(opt.showIf, catalog, plat)}.`),
      ].filter(Boolean));
    } else {
      el.hidden = !active;
      if (!active) return;
    }
    const dirty = model.isDirty(key);
    const isDef = model.isDefault(key);
    el.classList.toggle('st-dirty', dirty);
    el.classList.toggle('default-changed', !isDef && !broken);
    dirtyBadge.hidden = !dirty;
    restore.hidden = isDef || !!broken;
    if (opt.helpShowIf) helpEl.hidden = !helpText || !evalCond(opt.helpShowIf, model.get);
    control.sync?.();
    // avisos que dependem de outros valores (porta, acesso pela Internet)
    const notes = liveNotes(key, model.get, { dirty });
    const nk = JSON.stringify(notes);
    if (nk !== notesKey) {
      notesKey = nk;
      notesEl.replaceChildren(...notes.map((n) => banner(n.kind === 'bad' ? 'bad' : 'warn', n.kind === 'bad' ? 'error' : 'warning', n.text)));
    }
    if (key === 'port') {
      if (!portBody) {
        portBody = h('tbody');
        extraEl.append(h('details', { class: 'st-ports' }, h('summary', { text: 'Ver as portas usadas' }),
          h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Protocolo' }), h('th', { text: 'Porta' }), h('th', { text: 'Para quê' }))), portBody)));
      }
      portBody.replaceChildren(...portTable(model.get('port')).map((r) => h('tr', {}, h('td', { text: r.proto }), h('td', { class: 'mono', text: r.port }), h('td', { text: r.note }))));
    }
    // erros: só depois de mexer no campo (ou de um Salvar que falhou)
    const res = model.check(key);
    const showErr = ctl.touched || ui.showErrors;
    const msg = (errs && errs[key]) || (showErr && !broken ? res.error : '') || '';
    const shownMsg = res.rows?.length && !errs?.[key] ? '' : msg;      // listas mostram o erro em cada linha
    errEl.textContent = shownMsg; errEl.hidden = !shownMsg;
    el.classList.toggle('invalid', !!(shownMsg || (showErr && res.rows?.length)));
    // leitor de tela: o campo simples também precisa saber que está inválido (as listas marcam cada célula)
    const target = control.focusEl;
    if (target && target.tagName !== 'BUTTON') target.setAttribute('aria-invalid', shownMsg ? 'true' : 'false');
    control.widget?.refresh({ rows: showErr || ctl.touched ? (res.rows || []) : [] });
  };
  fields.set(key, ctl);
  return ctl;
}

function buildChoice(opt, id, change, plat) {
  const choices = choicesFor(opt, plat);
  const cur = model.draft[opt.key];
  const known = choices.some((c) => c.value === cur);
  const useSeg = known && choices.length <= 3 && choices.every((c) => c.label.length <= 22);
  if (useSeg) {
    const seg = h('div', { class: 'seg st-seg', role: 'radiogroup', 'aria-labelledby': `${id}-label`, id });
    const btns = choices.map((c) => h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', dataset: { v: c.value }, text: c.label, on: { click: () => change(c.value) } }));
    seg.append(...btns);
    seg.addEventListener('keydown', (e) => {
      const i = btns.findIndex((b) => b.dataset.v === model.draft[opt.key]);
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = btns[(i + d + btns.length) % btns.length];
      change(next.dataset.v);
      next.focus();
    });
    return { el: seg, focusEl: btns[0], sync() { const v = model.draft[opt.key]; btns.forEach((b) => { const on = b.dataset.v === v; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }); } };
  }
  const sel = h('select', { id, 'aria-describedby': `${id}-help ${id}-err`, on: { change: () => change(sel.value) } });
  if (!known) sel.append(h('option', { value: cur, text: `${cur || '(vazio)'} (valor atual, não reconhecido)` }));
  for (const c of choices) sel.append(h('option', { value: c.value, text: c.label }));
  return { el: sel, focusEl: sel, sync() { if (sel.value !== model.draft[opt.key]) sel.value = model.draft[opt.key]; } };
}

function buildNumber(opt, id, change, ctl, plat) {
  const real = opt.kind === 'real';
  const step = typeof opt.step === 'number' && opt.step > 0 ? opt.step : 1;   // "any"/ausente: de 1 em 1
  const input = h('input', {
    type: 'text', id, inputmode: real ? 'decimal' : 'numeric', class: 'mono', placeholder: opt.placeholder || String(opt.default), autocomplete: 'off', spellcheck: 'false',
    'aria-describedby': `${id}-help ${id}-err`,
    on: {
      input: () => change(input.value),
      blur: () => {          // arruma o formato (espaços, vírgula decimal, zeros à esquerda) quando o número é válido
        ctl.touched = true;
        const r = parseNumberText(input.value, real);
        if (!r.error && !r.empty && r.value !== input.value) { input.value = r.value; change(r.value); } else refreshAll();
      },
      keydown: (e) => {      // setas aumentam/diminuem (a roda do mouse não mexe, de propósito)
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const r = parseNumberText(input.value, real);
        let n = r.empty || r.error ? Number(opt.default) : r.number;
        n += (e.key === 'ArrowUp' ? 1 : -1) * step;
        if (typeof opt.min === 'number') n = Math.max(opt.min, n);
        if (typeof opt.max === 'number') n = Math.min(opt.max, n);
        input.value = String(Math.round(n * 1e6) / 1e6); change(input.value);   // arredonda para não mostrar 24.900000000000002
      },
    },
  });
  const el = opt.unit ? h('div', { class: 'input-unit st-number' }, input, h('span', { class: 'unit', text: opt.unit })) : h('div', { class: 'st-number' }, input);
  return { el, focusEl: input, sync() { if (input.value !== model.draft[opt.key]) input.value = model.draft[opt.key]; } };
}

/* ---------- Atualização geral ---------- */
function refreshAll() {
  if (!model || !catalog || ui.loading) return;
  const errs = ui.showErrors ? model.buildSave(model.values).errors : null;
  lastErrs = errs;
  for (const f of fields.values()) f.refresh(errs);
  for (const g of groupCtls) g.refresh();
  for (const v of vdCtls) v.refresh();
  updateNav();
  updateSavebar(errs);
}

/** Vai até uma opção (troca de categoria, sai da busca, mostra avançadas se preciso, abre o grupo e destaca o campo). */
function focusKey(key) {
  const opt = catalog?.byKey.get(key);
  if (!opt) return;
  const drawn = !ui.query && ui.catId === opt.cat && fields.has(key) && !(opt.advanced && ui.mode === 'essential');
  if (!drawn) {      // só redesenha quando a opção não está na tela (não perde o que a pessoa acabou de digitar)
    if (ui.query) { ui.query = ''; els.search.value = ''; els.clear.hidden = true; }
    if (opt.advanced && ui.mode === 'essential') { ui.mode = 'all'; writeMode('all'); }
    ui.catId = opt.cat;
    const grp = catalog.categories.flatMap((c) => c.sections).find((x) => x.uid === opt.sec)?.groups.find((g) => g.id === opt.group);
    if (grp) ui.openGroups.set(grp.uid, true);
    paint();
  }
  let f = fields.get(key);
  if (f?.el.hidden && opt.showIf?.key && fields.has(opt.showIf.key)) f = fields.get(opt.showIf.key);   // a opção está escondida: vai à que a controla
  if (!f) return;
  const box = f.el.closest('details');
  if (box) box.open = true;
  f.el.scrollIntoView({ block: 'center', behavior: 'auto' });
  f.focus();
  f.el.classList.add('st-flash');
  setTimeout(() => f.el.classList.remove('st-flash'), 2200);
}

/* ---------- Salvar, descartar e reiniciar ---------- */
const hasStream = () => !!state.currentApp;

async function onDiscard() {
  const n = model.dirty.size;
  if (!n) return;
  ui.discarding = true;   // o botão fica travado pelo busy() enquanto a pergunta está aberta
  let ok = false;
  try { ok = await confirmDlg(`Descartar ${plural(n, 'alteração não salva', 'alterações não salvas')}? As opções voltam ao que está gravado no arquivo.`, 'Descartar',
    { title: 'Descartar alterações', no: 'Continuar editando' }); } finally { ui.discarding = false; }
  if (!ok) return;
  model.discard();
  ui.showErrors = false;
  paint({ keepScroll: true });
  toast('Alterações descartadas.', 'ok');
}

function labelsOf(keys) {
  return keys.map((k) => `“${plain(labelFor(catalog.byKey.get(k), platform()))}”`);
}

/** Salvar = reler o arquivo agora, trocar SÓ as chaves sujas, validar e gravar (writeConfig confere por GET). */
async function save({ restart }) {
  if (ui.saving || !model.dirty.size) return false;
  // 1) validação com o que a tela tem (rápida, sem rede)
  ui.showErrors = true;
  let plan = model.buildSave(model.values);
  if (!plan.ok) {
    refreshAll();
    toast('Corrija os campos marcados em vermelho antes de salvar.', 'err');
    focusFirstError(plan.errors);
    return false;
  }
  // Mudanças que podem trancar a pessoa fora do painel ou apagar pareamentos pedem confirmação explícita.
  const risks = riskNotes(plan.changes.map((c) => c.key), (k) => plan.body[k]);
  if (risks.length) {
    const msg = risks.map((r) => `${labelsOf([r.key])[0]}: ${r.text}`).join(' ');
    const okRisk = await confirmDlg(msg, 'Salvar mesmo assim', { title: 'Esta mudança pode ser perigosa', no: 'Voltar e corrigir' });
    if (!okRisk) return false;
  }
  if (restart && hasStream() && !(await confirmDlg('Há uma transmissão em andamento. Reiniciar o R3D PLAY vai encerrá-la agora.', 'Salvar e reiniciar', { title: 'Reiniciar o R3D PLAY' }))) return false;
  ui.saving = true; updateSavebar();
  lockPanel(true);       // sem edições no meio do salvamento: elas seriam perdidas quando a tela relê o arquivo
  try {
    // 2) arquivo de AGORA (outra tela ou pessoa pode ter mudado outras chaves) + só as chaves sujas por cima
    const fresh = await readConfig();
    if (!fresh.ok) { toast('Não consegui ler a configuração atual do R3D PLAY. Nada foi salvo.', 'err'); return false; }
    plan = model.buildSave(fresh.values);
    if (!plan.ok) { lockPanel(false); refreshAll(); toast('Corrija os campos marcados em vermelho antes de salvar.', 'err'); focusFirstError(plan.errors); return false; }
    // 3) grava e confere por GET
    const r = await writeConfig(plan.body);
    if (!r.ok) { toast(`Não foi possível salvar: ${r.error}`, 'err'); return false; }
    const keys = plan.changes.map((c) => c.key);
    ui.pending = new Set([...(ui.pending || []), ...keys]);
    model.load(r.values);
    ui.showErrors = false;
    const skipped = plan.skipped.length ? ` Ignorei uma edição inválida em opção escondida (${joinNames(labelsOf(plan.skipped))}).` : '';
    toast(restart || !keys.length ? `Configurações salvas.${skipped}` : `Configurações salvas. Reinicie o R3D PLAY para elas valerem.${skipped}`, 'ok');
    paint({ keepScroll: true });
  } finally {
    ui.saving = false;
    lockPanel(false);
    if (visible) updateSavebar();
  }
  if (restart) await restartNow(true);
  return true;
}

/** Trava/destrava o painel de campos durante o salvamento e devolve o foco ao campo que estava em uso (o painel é redesenhado ao final). */
function lockPanel(on) {
  if (!els.panel) return;
  if (on) {
    focusBeforeLock = document.activeElement?.id || '';
    els.panel.inert = true;
    return;
  }
  els.panel.inert = false;
  const back = focusBeforeLock && visible ? document.getElementById(focusBeforeLock) : null;
  focusBeforeLock = '';
  if (back && els.panel.contains(back)) back.focus({ preventScroll: true });
}

function focusFirstError(errs) {
  const first = catalog.options.find((o) => errs[o.key]);
  if (first) focusKey(first.key);
}

/** Reinicia o servidor e espera ele voltar. confirmed = já perguntou ao usuário (Salvar e reiniciar). */
async function restartNow(confirmed) {
  if (ui.restart?.phase === 'running') return false;
  if (!confirmed && hasStream() && !(await confirmDlg('Há uma transmissão em andamento. Reiniciar o R3D PLAY vai encerrá-la agora.', 'Reiniciar agora', { title: 'Reiniciar o R3D PLAY' }))) return false;
  clearTimeout(doneTimer);
  ui.restart = { phase: 'running' };
  paintBanners();
  updateSavebar();
  let ok = false;
  try { ok = await restartServer(); } catch (e) { log(`settings: reinício: ${e}`); }
  ui.restart = { phase: ok ? 'done' : 'failed' };
  if (ok) {
    ui.pending = null;
    toast('R3D PLAY reiniciado. As alterações já estão valendo.', 'ok');
    doneTimer = setTimeout(() => { if (ui.restart?.phase === 'done') { ui.restart = null; if (visible && catalog) { paintBanners(); updateSavebar(); } } }, 9000);
    if (visible && model && !model.dirty.size) await reload();
  } else {
    toast('O R3D PLAY não voltou a responder a tempo.', 'err');
  }
  if (visible && catalog) { paintBanners(); updateSavebar(); }
  return ok;
}

/* ---------- Tela ---------- */
const onKey = (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && visible) {
    e.preventDefault();
    if (model?.dirty.size && !ui.saving) busy(els.btnSave, () => save({ restart: false }));
  }
};
const beforeUnload = (e) => { if (model?.dirty.size) { e.preventDefault(); e.returnValue = ''; } };

export default {
  id: 'settings',
  tab: 'Config',
  title: 'Configurações',

  mount(r) {
    root = r;
    root.classList.add('st-screen');
    els.banners = h('div', { class: 'st-banners' });
    els.search = h('input', {
      type: 'search', placeholder: 'Buscar nas configurações (nome, ajuda ou palavra-chave)', 'aria-label': 'Buscar nas configurações', autocomplete: 'off', spellcheck: 'false',
      on: { input: onSearchInput, keydown: (e) => { if (e.key === 'Escape' && els.search.value) { e.stopPropagation(); clearSearch(); } } },
    });
    els.clear = h('button', { class: 'icon-btn st-clear', type: 'button', hidden: true, 'aria-label': 'Limpar a busca', on: { click: () => { clearSearch(); els.search.focus(); } } }, icon('close'));
    const modeBtn = (mode, label) => h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', dataset: { mode }, text: label, on: { click: () => setMode(mode) } });
    els.modeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Quais opções mostrar' }, modeBtn('essential', 'Essenciais'), modeBtn('all', 'Todas'));
    els.modeSeg.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      setMode(ui.mode === 'all' ? 'essential' : 'all');
      els.modeSeg.querySelector('[aria-checked=true]')?.focus();
    });
    els.nav = h('nav', { class: 'sidenav st-nav', 'aria-label': 'Categorias de configurações' });
    els.panel = h('div', { class: 'st-panel' });
    els.savebar = buildSavebar();
    root.append(
      els.banners,
      h('div', { class: 'toolbar st-toolbar' },
        h('div', { class: 'search st-search' }, icon('search'), els.search, els.clear),
        h('div', { class: 'st-mode' }, h('span', { class: 'f-hint', text: 'Mostrar' }), els.modeSeg)),
      h('div', { class: 'split st-split' }, els.nav, els.panel),
      els.savebar,
    );
    updateModeSeg();
    window.addEventListener('beforeunload', beforeUnload);
    // Um reinício feito em outra tela (ou aqui) faz as alterações salvas passarem a valer.
    bus.on('restarted', (ok) => {
      if (!ok || ui.restart?.phase === 'running') return;
      ui.pending = null;
      if (visible && catalog) { paintBanners(); updateSavebar(); if (model && !model.dirty.size) reload(); }
    });
  },

  async show(params = {}) {
    visible = true;
    if (ui.restart?.phase === 'done') ui.restart = null;   // o aviso de "pronto" não precisa voltar depois
    document.addEventListener('keydown', onKey);
    offs.forEach((f) => f());      // show() pode rodar duas vezes sem hide() (main.js boot): não acumula ouvintes
    offs = [];
    offs.push(bus.on('online', () => { if (visible) paintBanners(); }));
    if (!catalog) { paint(); await initCatalog(); }
    if (!catalog) { paint(); return; }
    if (!model.dirty.size) await reload(); else paint({ keepScroll: true });
    if (typeof params.q === 'string' && params.q) { els.search.value = params.q; els.clear.hidden = false; ui.query = params.q.trim(); paint(); }
    else if (params.category && CATEGORIES.some((c) => c.id === params.category)) selectCategory(params.category);
    if (params.key) focusKey(String(params.key));
  },

  hide() {
    visible = false;
    document.removeEventListener('keydown', onKey);
    offs.forEach((f) => f());
    offs = [];
    clearTimeout(searchTimer);
    clearTimeout(doneTimer);
  },

  /** O app nativo usa isto ao fechar a janela (ver window.__r3dDirty em main.js). */
  isDirty() { return !!model?.dirty.size; },

  /** Pergunta antes de sair com alterações não salvas. */
  async canLeave() {
    const n = model?.dirty.size || 0;
    if (!n) return true;
    const ok = await confirmDlg(`Você tem ${plural(n, 'alteração que ainda não foi salva', 'alterações que ainda não foram salvas')}. Se sair agora, ${n === 1 ? 'ela será perdida' : 'elas serão perdidas'}.`, 'Sair sem salvar',
      { title: 'Alterações não salvas', no: 'Continuar editando' });
    if (ok) { model.discard(); ui.showErrors = false; }
    return ok;
  },
};
