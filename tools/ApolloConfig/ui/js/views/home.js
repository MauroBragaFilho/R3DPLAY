// Tela Início: responde "está tudo pronto para jogar?" para quem não é técnico.
// Estado do servidor, como conectar um celular (endereços IP), resumo clicável, uso do PC ao vivo e atalhos.
// A lógica de verdade (leitura/formatação das estatísticas, estados, IPs) fica em js/lib/stats.js, que é pura e testada.
import { h, icon, api, native, state, bus, toast, confirmDlg, busy, go, loadApps, setOnline, sleep, log } from '../core.js';
import { readConfig } from '../lib/config.js';
import * as S from '../lib/stats.js';

const STATS_EVERY = 3000;         // contrato: nunca consultar com intervalo menor que 3 s
const CLIENTS_EVERY = 3;          // a lista de dispositivos muda pouco: relê a cada 3 leituras de uso (≈ 9 s)
const STATS_TIMEOUT = 6000;       // se a ponte não responder, conta como falha (não trava o ciclo)
const LOAD_TIMEOUT = 8000;        // prazo para a lista de jogos/dispositivos (a ponte espera até 30 s: a tela não)
const DEFAULT_PORT = 47989;       // porta HTTP padrão do servidor (onde fica o /r3d/stats)

/* ---------- Estado da tela ---------- */
let ui = {};                      // referências do DOM, criadas em mount()
let active = false;               // a aba Início está aberta?
let session = 0;                  // muda a cada show()/hide(): respostas atrasadas de uma sessão antiga são ignoradas
let offs = [];                    // cancelamentos dos ouvintes do bus
let statsTimer = 0;
let tickBusy = 0;                 // sessão que tem uma leitura em andamento (0 = nenhuma)
let tickN = 0;
let failStreak = 0;
let lastStats = null;             // última leitura boa (estatísticas normalizadas)
let lastAt = 0;
let usageState = 'loading';       // loading | ok | off
let gpuSel = '';                  // placa de vídeo escolhida pelo toque ('' = automática)
let statsPort = DEFAULT_PORT;
let shareLibrary = true;          // opção "Compartilhar biblioteca de jogos": desligada, o servidor recusa a leitura do uso (403)
let lastError = '';               // motivo da última falha na leitura do uso
let restarting = false;           // vive o tempo todo (os ouvintes são ligados no mount): um reinício pode começar ou acabar em outra aba
let closing = false;              // encerrando a transmissão (mantém o botão desligado mesmo se a tela se redesenhar)
let loaded = false;               // já tentamos falar com o servidor ao menos uma vez?
let info = { status: 'loading', host: '', ips: [] };              // native("info")
let clients = { status: 'loading', total: 0, connected: 0 };      // GET /api/clients/list
const sigs = {};                  // "assinatura" do que está desenhado: só redesenha quando muda (preserva foco e leitores de tela)
const copyResets = new Set();     // restauram o ícone dos chips de IP após copiar
const inflight = {};              // leituras em andamento: pedir de novo enquanto uma não voltou reaproveita a mesma

const live = (my) => active && my === session;
/** Espera uma promessa, mas desiste em ms (devolve null): a ponte nativa pode não responder nunca. */
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);
/** Uma leitura por vez: se a anterior ainda não voltou (ponte lenta), devolve a mesma promessa em vez de empilhar chamadas. */
function once(name, fn) {
  if (!inflight[name]) inflight[name] = Promise.resolve().then(fn).finally(() => { delete inflight[name]; });
  return inflight[name];
}

/* ================= Cartão principal (estado do servidor) ================= */
function heroView(hs) {
  switch (hs.kind) {
    case 'loading':
      return { cls: '', spin: true, title: 'Verificando o R3D PLAY…', sub: 'Só um instante.' };
    case 'restarting':
      return { cls: '', spin: true, badge: ['warn', 'Reiniciando'], title: 'Reiniciando o R3D PLAY…', sub: 'Isso leva alguns segundos. Esta tela volta ao normal sozinha.' };
    case 'offline':
      return {
        cls: 'bad', ico: 'power_off', badge: ['bad', 'Desligado'], action: 'retry',
        title: 'O R3D PLAY não está respondendo',
        sub: 'Seu PC ainda não está pronto para transmitir. Abra o R3D PLAY pela bandeja do Windows (perto do relógio) ou reinicie o computador. Esta tela tenta se reconectar sozinha.',
      };
    case 'streaming':
      return {
        cls: 'live', ico: 'sports_esports', badge: ['live', 'Ao vivo'], action: 'stop',
        title: ['Transmissão em andamento', hs.game ? [': ', h('span', { class: 'hm-game', text: hs.game })] : null],
        sub: 'Há um jogo aberto para transmissão. Se ninguém estiver jogando, encerre a transmissão para liberar o PC.',
      };
    case 'attention':
      return {
        cls: 'warn', ico: 'warning', badge: ['warn', 'Ativo'],
        title: 'O R3D PLAY está ativo, mas precisa de atenção',
        sub: 'A tela virtual não está pronta. Veja o aviso logo abaixo.',
      };
    default:
      return {
        cls: 'ok', ico: 'check_circle', badge: ['ok', 'Ativo'],
        title: 'Seu PC está pronto para transmitir',
        sub: hs.needsDevice
          ? 'Falta só conectar um celular. Siga os passos do cartão "Conectar um celular", logo abaixo.'
          : 'Abra o R3D LAUNCHER no celular e escolha um jogo.',
      };
  }
}

function renderHero() {
  if (!ui.hero) return;
  const vd = S.vdisplayWarning(state.meta.vdisplayStatus);
  const hs = S.heroState({
    loaded, online: state.online, restarting, currentApp: state.currentApp, apps: state.apps,
    vdisplayProblem: !!vd, deviceCount: clients.status === 'ok' ? clients.total : null,
  });
  const ver = S.formatVersion(state.meta.version);
  const sig = JSON.stringify([hs, ver, info.host, closing]);
  if (sig === sigs.hero) return;
  sigs.hero = sig;

  const v = heroView(hs);
  const meta = [];
  if (info.host) meta.push(h('span', { class: 'hm-meta-item' }, icon('computer'), `PC: ${info.host}`));
  if (ver && state.online) meta.push(h('span', { class: 'hm-meta-item' }, `Versão ${ver}`));

  let action = null;
  if (v.action === 'stop') {
    action = h('button', {
      class: 'btn danger', type: 'button', disabled: closing,
      on: { click: (e) => stopStream(e.currentTarget, hs.game) },
    }, closing ? [h('span', { class: 'spinner' }), 'Encerrando…'] : [icon('stop'), 'Encerrar transmissão']);
  } else if (v.action === 'retry') {
    action = h('button', { class: 'btn', type: 'button', on: { click: (e) => retryConnection(e.currentTarget) } }, icon('refresh'), 'Tentar agora');
  }

  // Quem estava com o foco no cartão (o botão some ou é recriado a cada mudança de estado) não pode ficar sem foco nenhum.
  const hadFocus = ui.hero.contains(document.activeElement);
  ui.hero.className = `card hero hm-hero ${v.cls}`.trim();
  // (replaceChildren transformaria null em o texto "null": só passa o que existe)
  ui.hero.replaceChildren(...[
    h('div', { class: 'hero-icon' }, v.spin ? h('span', { class: 'spinner' }) : icon(v.ico)),
    h('div', { class: 'hm-hero-text' },
      v.badge ? h('div', { class: 'hm-badges' }, h('span', { class: `badge ${v.badge[0]}`, text: v.badge[1] })) : null,
      h('h2', { class: 'hm-hero-title', tabindex: '-1' }, v.title),
      h('p', { class: 'muted', text: v.sub }),
      meta.length ? h('div', { class: 'hm-meta' }, meta) : null),
    action ? h('div', { class: 'hm-hero-actions' }, action) : null,
  ].filter(Boolean));
  if (hadFocus) focusHero();
}

/** Foco no primeiro botão disponível do cartão principal; sem botão (ou desligado), no título (que aceita foco só por código). */
function focusHero() {
  if (!active || !ui.hero) return;
  (ui.hero.querySelector('button:not([disabled])') || ui.hero.querySelector('h2'))?.focus({ preventScroll: true });
}

/** Encerra a transmissão (mesma chamada do botão "Encerrar" do jogo). Pede confirmação: derruba quem está jogando. */
async function stopStream(btn, game) {
  const ok = await confirmDlg(
    `Isso encerra a transmissão em andamento${game ? ` e fecha "${game}"` : ''}. Quem estiver jogando no celular será desconectado.`,
    'Encerrar transmissão', { title: 'Encerrar a transmissão?' },
  );
  if (!ok) return;
  closing = true;
  renderHero();
  await busy(btn, async () => {
    try {
      const r = await api('POST', '/api/apps/close');   // pode demorar alguns segundos: o servidor espera o jogo fechar
      if (r.status === 0) { toast('O R3D PLAY não respondeu. Confira se ele está ligado e tente de novo.', 'err'); return; }
      if (!r.ok || r.json?.status === false) { toast(`Não consegui encerrar a transmissão (erro ${r.status}). Tente de novo.`, 'err'); return; }
      toast('Transmissão encerrada.', 'ok');
      await sleep(800);
      await loadApps();
      if (state.currentApp) {   // o jogo ainda estava fechando: confere mais uma vez
        await sleep(2000);
        await loadApps();
        if (state.currentApp) toast('O jogo ainda está fechando. Esta tela atualiza sozinha.');
      }
    } catch (e) {
      log(`home stopStream: ${e}`);
      toast('Algo deu errado ao encerrar a transmissão. Tente de novo.', 'err');
    }
  }).finally(() => { closing = false; renderHero(); renderSummary(); focusHero(); });
}

/** Botão "Tentar agora" do aviso de servidor desligado. */
async function retryConnection(btn) {
  await busy(btn, async () => {
    const my = session;
    const ok = (await withTimeout(loadApps(), LOAD_TIMEOUT)) === true;
    setOnline(ok);
    if (!ok) { toast('O R3D PLAY ainda não está respondendo.', 'err'); return; }
    toast('R3D PLAY conectado.', 'ok');
    await Promise.all([loadConfig(my), loadClients(my)]);
    tick();
  });
  focusHero();   // o botão foi desligado durante a espera e pode ter perdido o foco
}

/* ================= Aviso do driver de tela virtual ================= */
function renderVdisplay() {
  if (!ui.vdisplay) return;
  // Com o servidor desligado o último valor lido pode já não valer: não manda ninguém mexer em configuração por causa dele.
  const w = state.online ? S.vdisplayWarning(state.meta.vdisplayStatus) : null;
  const sig = w ? String(w.code) : '';
  if (sig === sigs.vd) return;
  sigs.vd = sig;
  ui.vdisplay.hidden = !w;
  if (!w) { ui.vdisplay.replaceChildren(); return; }
  ui.vdisplay.replaceChildren(
    icon('warning'),
    h('div', { class: 'hm-vd-text' },
      h('strong', { text: `A tela virtual não está pronta (${w.label.toLowerCase()}).` }),
      h('p', { text: `Sem ela, o jogo pode não abrir na resolução do celular. ${w.help}` })),
    // O status do driver fica na categoria "Áudio e vídeo", não na primeira categoria das configurações.
    h('button', { class: 'btn', type: 'button', on: { click: () => go('settings', { category: 'audiovideo' }) } }, icon('settings'), 'Ver tela virtual'),
  );
}

/* ================= Conectar um celular ================= */
/** Copia para a área de transferência; tem plano B para quando o navegador embutido recusa a API moderna. */
async function copyText(t) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(t); return true; }
  } catch { /* cai no plano B */ }
  try {
    const ta = h('textarea', { value: t, readOnly: true, 'aria-hidden': 'true', tabindex: '-1', style: { position: 'fixed', left: '-9999px', top: '0', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

async function copyIp(btn, ip) {
  if (await copyText(ip)) {
    toast(`Endereço ${ip} copiado.`, 'ok');
    const ico = btn.querySelector('.ms');
    if (!ico) return;
    btn.classList.add('copied');
    ico.textContent = 'check';
    const reset = () => { clearTimeout(t); copyResets.delete(reset); btn.classList.remove('copied'); ico.textContent = 'content_copy'; };
    const t = setTimeout(reset, 1800);
    copyResets.add(reset);
  } else {
    toast(`Não consegui copiar. Digite este endereço no celular: ${ip}`, 'err');
  }
}

function chipsView() {
  if (info.status === 'loading') return [h('span', { class: 'skeleton hm-chip-skel' }), h('span', { class: 'skeleton hm-chip-skel' })];
  // A rede pode ainda não ter subido quando a janela abre: o botão (e a releitura automática) evitam que o aviso fique velho.
  const again = (label) => h('button', { class: 'btn ghost', type: 'button', on: { click: (e) => busy(e.currentTarget, () => loadInfo(session)) } }, icon('refresh'), label);
  if (info.status === 'error') {
    return [h('div', { class: 'hm-note-row' }, icon('error'), h('span', { text: 'Não consegui descobrir o endereço deste PC.' }), again('Tentar de novo'))];
  }
  if (info.ips.length === 0) {
    return [h('div', { class: 'hm-note-row' },
      icon('wifi_off'),
      h('span', { text: 'Nenhuma rede encontrada. Conecte o PC ao Wi-Fi ou a um cabo de rede para parear um celular. Esta tela procura de novo sozinha.' }),
      again('Procurar de novo'))];
  }
  return info.ips.map((i) => h('button', {
    class: 'chip hm-chip', type: 'button',
    title: `Copiar ${i.ip}`, 'aria-label': `Copiar o endereço ${i.ip}, ${i.label}`,
    on: { click: (e) => copyIp(e.currentTarget, i.ip) },
  }, icon('content_copy'), i.ip, h('small', { text: i.label })));
}

function renderConnect() {
  if (!ui.connect) return;
  const noDevices = state.online && clients.status === 'ok' && clients.total === 0;
  const sig = JSON.stringify([noDevices, state.online, info.status, info.ips.map((i) => `${i.ip}/${i.kind}`)]);
  if (sig === sigs.connect) return;
  sigs.connect = sig;
  ui.connect.classList.toggle('hm-focus', noDevices);   // sem nenhum celular pareado: este é o primeiro passo (com o servidor desligado, não)
  ui.connectBadge.hidden = !noDevices;
  ui.offlineNote.hidden = state.online;
  const hadFocus = ui.chips.contains(document.activeElement);
  ui.chips.replaceChildren(...chipsView());
  if (hadFocus) ui.chips.querySelector('button')?.focus({ preventScroll: true });   // o botão "procurar de novo" some quando os endereços aparecem
  const hint = info.status === 'ok' ? S.ipsHint(info.ips) : '';
  ui.ipHint.textContent = hint;
  ui.ipHint.hidden = !hint;
}

/* ================= Resumo ================= */
function renderSummary() {
  if (!ui.tiles) return;
  const tiles = S.summaryTiles({ online: state.online, appsCount: state.apps.length, streaming: !!state.currentApp, clients });
  const sig = JSON.stringify(tiles);
  if (sig === sigs.summary) return;
  sigs.summary = sig;
  const where = { games: 'Jogos', devices: 'Dispositivos' };
  ui.tiles.replaceChildren(...tiles.map((t) => h('button', {
    class: 'stat hm-stat', type: 'button', title: `Abrir a aba ${where[t.tab]}`,
    'aria-label': `${t.label}: ${t.value}, ${t.sub}. Abrir a aba ${where[t.tab]}.`,
    on: { click: () => go(t.tab) },
  }, h('strong', { text: t.value }), h('span', { text: t.label }), h('small', { text: t.sub }))));
}

/* ================= Atalhos ================= */
/** "Procurar jogos instalados": usa o módulo de biblioteca da tela Jogos (carregado só agora, pode ainda não existir). */
async function scanGames(btn) {
  const my = session;   // a aba em que o clique aconteceu (a busca demora; ver o fim da função)
  const label = btn.querySelector('.hm-btn-label');
  const original = label?.textContent;
  await busy(btn, async () => {
    if (label) label.textContent = 'Procurando…';
    try {
      let lib = null;
      try { lib = await import('../lib/library.js'); } catch (e) { log(`home: library.js indisponível: ${e}`); }
      if (!lib || typeof lib.detectGames !== 'function') {
        toast('A busca de jogos ainda não está disponível nesta versão do painel.', 'err');
        return;
      }
      let res;
      try {
        res = await lib.detectGames({ manual: true });
      } catch (e) {
        log(`home detectGames: ${e}`);
        toast('Não consegui procurar os jogos agora. Tente de novo em instantes.', 'err');
        return;
      }
      // A busca (com capas) leva segundos: se a pessoa já foi para outra aba, não a arrasta de volta (nem dispara o aviso de "alterações não salvas").
      // Em caso de erro ou de recusa na confirmação o toast da busca já explicou; ficar aqui é o esperado.
      if (!live(my) || res?.error || res?.declined) return;
      go('games');
    } finally { if (label && original) label.textContent = original; }
  });
}

/* ================= Uso do PC (cartões que se atualizam no lugar) ================= */
const LEVELS = ['ok', 'warn', 'bad', 'off'];

/** Cartão com número grande, linha de apoio e medidor. Os elementos são criados uma vez e só têm o texto/largura trocados. */
function makeValueCard(title, meterLabel, opts = {}) {
  const value = h('strong', { class: 'hm-num' });
  const unit = h('span', { class: 'hm-unit' });
  const sub = h('p', { class: 'hm-sub' });
  const extra = h('p', { class: 'hm-extra' });
  const bar = h('i');
  const meter = h('div', { class: 'meter hm-meter off', role: 'meter', 'aria-label': meterLabel, 'aria-valuemin': 0, 'aria-valuemax': 100, hidden: opts.meter === false }, bar);
  const tag = h('span', { class: 'badge', hidden: true });
  const head = h('div', { class: 'hm-head' }, h('h4', { text: title }), tag, opts.headExtra || null);
  const body = h('div', { class: 'hm-body' }, h('div', { class: 'hm-value' }, value, unit), sub, meter, extra);
  const skel = h('div', { class: 'hm-skel', 'aria-hidden': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  const el = h('article', { class: 'card hm-metric', dataset: { state: 'loading' } }, head, body, skel);
  const setMeter = (pct, level) => {
    meter.className = `meter hm-meter ${LEVELS.includes(level) ? level : 'off'}`;
    bar.style.width = pct === null || pct === undefined ? '0%' : `${Math.max(0, Math.min(100, pct))}%`;
    if (pct === null || pct === undefined) { meter.removeAttribute('aria-valuenow'); meter.setAttribute('aria-hidden', 'true'); }
    else { meter.setAttribute('aria-valuenow', String(Math.round(pct))); meter.removeAttribute('aria-hidden'); }
  };
  return {
    el,
    setState(s) { el.dataset.state = s; },
    /** vm = modelo de S.buildUsage; null = indisponível. */
    set(vm) {
      if (!vm) {
        value.textContent = '—'; unit.textContent = ''; sub.textContent = 'indisponível'; extra.textContent = '';
        tag.hidden = true; setMeter(null, 'off');
        return;
      }
      value.textContent = vm.valueText;
      unit.textContent = vm.unit ? ` ${vm.unit}` : '';
      sub.textContent = vm.sub || '';
      sub.title = vm.sub || '';
      extra.textContent = vm.extra || '';
      extra.hidden = !vm.extra;
      tag.hidden = !vm.tag;
      tag.textContent = vm.tag || '';
      tag.className = `badge${opts.tagClass ? ` ${opts.tagClass(vm)}` : ''}`;
      setMeter(vm.pct, vm.level);
    },
  };
}

function makeGpuCard() {
  // O botão fica no cabeçalho (teclado e leitor de tela); o clique em qualquer parte do cartão também alterna.
  const sw = h('button', { class: 'hm-switch', type: 'button', hidden: true }, icon('swap_horiz'), h('span'));
  const card = makeValueCard('Placa de vídeo', 'Uso da placa de vídeo', { headExtra: sw });
  const posEl = sw.querySelector('span');
  const next = () => {
    if (!lastStats || lastStats.gpus.length < 2) return;
    gpuSel = S.nextGpuKey(lastStats.gpus, gpuSel);
    renderUsage();
  };
  card.el.addEventListener('click', next);
  const baseSet = card.set;
  card.set = (vm) => {
    baseSet(vm);
    const multi = !!vm && vm.count > 1;
    card.el.classList.toggle('can-switch', multi);
    sw.hidden = !multi;
    if (multi) {
      posEl.textContent = `${vm.position}/${vm.count}`;
      const label = `Mostrar a próxima placa de vídeo (agora: ${vm.position} de ${vm.count})`;
      sw.setAttribute('aria-label', label);
      sw.title = label;
      card.el.title = 'Clique para ver a próxima placa de vídeo';
    } else card.el.removeAttribute('title');
  };
  return card;
}

/** Cartão de lista (discos e temperaturas): refaz as linhas só quando o conteúdo muda. */
function makeListCard(title, emptyText, rowView) {
  const list = h('div', { class: 'hm-list' });
  const empty = h('p', { class: 'hm-sub', text: emptyText, hidden: true });
  const body = h('div', { class: 'hm-body hm-body-list' }, list, empty);
  const skel = h('div', { class: 'hm-skel', 'aria-hidden': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  const tag = h('span', { class: 'badge', hidden: true });
  const el = h('article', { class: 'card hm-metric', dataset: { state: 'loading' } }, h('div', { class: 'hm-head' }, h('h4', { text: title }), tag), body, skel);
  let sig = '';
  return {
    el,
    setState(s) { el.dataset.state = s; },
    set(rows, text = emptyText, tagText = '') {
      tag.hidden = !tagText;
      tag.textContent = tagText;
      const s = JSON.stringify([rows, text]);
      if (s === sig) return;
      sig = s;
      empty.textContent = text;
      empty.hidden = !!(rows && rows.length);
      list.replaceChildren(...(rows || []).map(rowView));
    },
  };
}

const diskRow = (d) => h('div', { class: 'hm-disk' },
  h('div', { class: 'hm-disk-top' }, h('strong', { text: d.name }), h('span', { text: `${d.freeText} ${d.totalText}` })),
  h('div', { class: `meter hm-meter ${d.level}`, ...(d.pct === null ? { 'aria-hidden': 'true' } : { role: 'meter', 'aria-label': `Espaço usado em ${d.name}`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(d.pct) }) },
    h('i', { style: { width: `${d.pct === null ? 0 : d.pct}%` } })));

const tempRow = (t) => h('div', { class: 'hm-temp-item' },
  h('div', { class: 'hm-temp' }, h('span', { text: t.label }), h('strong', { class: t.level, text: t.valueText === '—' ? 'indisponível' : t.valueText })),
  t.pct === null ? null : h('div', { class: `meter hm-meter ${t.level}`, role: 'meter', 'aria-label': `Temperatura: ${t.label}`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(t.pct) }, h('i', { style: { width: `${t.pct}%` } })));

function makeUsageCards() {
  return {
    cpu: makeValueCard('Processador', 'Uso do processador'),
    ram: makeValueCard('Memória', 'Memória em uso', { tagClass: (vm) => (vm.level === 'warn' || vm.level === 'bad' ? vm.level : '') }),
    gpu: makeGpuCard(),
    disks: makeListCard('Armazenamento', 'indisponível', diskRow),
    temps: makeListCard('Temperatura', 'indisponível', tempRow),
    stream: makeValueCard('Transmissão', 'Quadros por segundo', { meter: false, tagClass: (vm) => (vm.active ? 'live' : '') }),
  };
}

function renderUsage() {
  const c = ui.usage;
  if (!c) return;
  const all = Object.values(c);
  const note = ui.usageNote;
  if (usageState === 'loading') {
    all.forEach((x) => x.setState('loading'));
    note.hidden = true;
    delete note.dataset.kind;
    ui.usageBadge.hidden = true;
    return;
  }
  if (usageState === 'off') {
    all.forEach((x) => x.setState('off'));
    c.cpu.set(null); c.ram.set(null); c.gpu.set(null); c.stream.set(null);
    c.disks.set([], 'indisponível'); c.temps.set([], 'indisponível');
    const why = S.statsFailure({ error: lastError, shareLibrary, online: state.online });
    if (note.dataset.kind !== why.kind) {   // (só troca o texto quando o motivo muda: o leitor de tela não repete o aviso a cada leitura)
      note.dataset.kind = why.kind;
      note.querySelector('span').textContent = why.message;
      ui.usageNoteBtn.hidden = why.kind !== 'blocked';
    }
    note.hidden = false;
    ui.usageBadge.hidden = true;
    return;
  }
  const vm = S.buildUsage(lastStats, { gpuKey: gpuSel });
  all.forEach((x) => x.setState('ok'));
  c.cpu.set(vm.cpu);
  c.ram.set(vm.ram);
  c.gpu.set(vm.gpu);
  c.stream.set(vm.stream);
  c.disks.set(vm.disks, 'indisponível', vm.disks.length > 1 ? `${vm.disks.length} unidades` : '');
  c.temps.set(vm.temps, 'indisponível');
  note.hidden = true;
  delete note.dataset.kind;
  ui.usageBadge.hidden = false;
}

/* ================= Carregamento de dados ================= */
async function loadConfig(my) {
  try {
    const cfg = await readConfig();   // também atualiza state.meta (versão, driver de tela virtual)
    if (live(my) && cfg.ok) {
      const p = Number(cfg.values.port);
      statsPort = Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : DEFAULT_PORT;
      shareLibrary = S.isShareLibraryOn(cfg.values.share_library);
    }
  } catch (e) { log(`home loadConfig: ${e}`); }
  if (live(my)) { renderHero(); renderVdisplay(); }
}

// (Cada leitura é feita por once(): só a parte de dados fica dentro dele; quem pediu desenha depois, se a sessão ainda for a dele.)
const fetchInfo = () => once('info', async () => {
  try {
    const r = await withTimeout(native('info'), 5000);
    if (r && !r.error) info = { status: 'ok', host: String(r.host ?? '').trim(), ips: S.normalizeIps(r) };
    else if (info.status !== 'ok') info = { status: 'error', host: '', ips: [] };   // se já tínhamos dados bons, mantém
  } catch (e) {
    log(`home loadInfo: ${e}`);
    if (info.status !== 'ok') info = { status: 'error', host: '', ips: [] };
  }
});
async function loadInfo(my) {
  await fetchInfo();
  if (live(my)) { renderHero(); renderConnect(); }
}

async function loadAppsNow(my) {
  try {
    // Sem prazo, uma ponte lenta (até 30 s) deixaria o cartão em "Verificando…". Se não respondeu a tempo, fica o que já se sabia.
    const ok = await withTimeout(loadApps(), LOAD_TIMEOUT);
    if (ok !== null && !restarting) setOnline(ok);
  } catch (e) { log(`home loadApps: ${e}`); }
  loaded = true;
  if (live(my)) { renderHero(); renderSummary(); }
}

const fetchClients = () => once('clients', async () => {
  try {
    const r = await withTimeout(api('GET', '/api/clients/list'), LOAD_TIMEOUT);
    const sum = r && r.ok ? S.summarizeClients(r.json) : null;
    if (sum) clients = { status: 'ok', ...sum };
    else if (clients.status !== 'ok') clients = { status: 'error', total: 0, connected: 0 };   // erro passageiro não apaga o último número bom
  } catch (e) {
    log(`home loadClients: ${e}`);
    if (clients.status !== 'ok') clients = { status: 'error', total: 0, connected: 0 };
  }
});
async function loadClients(my) {
  await fetchClients();
  if (live(my)) { renderHero(); renderSummary(); renderConnect(); }
}

/* ================= Leitura periódica do uso do PC ================= */
async function fetchStats() {
  try {
    const r = await withTimeout(native('stats', { port: statsPort }), STATS_TIMEOUT);
    return S.parseStatsResult(r);
  } catch (e) {
    log(`home stats: ${e}`);
    return { ok: false, stats: null, error: String(e) };
  }
}

function applyStats(res) {
  if (res.ok) {
    failStreak = 0; lastStats = res.stats; lastAt = Date.now(); usageState = 'ok'; lastError = '';
  } else {
    failStreak++;
    lastError = String(res.error ?? '');
    // Uma falha isolada mantém a última leitura; duas seguidas (ou nenhuma leitura ainda) viram "indisponível".
    if (failStreak >= 2 || !lastStats) { lastStats = null; usageState = 'off'; }
  }
  renderUsage();
}

function schedule() {
  clearTimeout(statsTimer);
  // Uso desligado nas configurações (403): só vale depois de reiniciar o R3D PLAY, então não adianta insistir a cada 3 s.
  const every = usageState === 'off' ? S.statsFailure({ error: lastError, shareLibrary, online: state.online }).retryMs : STATS_EVERY;
  if (active) statsTimer = setTimeout(tick, Math.max(every, STATS_EVERY));
}

/** Uma rodada: lê o uso (e, de vez em quando, os dispositivos) e agenda a próxima. Uma só corrente de timers por vez. */
async function tick() {
  if (!active || tickBusy === session) return;
  if (document.hidden) { schedule(); return; }   // janela escondida: não gasta o PC (volta ao reaparecer)
  const my = session;
  tickBusy = my;
  try {
    tickN++;
    // Dispositivos e endereços IP mudam pouco, mas mudam (Wi-Fi que sobe depois da janela, cabo plugado, Tailscale ligado): relê de vez em quando,
    // e a cada rodada enquanto não houver endereço nenhum. Sem esperar: uma ponte lenta não pode congelar os números ao vivo.
    const slow = tickN % CLIENTS_EVERY === 0;
    if (slow) loadClients(my);
    if (slow || info.status !== 'ok' || info.ips.length === 0) loadInfo(my);
    const res = await fetchStats();
    if (live(my)) applyStats(res);
  } catch (e) {
    log(`home tick: ${e}`);
    if (live(my)) applyStats({ ok: false });
  } finally {
    if (tickBusy === my) tickBusy = 0;
    if (live(my)) schedule();
  }
}

function onVisibility() { if (!document.hidden && active) tick(); }

/* ================= Eventos do bus ================= */
function onApps() { renderHero(); renderVdisplay(); renderSummary(); }
function onOnline(ok) {
  renderHero(); renderVdisplay(); renderConnect(); renderSummary(); renderUsage();
  if (ok && active) { const my = session; loadConfig(my); loadClients(my); tick(); }
}
// A flag `restarting` é mantida o tempo todo (ligada no mount): o reinício pode começar ou terminar enquanto outra aba está aberta
// (Configurações e Sistema reiniciam o servidor), e ao voltar para o Início o cartão precisa estar certo.
function onRestartingFlag() { restarting = true; if (active) renderHero(); }
function onRestartedFlag() { restarting = false; if (active) renderHero(); }
/** Só com a aba aberta: depois do reinício, relê tudo (a porta, a opção de compartilhar e a versão podem ter mudado). */
function onRestarted() {
  const my = session;
  loadConfig(my); loadInfo(my); loadClients(my);
  tick();
}

/* ================= Montagem ================= */
function stepItem(n, ...content) {
  return h('li', null, h('b', { text: String(n) }), h('div', { class: 'hm-step-body' }, content));
}

function buildConnectCard() {
  ui.connectBadge = h('span', { class: 'badge warn', text: 'Comece por aqui', hidden: true });
  ui.chips = h('div', { class: 'chips hm-chips' });
  ui.ipHint = h('p', { class: 'hm-hint', hidden: true });
  ui.offlineNote = h('p', { class: 'hm-hint hm-offline-note', hidden: true, text: 'O R3D PLAY está desligado: ligue-o para conseguir parear um celular.' });
  ui.connect = h('section', { class: 'card hm-connect', 'aria-labelledby': 'hm-connect-title' },
    h('div', { class: 'card-head' }, h('h3', { id: 'hm-connect-title', text: 'Conectar um celular' }), ui.connectBadge),
    h('ol', { class: 'steps hm-steps' },
      // (Nomes dos botões conferidos no código do R3D LAUNCHER: Config > Parear / gerenciar PCs; "Adicionar PC por este endereço" fica na mesma tela.)
      stepItem(1, 'Abra o ', h('strong', { text: 'R3D LAUNCHER' }), ' no celular, toque em ', h('strong', { text: 'Config' }), ' e procure a parte dos computadores (', h('strong', { text: 'Parear / gerenciar PCs' }), ').'),
      stepItem(2, 'Deixe o celular na ', h('strong', { text: 'mesma rede Wi-Fi' }), ' que este PC.'),
      stepItem(3, 'Se o celular não achar o PC sozinho, digite um destes endereços em ', h('strong', { text: 'Adicionar PC por este endereço' }), ' (clique no endereço para copiar):', ui.chips, ui.ipHint),
      stepItem(4, 'O celular vai mostrar um ', h('strong', { text: 'PIN' }), '. Digite-o na aba ', h('strong', { text: 'Dispositivos' }), ' (o botão abaixo leva até lá).')),
    ui.offlineNote,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn primary', type: 'button', on: { click: () => go('devices', { focus: 'pair' }) } }, icon('link'), 'Parear agora')),
  );
  return ui.connect;
}

function buildSummaryCard() {
  ui.tiles = h('div', { class: 'hm-tiles' }, h('span', { class: 'skeleton hm-tile-skel' }), h('span', { class: 'skeleton hm-tile-skel' }), h('span', { class: 'skeleton hm-tile-skel' }));
  return h('section', { class: 'card', 'aria-labelledby': 'hm-summary-title' },
    h('div', { class: 'card-head' }, h('h3', { id: 'hm-summary-title', text: 'Resumo' })),
    ui.tiles);
}

function buildShortcutsCard() {
  return h('section', { class: 'card', 'aria-labelledby': 'hm-shortcuts-title' },
    h('div', { class: 'card-head' }, h('h3', { id: 'hm-shortcuts-title', text: 'Atalhos' })),
    h('div', { class: 'hm-shortcuts' },
      h('button', { class: 'btn', type: 'button', on: { click: (e) => scanGames(e.currentTarget) } }, icon('search'), h('span', { class: 'hm-btn-label', text: 'Procurar jogos instalados' })),
      h('button', { class: 'btn', type: 'button', on: { click: () => go('games') } }, icon('sports_esports'), 'Ver jogos'),
      h('button', { class: 'btn', type: 'button', on: { click: () => go('settings') } }, icon('settings'), 'Abrir configurações')),
  );
}

function buildUsageSection() {
  ui.usage = makeUsageCards();
  // (neste painel o selo vermelho "Ao vivo" quer dizer "há transmissão": aqui é só "os números se atualizam sozinhos")
  ui.usageBadge = h('span', { class: 'badge', text: 'Tempo real', hidden: true });
  ui.usageNoteBtn = h('button', { class: 'btn hm-note-btn', type: 'button', hidden: true, on: { click: () => go('settings', { key: 'share_library' }) } }, icon('settings'), 'Abrir configuração');
  ui.usageNote = h('div', { class: 'banner warn', role: 'status', hidden: true }, icon('info'), h('span'), ui.usageNoteBtn);
  return h('section', { class: 'hm-usage-section', 'aria-labelledby': 'hm-usage-title' },
    h('div', { class: 'card-head' },
      h('h3', { id: 'hm-usage-title', text: 'Uso do PC' }),
      ui.usageBadge,
      h('span', { class: 'hm-live-note', text: 'atualiza a cada 3 segundos' })),
    ui.usageNote,
    h('div', { class: 'hm-usage' }, Object.values(ui.usage).map((x) => x.el)));
}

export default {
  id: 'home', tab: 'Início', title: 'Início',

  mount(root) {
    ui = {};
    ui.vdisplay = h('div', { class: 'banner warn hm-vdisplay', role: 'status', hidden: true });
    // Estes dois ouvintes só mexem na flag e ficam ligados para sempre (mount roda uma vez): não acumulam.
    bus.on('restarting', onRestartingFlag);
    bus.on('restarted', onRestartedFlag);
    ui.hero = h('section', { class: 'card hero hm-hero', 'aria-live': 'polite', 'aria-label': 'Situação do R3D PLAY' });
    root.append(
      ui.hero,
      ui.vdisplay,
      h('div', { class: 'hm-row' }, buildConnectCard(), h('div', { class: 'hm-col' }, buildSummaryCard(), buildShortcutsCard())),
      buildUsageSection(),
    );
    renderHero(); renderVdisplay(); renderConnect(); renderSummary(); renderUsage();
  },

  async show() {
    this.hide();   // show() pode vir duas vezes seguidas (navegar para a aba em que já está): começa sempre limpo
    active = true;
    const my = ++session;
    offs = [bus.on('apps', onApps), bus.on('online', onOnline), bus.on('devices', () => loadClients(session)), bus.on('restarted', onRestarted)];
    document.addEventListener('visibilitychange', onVisibility);
    if (!lastStats || Date.now() - lastAt > 2 * STATS_EVERY) { usageState = 'loading'; failStreak = 0; lastStats = null; }
    for (const k of Object.keys(sigs)) delete sigs[k];   // força redesenhar com os dados guardados
    renderHero(); renderVdisplay(); renderConnect(); renderSummary(); renderUsage();
    // Não segura a troca de aba: carrega em segundo plano e começa a ler o uso assim que a porta do servidor é conhecida.
    (async () => {
      await withTimeout(Promise.all([loadConfig(my), loadInfo(my), loadAppsNow(my), loadClients(my)]), 2500);
      if (live(my)) tick();
    })().catch((e) => log(`home show: ${e}`));
  },

  hide() {
    active = false;
    session++;           // invalida respostas que ainda estão a caminho
    tickBusy = 0;
    clearTimeout(statsTimer);
    offs.forEach((off) => off());
    offs = [];
    document.removeEventListener('visibilitychange', onVisibility);
    [...copyResets].forEach((reset) => reset());
  },
};
