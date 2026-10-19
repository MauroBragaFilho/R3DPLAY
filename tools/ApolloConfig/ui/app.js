'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Ponte com o app nativo ---------- */
let seq = 0;
const pending = new Map();
window.chrome.webview.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  pending.get(m.id)?.(m);
  pending.delete(m.id);
});
const native = (cmd, data = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  window.chrome.webview.postMessage({ id, cmd, ...data });
});
async function api(method, path, obj) {
  const r = await native('api', { method, path, body: obj === undefined ? null : JSON.stringify(obj) });
  let json = null;
  try { json = JSON.parse(r.body); } catch { /* resposta não-JSON */ }
  return { status: r.status, json, text: r.body };
}

/* ---------- Utilidades de interface ---------- */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}
function confirmDlg(msg, yes = 'Confirmar') {
  return new Promise((resolve) => {
    const d = $('#dlg');
    $('#dlgMsg').textContent = msg;
    $('#dlgYes').textContent = yes;
    d.onclose = () => resolve(d.returnValue === 'yes');
    d.showModal();
  });
}
const TITLES = { home: 'Início', games: 'Jogos', devices: 'Dispositivos', settings: 'Configurações', logs: 'Registro' };
function showTab(tab) {
  $$('.tab-button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.screen').forEach((s) => (s.hidden = s.id !== `screen-${tab}`));
  $('#pageTitle').textContent = TITLES[tab];
  ({ home: refreshHome, games: refreshGames, devices: refreshDevices, settings: loadSettings, logs: loadLogs })[tab]();
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab-button'); if (b) showTab(b.dataset.tab); });
const savedTheme = (() => { try { return localStorage.getItem('theme'); } catch { return null; } })();
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('#themeBtn').onclick = () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch { /* sem armazenamento */ }
};

/* ---------- Estado ---------- */
let apps = [];
let currentApp = '';
let scanned = new Map(); // uuid -> jogo detectado (origem e id, para capas)
let online = false;

async function loadApps() {
  const r = await api('GET', '/api/apps');
  if (r.status === 200 && r.json) { apps = r.json.apps || []; currentApp = r.json.current_app || ''; return true; }
  return false;
}
function setOnline(ok) {
  online = ok;
  $('#statusDot').className = `dot ${ok ? 'ok' : 'bad'}`;
  $('#statusText').textContent = ok ? 'Apollo ativo' : 'Apollo desligado';
}

/* ---------- Início ---------- */
async function refreshHome() {
  const info = await native('info');
  $('#ipChips').innerHTML = (info.ips || []).map((i) => {
    const label = { wifi: 'Wi‑Fi', lan: 'Cabo', tailscale: 'Tailscale (fora de casa)', vpn: 'VPN' }[i.kind] || i.name;
    return `<button class="chip" data-ip="${esc(i.ip)}" title="Copiar"><i class="ms">content_copy</i>${esc(i.ip)} <small>${label}</small></button>`;
  }).join('') || '<span class="muted">Sem rede detectada.</span>';
  const ok = await loadApps();
  setOnline(ok);
  const bad = !ok;
  $('.hero').classList.toggle('bad', bad);
  $('#heroTitle').textContent = bad ? 'O Apollo não está respondendo' : currentApp ? 'Transmissão em andamento' : 'Seu PC está pronto para transmitir';
  $('#heroSub').textContent = bad ? 'Abra o Apollo pela bandeja do Windows ou reinicie o serviço.' : currentApp ? `Jogando: ${apps.find((a) => a.uuid === currentApp)?.name || 'jogo'}` : 'Abra seus jogos no celular, tablet ou outra TV.';
  $('#statGames').textContent = ok ? apps.length : '–';
  $('#statNow').textContent = currentApp ? '1' : '0';
  $('#homeStop').hidden = !currentApp;
  const c = await api('GET', '/api/clients/list');
  $('#statDevices').textContent = c.json?.named_certs ? c.json.named_certs.length : '–';
}
$('#ipChips').addEventListener('click', async (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  try { await navigator.clipboard.writeText(c.dataset.ip); toast('Endereço copiado', 'ok'); } catch { toast(c.dataset.ip); }
});
$('#pairForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#pairPin').value.trim();
  if (!/^\d{4}$/.test(pin)) return toast('Digite os 4 números mostrados no celular', 'err');
  const r = await api('POST', '/api/pin', { pin, name: $('#pairName').value.trim() || 'Meu celular' });
  if (r.json?.status) { toast('Celular pareado!', 'ok'); $('#pairPin').value = ''; $('#pairName').value = ''; refreshHome(); }
  else toast('PIN não aceito. Confira se o celular ainda mostra o PIN.', 'err');
});
$('#homeScan').onclick = () => { showTab('games'); scanGames(true); };
$('#homeStop').onclick = stopStream;
async function stopStream() {
  await api('POST', '/api/apps/close', {});
  toast('Transmissão encerrada', 'ok');
  setTimeout(() => { loadApps().then(() => { refreshHome(); if (!$('#screen-games').hidden) renderGames(); }); }, 800);
}

/* ---------- Jogos ---------- */
const SOURCES = { steam: 'Steam', epic: 'Epic', gog: 'GOG', ubisoft: 'Ubisoft' };
function coverUrl(app) {
  const g = scanned.get(app.uuid);
  return g?.source === 'steam' ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.id}/library_600x900.jpg` : '';
}
async function refreshGames() {
  if (!(await loadApps())) { setOnline(false); apps = []; }
  const s = await native('scan');
  scanned = new Map((s.games || []).map((g) => [g.uuid, g]));
  renderGames();
}
function renderGames() {
  const q = $('#gameSearch').value.trim().toLowerCase();
  const list = apps.filter((a) => a.name.toLowerCase().includes(q));
  $('#gamesEmpty').hidden = list.length > 0;
  $('#gamesGrid').innerHTML = list.map((a) => {
    const src = SOURCES[scanned.get(a.uuid)?.source] || 'Aplicativo';
    const cover = coverUrl(a);
    const live = a.uuid === currentApp;
    return `<article class="game" data-uuid="${esc(a.uuid)}">
      <div class="cover"><span class="letter">${esc(a.name.trim()[0] || '?').toUpperCase()}</span>${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        ${live ? '<span class="badge-live">AO VIVO</span>' : ''}
        <div class="game-actions"><button class="icon-btn" data-act="del" title="Remover da lista" aria-label="Remover ${esc(a.name)}"><i class="ms">delete</i></button></div>
        <div class="play-overlay"><button class="btn primary" data-act="${live ? 'stop' : 'play'}"><i class="ms">${live ? 'stop' : 'play_arrow'}</i>${live ? 'Encerrar' : 'Iniciar'}</button></div>
      </div>
      <div class="game-info"><strong title="${esc(a.name)}">${esc(a.name)}</strong><small>${src}</small></div></article>`;
  }).join('');
}
$('#gameSearch').addEventListener('input', renderGames);
$('#gamesGrid').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const uuid = btn.closest('.game').dataset.uuid;
  const app = apps.find((a) => a.uuid === uuid);
  if (btn.dataset.act === 'play') {
    const r = await api('POST', '/api/apps/launch', { uuid });
    toast(r.status === 200 ? `Iniciando ${app.name} no PC…` : 'Não consegui iniciar o jogo', r.status === 200 ? 'ok' : 'err');
    setTimeout(() => loadApps().then(renderGames), 1500);
  } else if (btn.dataset.act === 'stop') {
    stopStream();
  } else if (btn.dataset.act === 'del' && await confirmDlg(`Remover "${app.name}" da lista? O jogo não é desinstalado.`, 'Remover')) {
    await api('POST', '/api/apps/delete', { uuid });
    await loadApps(); renderGames();
  }
});
async function scanGames(manual) {
  const btn = manual ? $('#gamesScan') : null;
  btn?.setAttribute('disabled', '');
  const s = await native('scan');
  const found = s.games || [];
  scanned = new Map(found.map((g) => [g.uuid, g]));
  if (!(await loadApps())) { btn?.removeAttribute('disabled'); return; }
  const have = new Set(apps.map((a) => a.uuid));
  let added = 0;
  for (const g of found.filter((x) => !have.has(x.uuid))) {
    const r = await api('POST', '/api/apps', g.app);
    if (r.json?.status) added++;
  }
  await loadApps();
  btn?.removeAttribute('disabled');
  if (!$('#screen-games').hidden) renderGames();
  if (manual || added) toast(added ? `${added} jogo(s) novo(s) adicionado(s)` : `${found.length} jogos encontrados, nenhum novo`, 'ok');
}
$('#gamesScan').onclick = () => scanGames(true);

/* ---------- Dispositivos ---------- */
async function refreshDevices() {
  const r = await api('GET', '/api/clients/list');
  const list = r.json?.named_certs || [];
  $('#devicesEmpty').hidden = list.length > 0;
  $('#deviceList').hidden = list.length === 0;
  $('#unpairAll').hidden = list.length === 0;
  $('#deviceList').innerHTML = list.map((d) => `<div class="list-row" data-uuid="${esc(d.uuid)}"><i class="ms">smartphone</i><div class="grow"><strong>${esc(d.name || 'Dispositivo')}</strong><small>Pareado</small></div><button class="btn danger" data-act="unpair"><i class="ms">link_off</i> Desparear</button></div>`).join('');
}
$('#deviceList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act="unpair"]');
  if (!b || !(await confirmDlg('Desparear este dispositivo? Ele precisará de um novo PIN.', 'Desparear'))) return;
  await api('POST', '/api/clients/unpair', { uuid: b.closest('.list-row').dataset.uuid });
  refreshDevices();
});
$('#unpairAll').onclick = async () => {
  if (!(await confirmDlg('Desparear TODOS os dispositivos? Qualquer transmissão em andamento será encerrada.', 'Desparear todos'))) return;
  await api('POST', '/api/clients/unpair-all', {});
  refreshDevices();
};

/* ---------- Configurações ---------- */
let rawConfig = {};
const CFG_KEYS = ['sunshine_name', 'origin_web_ui_allowed', 'gamepad', 'max_bitrate', 'upnp'];
async function loadSettings() {
  const r = await api('GET', '/api/config');
  rawConfig = r.json || {};
  $('#cfg-sunshine_name').value = rawConfig.sunshine_name || '';
  $('#cfg-origin_web_ui_allowed').value = rawConfig.origin_web_ui_allowed || 'pc';
  $('#cfg-gamepad').value = rawConfig.gamepad || 'auto';
  $('#cfg-max_bitrate').value = rawConfig.max_bitrate ? Math.round(Number(rawConfig.max_bitrate) / 1000) : 0;
  $('#cfg-upnp').checked = rawConfig.upnp === 'enabled' || rawConfig.upnp === true;
}
$('#saveCfg').onclick = async () => {
  const cfg = { ...rawConfig };
  ['status', 'platform', 'version', 'vdisplayStatus'].forEach((k) => delete cfg[k]);
  cfg.sunshine_name = $('#cfg-sunshine_name').value.trim();
  cfg.origin_web_ui_allowed = $('#cfg-origin_web_ui_allowed').value;
  cfg.gamepad = $('#cfg-gamepad').value;
  const mbps = Number($('#cfg-max_bitrate').value) || 0;
  cfg.max_bitrate = mbps > 0 ? String(mbps * 1000) : '';
  cfg.upnp = $('#cfg-upnp').checked ? 'enabled' : 'disabled';
  const r = await api('POST', '/api/config', cfg);
  if (!r.json?.status) return toast('Não foi possível salvar', 'err');
  await api('POST', '/api/restart', {});
  toast('Salvo. Reiniciando o Apollo…', 'ok');
  setTimeout(boot, 4000);
};
$('#advBtn').onclick = () => native('advanced');
$('#logoutBtn').onclick = async () => { await native('logout'); location.reload(); };

/* ---------- Registro ---------- */
async function loadLogs() {
  const r = await api('GET', '/api/logs');
  const box = $('#logsBox');
  box.textContent = r.text || 'Sem registros.';
  box.scrollTop = box.scrollHeight;
}
$('#logsRefresh').onclick = loadLogs;
$('#logsCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#logsBox').textContent); toast('Copiado', 'ok'); } catch { toast('Não foi possível copiar', 'err'); } };

/* ---------- Login / primeiro acesso ---------- */
let firstRun = false;
function showAuth(first, err) {
  firstRun = first;
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#authTitle').textContent = first ? 'Criar acesso' : 'Entrar';
  $('#authSub').textContent = first ? 'Escolha um usuário e uma senha para proteger o Apollo neste PC.' : 'Use o usuário e a senha do seu Apollo. Só precisa digitar uma vez.';
  $('#authPass2Wrap').hidden = !first;
  $('#authPass2').required = first;
  $('#authBtn').textContent = first ? 'Criar e entrar' : 'Entrar';
  $('#authErr').hidden = !err;
  $('#authErr').textContent = err || '';
}
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
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
  boot();
});

/* ---------- Inicialização ---------- */
async function boot() {
  const r = await api('GET', '/api/apps');
  if (r.status === 0) { // Apollo fora do ar: mostra o painel com aviso e tenta de novo
    $('#auth').hidden = true; $('#app').hidden = false; setOnline(false); showTab('home');
    setTimeout(boot, 4000);
    return;
  }
  if (r.status === 302 || r.status === 303) return showAuth(true);
  if (r.status === 401) return showAuth(false);
  $('#auth').hidden = true;
  $('#app').hidden = false;
  setOnline(true);
  showTab(TITLES[location.hash.slice(1)] ? location.hash.slice(1) : 'home');
  scanGames(false); // adiciona jogos novos sem barulho
}
boot();
