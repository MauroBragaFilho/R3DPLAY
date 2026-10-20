// Núcleo do painel R3D PLAY: ponte com o app nativo, estado, eventos, utilidades de interface e ciclo de vida do servidor.
// Todas as telas (js/views/*.js) importam daqui. Nada neste arquivo conhece uma tela específica.
'use strict';

/* ---------- DOM ---------- */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cria um elemento. h('button', {class: 'btn primary', on: {click: fn}, 'aria-label': 'x'}, icon('add'), 'Texto')
 * props: class, id, text, html (CONFIÁVEL: nunca com texto vindo do servidor sem esc()), dataset {..}, on {evento: fn}, style (objeto ou texto),
 * value/checked/disabled/hidden (propriedades), qualquer outro vira atributo (false/null/undefined = não define).
 * filhos: Node, texto, número ou arrays (aninhados); null/undefined/false são ignorados.
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (['value', 'checked', 'disabled', 'hidden', 'selected', 'readOnly', 'indeterminate'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}
/** Ícone Material Symbols (fonte local). */
export const icon = (name, cls = '') => h('i', { class: `ms ${cls}`.trim(), 'aria-hidden': 'true', text: name });

/* ---------- Eventos entre telas ---------- */
const listeners = new Map();
export const bus = {
  /** Escuta um evento; devolve a função que cancela. */
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt)?.delete(fn);
  },
  emit(evt, data) { listeners.get(evt)?.forEach((fn) => { try { fn(data); } catch (e) { log(`bus ${evt}: ${e}`); } }); },
};
/** Eventos usados: 'apps' (lista/estado de transmissão mudou), 'online' (true/false), 'restarting', 'restarted', 'navigate' ({tab, params}), 'devices'. */
export const go = (tab, params = {}) => bus.emit('navigate', { tab, params });

/* ---------- Ponte com o app nativo (WebView2) ---------- */
let seq = 0;
const pending = new Map();
// (typeof window: permite importar este módulo no Node para testes de lógica pura)
globalThis.window?.chrome?.webview?.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  pending.get(m.id)?.(m);
  pending.delete(m.id);
});
/** Comando do app nativo. Comandos: api, login{user,pass}, logout, whoami ({user}, nunca a senha), hasCreds, scan, cover{source,gameId,name}, readCover{path}, info ({host, ips, url, dataDir}),
 * installedPrograms, pickFile{title?}, pickFolder{title?}, findExe{folder}, inspectProgram{path}, droppedFiles (via nativeFiles), stats{port?}, rebase{port} (muda a porta do painel depois de reiniciar com outra porta), log{text}, advanced. */
export const native = (cmd, data = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  window.chrome.webview.postMessage({ id, cmd, ...data });
});
export const log = (text) => { native('log', { text: String(text) }); };
/**
 * Como native(), mas anexa arquivos soltos na página (File vindos de um evento drop): o app nativo recebe os CAMINHOS completos,
 * que o navegador não revela (postMessageWithAdditionalObjects do WebView2). Resposta do comando "droppedFiles": { paths: [..] }.
 */
export const nativeFiles = (cmd, files, data = {}) => new Promise((resolve) => {
  const wv = globalThis.window?.chrome?.webview;
  if (!wv?.postMessageWithAdditionalObjects) { resolve({ error: 'Este ambiente não entrega o caminho dos arquivos soltos.' }); return; }
  const id = ++seq;
  pending.set(id, resolve);
  wv.postMessageWithAdditionalObjects({ id, cmd, ...data }, files);
});

/**
 * Chama a API do servidor com a sessão do app nativo (relogin automático em 401).
 * POST/PUT/DELETE sem corpo enviam {} (o servidor exige Content-Type JSON: regra R01 do _serializacao.md).
 * Devolve {status, ok, json, text}. status 0 = servidor fora do ar (ou reiniciando). 307/302 = ainda sem usuário criado.
 */
export async function api(method, path, obj) {
  const body = obj === undefined ? (method === 'GET' ? null : '{}') : JSON.stringify(obj);
  const r = await native('api', { method, path, body });
  let json = null;
  try { json = JSON.parse(r.body); } catch { /* resposta não-JSON (ex.: log) */ }
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json, text: r.body };
}

/* ---------- Estado compartilhado ---------- */
export const state = {
  apps: [],          // GET /api/apps → apps[]
  currentApp: '',    // uuid do app em transmissão ('' = nenhum)
  online: false,     // o servidor responde? (false só quando NÃO há resposta HTTP: status 0)
  lastStatus: 200,   // status HTTP do último GET /api/apps (0 = sem resposta; 5xx = respondeu com erro)
  hostName: '',      // nome que o servidor anuncia ao celular (GET /api/apps → host_name)
  hostUuid: '',
  sessionBusy: false, // true enquanto a sessão está sendo trocada (alterar senha): o polling do main.js pula esse intervalo
  meta: { version: '', platform: 'windows', vdisplayStatus: undefined }, // metadados de GET /api/config (nunca vão no POST)
};
/** Recarrega a lista de apps e o app em transmissão. Emite 'apps'. */
export async function loadApps() {
  const r = await api('GET', '/api/apps');
  state.lastStatus = r.status;
  if (r.ok && r.json) {
    state.apps = r.json.apps || [];
    state.currentApp = r.json.current_app || '';
    state.hostName = r.json.host_name || state.hostName;
    state.hostUuid = r.json.host_uuid || state.hostUuid;
    bus.emit('apps', state);
    return true;
  }
  return false;
}
export function setOnline(ok) {
  if (state.online === ok) return;
  state.online = ok;
  bus.emit('online', ok);
}

/* ---------- Mensagens ---------- */
export function toast(msg, kind = '') {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status', text: msg });
  const box = $('#toasts');
  box.append(el);
  // Janelas modais ficam na camada superior da página e cobririam o aviso: reabre o contêiner (popover) para ele ficar por cima.
  try {
    if (box.showPopover) { if (box.matches(':popover-open')) box.hidePopover(); box.showPopover(); }
  } catch { /* sem suporte a popover: o contêiner fixo normal já aparece */ }
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 4500);
}

/** Confirmação simples. Devolve true/false. opts: {danger = true, title, no = 'Cancelar'} */
let confirmPending = null;
export function confirmDlg(msg, yes = 'Confirmar', opts = {}) {
  const { danger = true, title = '', no = 'Cancelar' } = opts;
  return new Promise((resolve) => {
    const d = $('#dlg');
    // Duas confirmações sobrepostas: a anterior responde "não" (senão a Promise dela nunca resolve e o botão dela ficaria travado).
    confirmPending?.(false);
    confirmPending = resolve;
    if (d.open) d.close();
    $('#dlgTitle').textContent = title;
    $('#dlgTitle').hidden = !title;
    $('#dlgMsg').textContent = msg;
    const y = $('#dlgYes');
    y.textContent = yes;
    y.className = `btn ${danger ? 'danger' : 'primary'}`;
    $('#dlgNo').textContent = no;
    d.onclose = () => {
      if (d.open) return;   // evento atrasado do fechamento da confirmação anterior: o diálogo já foi reaberto
      confirmPending = null;
      resolve(d.returnValue === 'yes');
    };
    d.returnValue = 'no';
    d.showModal();
  });
}

/**
 * Janela de diálogo genérica (editores, formulários). Devolve o `value` do botão clicado ou null (Esc / fechar).
 * modal({title, body: Node, actions: [{label, value, kind: 'primary'|'danger'|'', icon, validate: () => true|string|Promise}], wide: false, onOpen: (dialogEl) => {}, beforeClose})
 * Se validate (pode ser assíncrona) devolver string, o diálogo NÃO fecha e a mensagem aparece como erro.
 * beforeClose(valor) (pode ser assíncrona) roda ao fechar por QUALQUER caminho (botão, X, Esc): devolver false cancela o fechamento
 * (ex.: "descartar alterações?"). valor = o value do botão ou null para X/Esc.
 */
export function modal({ title = '', body, actions = [{ label: 'Fechar', value: true }], wide = false, onOpen, beforeClose } = {}) {
  return new Promise((resolve) => {
    const err = h('p', { class: 'error', hidden: true, role: 'alert' });
    const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}`, 'aria-label': title || 'Janela' });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    let checking = false;
    const tryClose = async (v) => {
      if (checking) return;
      checking = true;
      let ok = true;
      try { ok = !beforeClose || (await beforeClose(v)) !== false; } catch (e) { log(`modal beforeClose: ${e}`); } finally { checking = false; }
      if (ok) close(v);
    };
    const btns = actions.map((a) => h('button', {
      class: `btn ${a.kind || ''}`.trim(), type: 'button',
      on: {
        click: async (ev) => {
          const btn = ev.currentTarget;
          if (btn.disabled) return;
          const res = a.validate ? await busy(btn, async () => a.validate()) : true;
          if (res !== true && res !== undefined) { err.textContent = res || 'Confira os campos.'; err.hidden = false; return; }
          tryClose(a.value);
        },
      },
    }, a.icon ? icon(a.icon) : null, a.label));
    dlg.append(
      h('div', { class: 'modal-head' }, h('h3', { text: title }), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fechar', on: { click: () => tryClose(null) } }, icon('close'))),
      h('div', { class: 'modal-body' }, body),
      err,
      h('div', { class: 'row-actions' }, btns),
    );
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); tryClose(null); });
    document.body.append(dlg);
    dlg.showModal();
    onOpen?.(dlg);
  });
}

/** Desabilita o botão enquanto fn roda e SEMPRE reabilita (regra R03: nunca deixar botão travado). */
export async function busy(btn, fn) {
  btn?.setAttribute('disabled', '');
  try { return await fn(); } finally { btn?.removeAttribute('disabled'); }
}

/* ---------- Ciclo de vida do servidor ---------- */
/** Espera o servidor voltar (qualquer resposta HTTP diferente de status 0/5xx). Devolve true se voltou dentro do prazo. */
export async function waitForServer({ timeout = 90000, interval = 1500, initialDelay = 1500 } = {}) {
  await sleep(initialDelay);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await api('GET', '/api/apps');
    if (r.status > 0 && r.status < 500) { setOnline(true); return true; }
    await sleep(interval);
  }
  return false;
}
/**
 * Reinicia o servidor (POST /api/restart {}). A conexão cai: status 0 ou 200 = "reiniciando" (regra R02).
 * Espera ele voltar e recarrega os apps. Devolve true se voltou. Emite 'restarting' e 'restarted'.
 */
export async function restartServer() {
  bus.emit('restarting');
  // Se a configuração tem outra porta, o servidor volta nela (o painel fica em porta + 1): lê antes, e depois do pedido a ponte passa a falar com a nova.
  const cfg = await api('GET', '/api/config');
  const port = Number(cfg.json?.port) || 47989;
  const r = await api('POST', '/api/restart', {});
  if (r.status !== 0 && !r.ok) {   // o servidor RECUSOU o pedido (400/401/403/5xx...): não vai reiniciar, então não adianta esperar
    bus.emit('restarted', false);
    return false;
  }
  native('rebase', { port });
  setOnline(false);
  const ok = await waitForServer();
  if (ok) await loadApps();
  bus.emit('restarted', ok);
  return ok;
}

/* ---------- Formatação ---------- */
export const fmt = {
  bytes(n) {
    n = Number(n) || 0;
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  },
  pct: (n) => `${Math.round(Number(n) || 0)}%`,
};
