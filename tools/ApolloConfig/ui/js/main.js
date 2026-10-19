// Ponto de entrada do painel R3D PLAY: login/primeiro acesso, abas, atualização periódica e configuração inicial.
// Cada tela é um módulo em js/views/<id>.js com export default { id, tab, title, mount(root), show(params), hide(), canLeave() }.
import { $, $$, h, api, native, state, bus, loadApps, setOnline, toast, restartServer, waitForServer, log, sleep } from './core.js';
import { patchConfig, readConfig } from './lib/config.js';

const VIEW_IDS = ['home', 'games', 'devices', 'settings', 'system'];
const views = new Map();   // id -> {def, root, mounted}
let active = '';
let firstRun = false;

/* ---------- Telas ---------- */
async function loadViews() {
  const nav = $('#tabs');
  for (const id of VIEW_IDS) {
    const root = h('section', { class: 'screen', id: `screen-${id}`, hidden: true });
    $('#views').append(root);
    let def;
    try {
      def = (await import(`./views/${id}.js`)).default;
      if (!def || typeof def.mount !== 'function') throw new Error('o módulo não exporta uma tela válida');
    } catch (e) {
      log(`tela ${id}: ${e && e.stack || e}`);
      def = { id, tab: id, title: id, mount(r) { r.append(h('div', { class: 'banner bad' }, `Não foi possível carregar a tela "${id}": ${e}`)); } };
    }
    views.set(id, { def, root, mounted: false });
    nav.append(h('button', { class: 'tab-button', dataset: { tab: id }, on: { click: () => showTab(id) } }, h('span', { text: def.tab || def.title })));
  }
}

export async function showTab(id, params = {}) {
  const next = views.get(id);
  if (!next) return;
  const cur = views.get(active);
  if (cur && active !== id && cur.def.canLeave && !(await cur.def.canLeave())) return;
  if (cur && active !== id) { try { cur.def.hide?.(); } catch (e) { log(`hide ${active}: ${e}`); } }
  const changed = active !== id;
  active = id;
  if (changed) $('.content').scrollTop = 0;   // cada aba abre no topo (a rolagem da anterior não vale para esta)
  $('.content').dataset.view = id;              // o CSS usa para dar a largura toda à tela Jogos
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);   // antes de esperar a rede: navegações rápidas não deixam o hash velho
  $$('.tab-button').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  for (const [vid, v] of views) v.root.hidden = vid !== id;
  $('#pageTitle').textContent = next.def.title || id;
  if (!next.mounted) {
    next.mounted = true;
    try { await next.def.mount(next.root); } catch (e) { log(`mount ${id}: ${e && e.stack || e}`); next.root.append(h('div', { class: 'banner bad' }, `Erro ao abrir esta tela: ${e}`)); }
  }
  try { await next.def.show?.(params); } catch (e) { log(`show ${id}: ${e && e.stack || e}`); toast(`Erro ao atualizar a tela: ${e}`, 'err'); }
}
/** O app nativo pergunta isto ao fechar a janela: alguma tela tem alterações não salvas? */
window.__r3dDirty = () => [...views.values()].some((v) => { try { return !!v.def.isDirty?.(); } catch { return false; } });
bus.on('navigate', ({ tab, params }) => showTab(tab, params));

/* ---------- Arquivos soltos na janela ---------- */
// Um arquivo solto fora das áreas que o aceitam faria o WebView2 NAVEGAR para ele (e o painel sumiria). As telas que aceitam
// arquivos (Jogos) tratam o drop nas áreas delas e chamam preventDefault; o resto cai aqui e é ignorado.
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  if (!e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; }
});
window.addEventListener('drop', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });

/* ---------- Estado do servidor ---------- */
function paintOnline() {
  const ok = state.online;
  const sick = ok && state.lastStatus >= 500;   // respondeu, mas com erro: continua "ativo" para dar para reiniciar pela tela Sistema
  $('#statusDot').className = `dot ${ok && !sick ? 'ok' : 'bad'}`;
  const v = state.meta.version ? ` · v${state.meta.version}` : '';
  $('#statusText').textContent = restarting ? 'Reiniciando…' : sick ? 'R3D PLAY com erro' : ok ? `R3D PLAY ativo${v}` : 'R3D PLAY desligado';
  const banner = $('#banner');
  banner.hidden = !(restarting || !ok || sick);
  banner.textContent = restarting ? 'Reiniciando o R3D PLAY… isso leva alguns segundos.'
    : !ok ? 'O R3D PLAY não está respondendo. Abra-o pela bandeja do Windows ou reinicie o computador; esta tela tenta reconectar sozinha.'
    : sick ? `O R3D PLAY respondeu com erro (HTTP ${state.lastStatus}). Veja o Registro na aba Sistema; se continuar, reinicie por lá.` : '';
}
let restarting = false;
bus.on('online', paintOnline);
bus.on('restarting', () => { restarting = true; paintOnline(); });
bus.on('restarted', async (ok) => {
  restarting = false;
  if (!ok) { await loadApps(); setOnline(state.lastStatus !== 0); }   // não reiniciou (ou não voltou): confere o estado de verdade
  paintOnline();
  if (ok) { await readConfig(); syncPanelPort(); }
});

/** Se a porta do servidor mudou (chave "port"), o painel passa a falar com a porta nova (a do painel é porta + 1). */
async function syncPanelPort() {
  const c = await readConfig();
  if (c.ok) native('rebase', { port: Number(c.values.port) || 47989 });
}

/** Verifica o servidor a cada poucos segundos (e atualiza "AO VIVO"). */
let pollBusy = false;
async function poll() {
  if (pollBusy || restarting || state.sessionBusy || document.hidden || !$('#auth').hidden) return;
  pollBusy = true;
  try {
    const was = state.currentApp;
    const ok = await loadApps();
    if (state.sessionBusy) return;   // a sessão foi trocada durante a chamada (alterar senha): ignora este resultado
    setOnline(state.lastStatus !== 0);
    paintOnline();
    if (!ok && state.lastStatus === 401) location.reload();   // a ponte já tentou entrar de novo com a senha guardada: pede o login
    if (ok && was !== state.currentApp) bus.emit('apps', state);
  } finally { pollBusy = false; }
}
setInterval(poll, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

/* ---------- Login / primeiro acesso ---------- */
function showAuth(first, err) {
  firstRun = first;
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#authTitle').textContent = first ? 'Criar acesso' : 'Entrar';
  $('#authSub').textContent = first ? 'Escolha um usuário e uma senha para proteger o R3D PLAY neste PC.' : 'Use o usuário e a senha do seu R3D PLAY. Só precisa digitar uma vez.';
  $('#authPass2Wrap').hidden = !first;
  $('#authPass2').required = first;
  $('#authBtn').textContent = first ? 'Criar e entrar' : 'Entrar';
  $('#authErr').hidden = !err;
  $('#authErr').textContent = err || '';
}
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#authBtn');
  btn.setAttribute('disabled', '');
  try {
    const user = $('#authUser').value.trim();
    const pass = $('#authPass').value;
    if (firstRun) {
      if (pass !== $('#authPass2').value) return showAuth(true, 'As senhas não são iguais.');
      const r = await api('POST', '/api/password', { newUsername: user, newPassword: pass, confirmNewPassword: pass });
      if (!r.json?.status) return showAuth(true, 'Não foi possível criar o acesso.');
    }
    const r = await native('login', { user, pass });
    if (!r.ok) return showAuth(false, 'Usuário ou senha incorretos.');
    $('#authPass').value = '';
    $('#authPass2').value = '';
    boot();
  } finally { btn.removeAttribute('disabled'); }
});

/* ---------- Configuração inicial (instalação nova) ---------- */
/** Deixa a tela virtual como principal durante o jogo (o jogo abre nela, na resolução do celular). Só mexe se a chave não existir. */
async function ensureDefaults() {
  const cur = await readConfig();
  if (!cur.ok || cur.values.dd_configuration_option) return false;
  const r = await patchConfig({ dd_configuration_option: 'ensure_primary' });
  if (!r.ok) { log(`ensureDefaults: ${r.error}`); return false; }
  toast('Configuração inicial aplicada. Reiniciando o R3D PLAY…', 'ok');
  return true;
}

/* ---------- Inicialização ---------- */
let started = false;
let synced = false;
async function boot() {
  const r = await api('GET', '/api/apps');
  if (r.status === 0) {       // servidor fora do ar: mostra o painel com aviso e tenta de novo
    $('#auth').hidden = true; $('#app').hidden = false;
    if (!started) { started = true; await loadViews(); await showTab(initialTab()); }
    state.lastStatus = 0;
    setOnline(false); paintOnline();
    setTimeout(boot, 4000);
    return;
  }
  if ([301, 302, 303, 307, 308].includes(r.status)) return showAuth(true);   // ainda sem usuário: o servidor redireciona para /welcome
  if (r.status === 401 || r.status === 403) return showAuth(false);
  $('#auth').hidden = true;
  $('#app').hidden = false;
  state.apps = r.json?.apps || [];
  state.currentApp = r.json?.current_app || '';
  state.lastStatus = r.status;
  setOnline(true);
  await readConfig();
  paintOnline();
  syncPanelPort();
  if (await ensureDefaults()) {
    await restartServer();
    await readConfig();
  }
  if (!started) { started = true; await loadViews(); }
  await showTab(initialTab());
  bus.emit('apps', state);
  if (!synced) {   // adiciona jogos novos da Steam/Epic/GOG/Ubisoft sem barulho (só uma vez por abertura da janela)
    synced = true;
    import('./lib/library.js').then((m) => m.autoSync?.()).catch((e) => log(`autoSync: ${e}`));
  }
}
const initialTab = () => (VIEW_IDS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home');
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (VIEW_IDS.includes(t) && t !== active) showTab(t); });
boot();
