// Tela Dispositivos: parear celulares (PIN e QR code/OTP), listar, renomear, dar permissões e opções avançadas, desconectar e desparear.
// Contrato do servidor em ui/schema/clients.json; lógica pura (e testada) em lib/perms.js, lib/pairing.js e lib/qr.js.
//
// Regras que esta tela garante:
//  - POST /api/clients/update SUBSTITUI o dispositivo inteiro: sempre relê a lista, copia o objeto, troca só os campos mexidos
//    (lib/perms.js buildUpdateBody) e confere depois. Nada de gravar a cada tecla: cada cartão tem Salvar/Descartar.
//  - Só o aparelho que ACABOU de parear recebe o modelo de acesso (retrato dos uuids antes, uuids novos depois). Nada de promover
//    aparelhos antigos nem de rodar nada em segundo plano: tudo para quando a tela é fechada.
import { h, icon, api, native, state, bus, toast, confirmDlg, modal, busy, sleep, log } from '../core.js';
import * as P from '../lib/perms.js';
import * as K from '../lib/pairing.js';
import { encodeQr, qrPath, qrViewSize } from '../lib/qr.js';

const POLL_MS = 4000;              // atualização da lista enquanto a tela está aberta (nunca menos que 3 s)
const OTP_WATCH_MS = 3000;         // quanto em quanto tempo olha se o celular terminou de parear com o OTP
const OTP_GRACE_S = 20;            // o celular pode terminar de parear alguns segundos depois de o código vencer
const NS = 'http://www.w3.org/2000/svg';
const UNKNOWN = 'Cliente desconhecido';

let seq = 0;
const nid = (p) => `${p}-${++seq}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const nameOf = (dev) => (dev && typeof dev.name === 'string' && dev.name.trim()) || UNKNOWN;

/* ====================================================================== */
/* Servidor                                                                 */
/* ====================================================================== */
let platform = '';                 // 'windows' quando a lista informa (a chave só existe no Windows)
const isWindows = () => (platform || state.meta?.platform || 'windows') === 'windows';

/** "Não consegui <ação>. <motivo>" com o motivo em português simples. */
function failMsg(r, action) {
  let why;
  if (r.status === 0) why = 'O R3D PLAY não está respondendo.';
  else if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) why = `O acesso foi negado (HTTP ${r.status}). Feche e abra o painel para entrar de novo.`;
  else why = `O R3D PLAY respondeu com erro (HTTP ${r.status}).${typeof r.json?.error === 'string' ? ` Detalhe técnico: ${r.json.error}` : ''}`;
  return `Não consegui ${action}. ${why}`;
}

/** GET /api/clients/list -> {ok, list} | {ok:false, error, offline}. Descarta entradas sem uuid. */
async function fetchClients() {
  const r = await api('GET', '/api/clients/list');
  if (!r.ok) return { ok: false, offline: r.status === 0, error: failMsg(r, 'ler a lista de dispositivos') };
  if (!r.json || !Array.isArray(r.json.named_certs)) return { ok: false, error: 'Não consegui ler a lista de dispositivos. A resposta do R3D PLAY veio num formato inesperado.' };
  if (typeof r.json.platform === 'string') platform = r.json.platform;
  return { ok: true, list: r.json.named_certs.filter((d) => d && typeof d.uuid === 'string' && d.uuid) };
}

/**
 * Altera campos de UM dispositivo: relê a lista, pega o objeto atual, troca só `changes` e envia o objeto inteiro (sem `connected`).
 * Depois relê para conferir. Devolve {ok, list?, device?} ou {ok:false, error, gone?}.
 */
async function updateDevice(uuid, changes) {
  const cur = await fetchClients();
  if (!cur.ok) return { ok: false, error: cur.error };
  const fresh = cur.list.find((d) => d.uuid === uuid);
  if (!fresh) return { ok: false, gone: true, error: 'Este dispositivo não está mais na lista (foi despareado?).' };
  let body;
  try { body = P.buildUpdateBody(fresh, changes); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  const r = await api('POST', '/api/clients/update', body);
  if (!r.ok) return { ok: false, error: failMsg(r, 'salvar as alterações') };
  if (r.json?.status !== true) return { ok: false, gone: true, error: 'O R3D PLAY não encontrou este dispositivo; ele pode ter sido despareado. Nada foi salvo.' };
  const chk = await fetchClients();
  if (!chk.ok) return { ok: true, list: null };
  const got = chk.list.find((d) => d.uuid === uuid);
  const lost = P.lostFields(body, got);
  if (got && lost.length) return { ok: false, list: chk.list, error: `O R3D PLAY não guardou: ${lost.map((k) => P.FIELD_LABELS[k] || k).join(', ')}.` };
  return { ok: true, list: chk.list, device: got };
}

/* ====================================================================== */
/* Utilidades de interface                                                  */
/* ====================================================================== */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* tenta o método antigo */ }
  try {
    const ta = h('textarea', { 'aria-hidden': 'true', readOnly: true, style: { position: 'fixed', opacity: '0', left: '-9999px' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

const reduceMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Faixa de aviso (.banner) com ícone. kind: '' (azul) | ok | warn | bad. */
function banner(kind, ...kids) {
  const ic = { ok: 'check_circle', warn: 'warning', bad: 'error', '': 'info' }[kind] || 'info';
  return h('div', { class: `banner ${kind}`.trim() }, icon(ic), h('div', { class: 'dv-grow' }, kids));
}

/** Switch acessível: {el, input}. */
function switchControl(labelId, onChange) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-labelledby': labelId, on: { change: () => onChange(input.checked) } });
  return { input, el: h('label', { class: 'switch' }, input, h('span', { class: 'track' })) };
}

function riskBadge(risk, text) {
  const r = P.RISKS[risk] || P.RISKS.baixo;
  return h('span', { class: `badge ${r.tone}`.trim(), text: text || r.label });
}

/* ====================================================================== */
/* Cartão de pareamento (PIN e QR code)                                     */
/* ====================================================================== */
let pairCard = null;
let pinIn = null;
let pairPresetId = P.FULL_PRESET_ID;
const pairSelects = [];
const pairHelps = [];
let pinBusy = false;
let otpBusy = false;

const presetMask = (id) => (P.presetById(id) || P.presetById(P.FULL_PRESET_ID)).mask;

function setPairPreset(id) {
  pairPresetId = id;
  for (const s of pairSelects) s.value = id;
  const p = P.presetById(id);
  for (const el of pairHelps) el.textContent = p ? p.help : '';
  // Um código OTP já gerado aplica o acesso que estiver escolhido NO MOMENTO em que o celular parear: o que está na tela é o que vale.
  if (otp) {
    otp.mask = presetMask(id);
    otp.label = (P.presetById(id) || P.presetById(P.FULL_PRESET_ID)).label;
    if (otpUi?.accessEl) otpUi.accessEl.textContent = otp.label;
  }
}

/** Campo "Acesso do novo dispositivo" (os dois painéis compartilham a escolha). */
function accessField(prefix) {
  const id = nid(`${prefix}-acesso`);
  const sel = h('select', { id, on: { change: () => setPairPreset(sel.value) } }, P.PRESETS.map((p) => h('option', { value: p.id, text: p.label })));
  sel.value = pairPresetId;
  pairSelects.push(sel);
  const help = h('span', { class: 'f-help', id: `${id}-ajuda`, text: P.presetById(pairPresetId)?.help || '' });
  pairHelps.push(help);
  sel.setAttribute('aria-describedby', `${id}-ajuda`);
  return h('div', { class: 'field dv-f-access' },
    h('label', { class: 'f-label', for: id, text: 'Acesso do novo dispositivo' }),
    sel,
    help,
    h('span', { class: 'f-help', text: 'Só o celular que acabou de parear recebe este acesso. Os dispositivos que já estavam na lista não são alterados.' }));
}

function nameField(prefix, label) {
  const id = nid(`${prefix}-nome`);
  const input = h('input', { id, type: 'text', maxlength: String(K.NAME_MAX), autocomplete: 'off', spellcheck: 'false', placeholder: 'Ex.: Celular do João', 'aria-describedby': `${id}-ajuda` });
  return {
    input,
    el: h('div', { class: 'field dv-f-name' },
      h('label', { class: 'f-label', for: id, text: label }),
      input,
      h('span', { class: 'f-help', id: `${id}-ajuda`, text: 'Opcional. Se deixar em branco, usamos o nome que o celular informar.' })),
  };
}

function buildPairCard() {
  const tabs = {};
  const panels = {};
  const order = ['pin', 'otp'];
  const select = (which, focus = false) => {
    for (const k of order) {
      const on = k === which;
      tabs[k].setAttribute('aria-selected', String(on));
      tabs[k].tabIndex = on ? 0 : -1;
      panels[k].hidden = !on;
    }
    if (focus) tabs[which].focus();
  };
  const mkTab = (id, label) => {
    const b = h('button', {
      type: 'button', role: 'tab', id: `dv-tab-${id}`, 'aria-controls': `dv-panel-${id}`, 'aria-selected': 'false',
      on: {
        click: () => select(id),
        keydown: (e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
          e.preventDefault();
          const i = order.indexOf(id);
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length;
          select(order[next], true);
        },
      },
    }, label);
    tabs[id] = b;
    return b;
  };

  const pin = buildPinPanel();
  const otp = buildOtpPanel();
  panels.pin = h('div', { role: 'tabpanel', id: 'dv-panel-pin', 'aria-labelledby': 'dv-tab-pin', class: 'dv-panel' }, pin.el);
  panels.otp = h('div', { role: 'tabpanel', id: 'dv-panel-otp', 'aria-labelledby': 'dv-tab-otp', class: 'dv-panel', hidden: true }, otp.el);
  pinIn = pin.pinInput;

  const card = h('section', { class: 'card dv-pair', 'aria-labelledby': 'dv-pair-title', id: 'dv-pair' },
    h('div', { class: 'card-head' }, h('h3', { id: 'dv-pair-title', text: 'Parear um dispositivo novo' })),
    h('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'Forma de parear' },
      mkTab('pin', 'Pareamento por PIN'),
      mkTab('otp', 'Pareamento por QR code')),
    panels.pin, panels.otp,
    h('div', { class: 'banner warn dv-warn' }, icon('warning'),
      h('div', { class: 'dv-grow' }, h('strong', { text: 'Atenção! ' }), 'Só pareie um celular que você controla. Um dispositivo pareado pode ganhar controle total do seu computador.')));
  select('pin');
  card.dvSelect = select;
  return card;
}

/* ---------- Aba PIN ---------- */
function buildPinPanel() {
  const pinId = nid('dv-pin');
  const pinInput = h('input', {
    id: pinId, class: 'dv-pin-input mono', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '0000',
    'aria-describedby': `${pinId}-ajuda ${pinId}-erro`,
    on: { input: () => { pinInput.value = pinInput.value.replace(/[^0-9]/g, '').slice(0, 4); pinField.classList.remove('invalid'); pinErr.hidden = true; } },
  });
  const pinErr = h('span', { class: 'f-error', id: `${pinId}-erro`, role: 'alert', hidden: true });
  const pinField = h('div', { class: 'field dv-f-pin' },
    h('label', { class: 'f-label', for: pinId }, 'PIN do celular'),
    pinInput,
    h('span', { class: 'f-help', id: `${pinId}-ajuda`, text: 'Os 4 números que aparecem no celular.' }),
    pinErr);
  const name = nameField('dv-pin', 'Nome do dispositivo');
  const status = h('div', { class: 'dv-status', role: 'status', 'aria-live': 'polite' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, icon('link'), 'Parear');

  const setStatus = (kind, ...kids) => { status.replaceChildren(...(kind === 'busy' ? [h('div', { class: 'banner' }, h('span', { class: 'spinner' }), h('div', { class: 'dv-grow' }, kids))] : [banner(kind, ...kids)])); };

  const form = h('form', { class: 'dv-pair-form', novalidate: true, autocomplete: 'off',
    on: {
      submit: async (e) => {
        e.preventDefault();
        if (pinBusy || otpBusy) return;
        const v = K.validatePin(pinInput.value);
        if (!v.ok) { pinField.classList.add('invalid'); pinErr.textContent = v.error; pinErr.hidden = false; pinInput.focus(); return; }
        pinBusy = true;
        stopOtp('Código anterior cancelado: você iniciou um pareamento por PIN.');
        try {
          await busy(btn, async () => {
            const label = P.presetById(pairPresetId)?.label || '';
            const res = await K.pairByPin({
              pin: v.pin,
              name: K.sanitizeDeviceName(name.input.value),
              mask: presetMask(pairPresetId),
              listClients: async () => { const r = await fetchClients(); return r.ok ? r.list : null; },
              postPin: async (pin, nm) => {
                const r = await api('POST', '/api/pin', { pin, name: nm });
                if (r.status === 0) return { ok: false, offline: true };
                if (!r.ok) return { ok: false, error: failMsg(r, 'enviar o PIN') };
                return { ok: true, accepted: r.json?.status === true };
              },
              setPerm: (uuid, mask) => updateDevice(uuid, { perm: mask }),
              sleep,
              onStage: (s) => {
                if (s === 'snapshot') setStatus('busy', 'Conferindo os dispositivos já pareados…');
                else if (s === 'sending') setStatus('busy', 'Enviando o PIN…');
                else if (s === 'waiting') setStatus('busy', 'PIN aceito. Aguardando o celular terminar o pareamento…');
                else if (s === 'applying') setStatus('busy', `Aplicando o acesso “${label}” só ao celular novo…`);
              },
            });
            const shown = describePairResult(res, label);
            setStatus(shown.kind, ...shown.text);
            if (!visible) toast(shown.toast, shown.kind === 'bad' ? 'err' : shown.kind === 'ok' ? 'ok' : '');
            if (res.status === 'paired' || res.status === 'unclear' || res.status === 'ambiguous') {
              pinInput.value = '';
              name.input.value = '';
              await refresh();
              if (res.status === 'paired' && visible) toast(`“${nameOf(res.device)}” foi pareado.`, 'ok');
            } else if (res.status === 'rejected') {
              pinInput.select();
            }
          });
        } finally { pinBusy = false; }
      },
    } },
  h('ol', { class: 'dv-steps' },
    h('li', {}, 'No celular, abra o R3D LAUNCHER, toque neste PC e comece o pareamento. O celular vai mostrar 4 números (o PIN).'),
    h('li', {}, 'Digite esses 4 números aqui e toque em Parear.')),
  h('div', { class: 'dv-fields' }, pinField, name.el, accessField('dv-pin')),
  h('div', { class: 'row-actions dv-form-actions' }, btn),
  status);
  return { el: form, pinInput };
}

/** Texto do resultado do pareamento por PIN: {kind, text[], toast}. */
function describePairResult(res, presetLabel) {
  switch (res.status) {
    case 'snapshot_failed':
      return { kind: 'bad', text: ['Não consegui ler a lista de dispositivos, então o PIN não foi enviado. Confira se o R3D PLAY está ligado e tente de novo.'], toast: 'Pareamento não iniciado.' };
    case 'offline':
      return { kind: 'bad', text: ['O R3D PLAY não está respondendo. Confira se ele está ligado e tente de novo.'], toast: 'O R3D PLAY não está respondendo.' };
    case 'pin_error':
      return { kind: 'bad', text: [res.error || 'Não consegui enviar o PIN.'], toast: 'Não consegui enviar o PIN.' };
    case 'rejected':
      return { kind: 'warn', text: ['Nenhum celular está esperando um PIN agora. No celular, toque neste PC para começar o pareamento, confira os 4 números e envie de novo.'], toast: 'PIN não aceito.' };
    case 'ambiguous':
      return { kind: 'warn', text: ['Apareceram vários dispositivos novos ao mesmo tempo. Por segurança, não mudei o acesso de nenhum. Confira a lista abaixo e ajuste o acesso de cada um.'], toast: 'Vários dispositivos novos: confira a lista.' };
    case 'unclear':
      return { kind: '', text: ['O PIN foi aceito, mas o celular ainda não apareceu na lista. Ele pode estar terminando o pareamento ou já constar na lista (nesse caso continua com o acesso antigo). Confira a lista abaixo; se precisar, ajuste o acesso do dispositivo.'], toast: 'PIN aceito. Confira a lista de dispositivos.' };
    case 'paired': {
      const nm = `“${nameOf(res.device)}”`;
      if (res.skipped) return { kind: 'ok', text: [`${nm} foi pareado. Acesso: ${presetLabel || P.presetOf(res.device?.perm)?.label || P.CUSTOM_LABEL}.`], toast: `${nm} foi pareado.` };
      if (res.applied) return { kind: 'ok', text: [`${nm} foi pareado com o acesso “${presetLabel}”.`], toast: `${nm} foi pareado.` };
      return { kind: 'warn', text: [`${nm} foi pareado, mas não consegui aplicar o acesso “${presetLabel}”: ${res.error || 'erro desconhecido'}. Ele ficou com acesso limitado; ajuste na lista abaixo.`], toast: `${nm} foi pareado com acesso limitado.` };
    }
    default:
      return { kind: 'bad', text: ['Algo inesperado aconteceu no pareamento.'], toast: 'Erro no pareamento.' };
  }
}

/* ---------- Aba QR code / OTP ---------- */
let otpUi = null;          // elementos da aba OTP
let otp = null;            // código ativo: {code, passphrase, createdAt, before (uuids), mask, label, pcName, hosts, port}
let otpTick = null;
let otpWatch = null;
let otpGen = 0;            // muda a cada gerar/parar: resposta atrasada de um pedido antigo (ou de uma tela já fechada) é descartada

function buildOtpPanel() {
  const name = nameField('dv-otp', 'Nome do dispositivo');
  const status = h('div', { class: 'dv-status', role: 'status', 'aria-live': 'polite' });
  const result = h('div', { class: 'dv-otp-result', hidden: true });
  const btnLabel = h('span', { text: 'Gerar código' });
  const btn = h('button', { class: 'btn primary', type: 'button' }, icon('qr_code_2'), btnLabel);
  btn.addEventListener('click', () => generateOtp());
  otpUi = { name, status, result, btn, btnLabel };
  const el = h('div', { class: 'dv-otp' },
    banner('', 'O pareamento por OTP (código temporário de uso único) só funciona com clientes compatíveis, como o Artemis. Se o seu celular usa o R3D LAUNCHER, use o pareamento por PIN.'),
    h('p', { class: 'muted' }, 'Gere um código que vale por 3 minutos. O celular lê o QR code (ou abre o link) e conclui o pareamento sozinho, sem digitar PIN.'),
    h('div', { class: 'dv-fields' }, name.el, accessField('dv-otp')),
    h('div', { class: 'row-actions dv-form-actions' }, btn),
    status, result);
  return { el };
}

const showOtpStatus = (kind, ...kids) => { otpUi.status.replaceChildren(...(kids.length ? [banner(kind, ...kids)] : [])); };

async function generateOtp() {
  if (otpBusy || pinBusy) return;
  otpBusy = true;
  try {
    await busy(otpUi.btn, async () => {
      stopOtp();
      const my = otpGen;
      const stale = () => my !== otpGen || !visible;
      showOtpStatus('', 'Gerando o código…');
      const snap = await fetchClients();
      if (stale()) return;
      if (!snap.ok) { showOtpStatus('bad', snap.error); return; }
      const passphrase = K.generatePassphrase();
      const deviceName = K.sanitizeDeviceName(otpUi.name.input.value);
      const r = await api('POST', '/api/otp', deviceName ? { passphrase, deviceName } : { passphrase });
      if (stale()) return;   // saiu da tela enquanto o servidor respondia: o segredo não pode aparecer numa tela oculta
      const code = String(r.json?.otp ?? '');
      if (!r.ok || r.json?.status !== true || !/^[0-9]{4}$/.test(code)) {
        showOtpStatus('bad', r.ok ? 'O R3D PLAY não devolveu um código válido. Tente de novo.' : failMsg(r, 'gerar o código'));
        return;
      }
      let info = null;
      try { info = await native('info'); } catch { /* sem a lista de endereços: usa só a sugestão do servidor */ }
      if (stale()) return;
      const hosts = K.hostCandidates(info?.ips, r.json.ip);
      otp = {
        code, passphrase, createdAt: Date.now(), before: K.uuidsOf(snap.list), mask: presetMask(pairPresetId),
        label: P.presetById(pairPresetId)?.label || '', pcName: String(r.json.name || info?.host || ''), hosts, port: K.pairPortFromUrl(info?.url),
      };
      showOtpStatus('');
      renderOtp();
      startOtpTimers();
    });
  } finally { otpBusy = false; }
}

/** Desenha o código, o QR e o link. Os controles de endereço refazem o link na hora (sem falar com o servidor). */
function renderOtp() {
  const res = otpUi.result;
  res.replaceChildren();
  if (!otp) { res.hidden = true; return; }
  res.hidden = false;
  otpUi.btnLabel.textContent = 'Gerar novo código';
  const hostId = nid('dv-host');
  const portId = nid('dv-port');
  const linkId = nid('dv-link');
  const pick = otp.hosts.find((x) => x.recommended) || otp.hosts[0];
  const countdown = h('span', { class: 'dv-countdown', 'aria-live': 'off' });
  const accessEl = h('strong', { text: otp.label });   // acompanha o seletor “Acesso do novo dispositivo” (setPairPreset)
  const linkIn = h('input', { id: linkId, class: 'mono dv-link', type: 'text', readOnly: true, 'aria-label': 'Link de pareamento', on: { focus: () => linkIn.select() } });
  const linkErr = h('span', { class: 'f-error', role: 'alert', hidden: true });
  // O mesmo espaço serve para erro (vermelho, anunciado) e para dica neutra (quando o usuário escolheu digitar o endereço).
  const linkNote = (kind, text) => {
    linkErr.className = kind === 'error' ? 'f-error' : 'f-help';
    if (kind === 'error') linkErr.setAttribute('role', 'alert'); else linkErr.removeAttribute('role');
    linkErr.textContent = text;
    linkErr.hidden = false;
  };
  const qrBox = h('div', { class: 'dv-qr', role: 'img', 'aria-label': 'QR code de pareamento' });
  const hostSel = h('select', { id: hostId, 'aria-label': 'Endereço do PC' },
    otp.hosts.map((x) => h('option', { value: x.ip, text: `${x.ip} (${x.label})` })),
    h('option', { value: '', text: 'Outro endereço…' }));
  const hostIn = h('input', { class: 'mono', type: 'text', placeholder: 'Ex.: 192.168.0.10', 'aria-label': 'Endereço do PC digitado à mão', hidden: true, autocomplete: 'off', spellcheck: 'false' });
  const portIn = h('input', { id: portId, class: 'mono', type: 'text', inputmode: 'numeric', value: String(otp.port), 'aria-label': 'Porta', autocomplete: 'off' });
  if (pick) hostSel.value = pick.ip; else { hostSel.value = ''; hostIn.hidden = false; }

  const update = () => {
    hostIn.hidden = hostSel.value !== '';
    const host = hostSel.value || hostIn.value;
    const built = K.buildPairLink({ host, port: portIn.value, otp: otp.code, passphrase: otp.passphrase, name: otp.pcName });
    if (!built.ok) {
      linkIn.value = '';
      if (String(host).trim()) linkNote('error', built.error);
      else if (otp.hosts.length) linkNote('hint', 'Digite o endereço do PC no campo logo abaixo, por exemplo 192.168.0.10.');   // escolheu “Outro endereço…”: ainda não é erro
      else linkNote('error', 'Não consegui descobrir o endereço deste PC. Digite-o em “Mude o endereço ou a porta”, logo abaixo (ex.: 192.168.0.10).');
      qrBox.replaceChildren();
      copyBtn.disabled = true;
      return;
    }
    linkErr.hidden = true;
    copyBtn.disabled = false;
    linkIn.value = built.link;
    qrBox.replaceChildren(qrSvg(built.link));
  };
  const copyBtn = h('button', { class: 'btn', type: 'button', on: { click: async () => { const ok = await copyText(linkIn.value); if (!ok) linkIn.select(); toast(ok ? 'Link copiado.' : 'Não consegui copiar. O link ficou selecionado: use Ctrl+C.', ok ? 'ok' : 'err'); } } }, icon('content_copy'), 'Copiar link');
  hostSel.addEventListener('change', () => { update(); if (hostSel.value === '') hostIn.focus(); });
  hostIn.addEventListener('input', update);
  portIn.addEventListener('input', update);
  const hostOpts = h('details', { class: 'dv-host-opts', open: !pick },
    h('summary', { text: 'O celular não acha o PC? Mude o endereço ou a porta' }),
    h('div', { class: 'dv-host-grid' },
      h('div', { class: 'field' }, h('label', { class: 'f-label', for: hostId, text: 'Endereço do PC' }), hostSel, hostIn,
        h('span', { class: 'f-help', text: 'O celular precisa estar na mesma rede (Wi-Fi) que este PC, ou na mesma rede Tailscale/VPN.' })),
      h('div', { class: 'field dv-f-port' }, h('label', { class: 'f-label', for: portId, text: 'Porta' }), portIn)));

  res.append(
    h('div', { class: 'dv-otp-grid' },
      h('div', { class: 'dv-otp-main' },
        h('div', { class: 'dv-otp-label', text: 'Código (OTP)' }),
        h('div', { class: 'dv-otp-code mono', role: 'img', 'aria-label': `Código ${otp.code.split('').join(' ')}`, text: otp.code }),
        h('div', { class: 'dv-otp-time' }, icon('schedule'), 'Vale por mais ', countdown),
        h('div', { class: 'field' },
          h('label', { class: 'f-label', for: linkId, text: 'Link de pareamento' }),
          h('div', { class: 'input-row' }, linkIn, copyBtn),
          linkErr),
        hostOpts),
      h('div', { class: 'dv-qr-wrap' }, qrBox, h('span', { class: 'f-help', text: 'Aponte a câmera do aplicativo compatível para o QR code.' }))),
    banner('warn', 'O QR code e o link contêm o código e a senha em texto: mostre só a quem vai parear. Eles somem quando o tempo acaba ou quando você sai desta tela. O acesso do novo dispositivo será “', accessEl, '”.'));
  otpUi.countdown = countdown;
  otpUi.accessEl = accessEl;
  update();
  paintOtpTime();
}

/** Desenha o QR em SVG (fundo branco e margem de 4 módulos: scanners exigem contraste e margem). */
function qrSvg(text) {
  let qr;
  try { qr = encodeQr(text, { ecc: 'M' }); } catch { return h('span', { class: 'f-error', text: 'O link ficou grande demais para um QR code. Use o link.' }); }
  const view = qrViewSize(qr, 4);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${view} ${view}`);
  svg.setAttribute('class', 'dv-qr-svg');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(view)); bg.setAttribute('height', String(view)); bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', qrPath(qr, 4));
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

function paintOtpTime() {
  if (!otp || !otpUi.countdown) return;
  const left = K.otpSecondsLeft(otp.createdAt, Date.now());
  if (left <= 0) { expireOtp(); return; }
  otpUi.countdown.textContent = K.formatCountdown(left);
}

function startOtpTimers() {
  clearInterval(otpTick);
  clearTimeout(otpWatch);
  otpTick = setInterval(paintOtpTime, 1000);   // só o relógio da tela (não consulta o servidor); para quando o código vence ou a tela fecha
  otpWatch = setTimeout(watchOtp, OTP_WATCH_MS);
}

/** Tempo esgotado: apaga o QR e o link da tela (são segredos) e pede um código novo. A vigia segue só mais alguns segundos. */
function expireOtp() {
  clearInterval(otpTick);
  otpTick = null;
  otpUi.result.replaceChildren(banner('warn', h('strong', { text: 'EXPIRADO. ' }), 'O código venceu. Gere um novo.'));
  otpUi.result.hidden = false;
  otpUi.countdown = null;
}

/** Para tudo do OTP e apaga o segredo da tela. `msg` opcional vira aviso na aba. */
function stopOtp(msg) {
  otpGen++;
  clearInterval(otpTick);
  clearTimeout(otpWatch);
  otpTick = otpWatch = null;
  const had = !!otp;
  otp = null;
  if (otpUi) {
    otpUi.btnLabel.textContent = 'Gerar código';
    otpUi.result.replaceChildren();
    otpUi.result.hidden = true;
    otpUi.countdown = null;
    otpUi.accessEl = null;
    if (msg && had) showOtpStatus('', msg); else if (!msg) showOtpStatus('');
  }
}

/** Enquanto o código vale (e a tela está aberta), procura o celular novo e aplica o acesso SÓ a ele. */
async function watchOtp() {
  const mine = otp;
  if (!mine) return;
  if (!visible) { stopOtp(); return; }   // rede de segurança: segredo na tela oculta e sem vigia não pode existir
  const cur = await fetchClients();
  if (otp !== mine) return;
  if (!visible) { stopOtp(); return; }
  if (cur.ok) {
    const res = await K.promoteNewDevice({ before: mine.before, list: cur.list, mask: mine.mask, setPerm: (uuid, mask) => updateDevice(uuid, { perm: mask }) });
    if (otp !== mine) return;
    if (res.status === 'paired' || res.status === 'ambiguous') {
      const shown = res.status === 'ambiguous'
        ? { kind: 'warn', text: ['Apareceram vários dispositivos novos ao mesmo tempo. Por segurança, não mudei o acesso de nenhum. Confira a lista abaixo.'] }
        : describePairResult(res, mine.label);
      stopOtp();
      showOtpStatus(shown.kind, ...shown.text);
      await refresh();
      return;
    }
  }
  if (Date.now() > mine.createdAt + (K.OTP_TTL_SECONDS + OTP_GRACE_S) * 1000) {
    // Acabou a vigia: o código venceu e ninguém pareou. Deixa só o aviso "EXPIRADO" na tela (o segredo já saiu dela).
    if (otpUi.countdown) expireOtp();
    clearInterval(otpTick);
    otpTick = otpWatch = null;
    otp = null;
    return;
  }
  otpWatch = setTimeout(watchOtp, OTP_WATCH_MS);
}

/* ====================================================================== */
/* Cartão de um dispositivo                                                 */
/* ====================================================================== */
const cards = new Map();           // uuid -> controlador do cartão
let lastList = [];

function createCard(dev) {
  const uid = nid('dv');
  const c = { uuid: dev.uuid, base: dev, draft: P.draftFrom(dev), touched: new Set(), saving: false };
  const keys = () => P.changedKeys(c.base, c.draft, c.touched);
  c.isDirty = () => keys().length > 0;
  const edit = (key, value) => { c.draft[key] = value; c.touched.add(key); c.paint(); };

  /* ----- cabeçalho ----- */
  const nameIn = h('input', {
    id: `${uid}-nome`, class: 'dv-name', type: 'text', maxlength: String(K.NAME_MAX), autocomplete: 'off', spellcheck: 'false', placeholder: `${UNKNOWN}: clique aqui para dar um nome`,
    'aria-label': 'Nome do dispositivo (editável)',
    on: {
      input: () => edit('name', nameIn.value),
      keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); c.save(); } else if (e.key === 'Escape' && c.touched.has('name')) { c.touched.delete('name'); c.draft.name = P.draftFrom(c.base).name; nameIn.value = c.draft.name; c.paint(); } },
    },
  });
  const nameHint = h('span', { class: 'f-help dv-name-hint' });
  const badgeConn = h('span', { class: 'badge live', hidden: true }, icon('cast_connected'), 'Conectado');
  const badgePreset = h('span', { class: 'badge' });
  const badgeLimited = h('span', { class: 'badge warn', hidden: true, title: 'Este dispositivo não tem controle total.' }, icon('lock'), 'Acesso limitado');
  const badgeUnsaved = h('span', { class: 'badge warn', hidden: true }, icon('edit'), 'Não salvo');

  /* ----- acesso: modelo + permissões ----- */
  const customOpt = h('option', { value: 'custom', text: P.CUSTOM_LABEL, disabled: true, hidden: true });
  const presetSel = h('select', { id: `${uid}-modelo`, 'aria-describedby': `${uid}-modelo-ajuda`,
    on: { change: () => { const p = P.presetById(presetSel.value); if (p) edit('perm', p.mask); } } },
  P.PRESETS.map((p) => h('option', { value: p.id, text: p.label })), customOpt);
  const presetHelp = h('span', { class: 'f-help', id: `${uid}-modelo-ajuda` });
  const riskTag = h('span', { class: 'badge' });
  const fullBtn = h('button', { class: 'btn', type: 'button', hidden: true, on: { click: () => giveFullAccess(c, fullBtn) } }, icon('lock_open'), 'Dar acesso total');

  const permRows = new Map();
  const groups = P.GROUPS.map((g) => {
    const rows = P.SHOWN_PERMISSIONS.filter((p) => p.group === g.id).map((p) => {
      const pid = `${uid}-p-${p.name}`;
      const input = h('input', { type: 'checkbox', id: pid, 'aria-describedby': `${pid}-ajuda ${pid}-nota`, on: { change: () => edit('perm', P.togglePerm(c.draft.perm, p.name, input.checked)) } });
      const note = h('span', { class: 'dv-perm-note', id: `${pid}-nota`, hidden: true });
      permRows.set(p.name, { input, note });
      return h('div', { class: 'dv-perm' }, input,
        h('div', { class: 'dv-perm-text' },
          h('label', { for: pid }, p.label, p.danger === 'baixo' ? null : riskBadge(p.danger, `Risco ${p.danger === 'alto' ? 'alto' : 'médio'}`)),
          h('span', { class: 'f-help', id: `${pid}-ajuda`, text: p.help }),
          note));
    });
    return h('div', { class: 'dv-perm-group' }, h('h4', { text: g.label }), h('p', { class: 'f-help', text: g.help }), rows);
  });
  const permSummary = h('span', { class: 'dv-fold-count' });
  const permFold = h('details', { class: 'fold dv-fold' },
    h('summary', {}, icon('shield'), 'Permissões detalhadas', permSummary),
    h('div', { class: 'fold-body' },
      h('p', { class: 'f-help', text: 'Marque o que este dispositivo pode fazer no PC. Ao marcar “Iniciar aplicativos”, as permissões “Ver transmissões” e “Lista de aplicativos” também são marcadas, porque ela precisa delas. O mesmo vale para “Ver transmissões”, que precisa de “Lista de aplicativos”.' }),
      h('div', { class: 'dv-perm-groups' }, groups)));

  /* ----- avançado ----- */
  const legacy = switchField(uid, 'Ativar ordenação legada',
    'Ativa a ordenação de aplicativos para clientes legados. Desative se este cliente não conseguir tratar UTF8 corretamente. É preciso ativar “Ordenação de aplicativos para clientes legados” nas configurações avançadas.',
    'Padrão: marcado', (v) => edit('enable_legacy_ordering', v));
  const vdisplay = switchField(uid, 'Sempre criar monitor virtual',
    'Sempre cria um monitor virtual ao conectar a partir deste dispositivo. Só funciona se o driver do monitor virtual estiver instalado. Vale na próxima conexão.',
    'Padrão: desmarcado', (v) => edit('always_use_virtual_display', v));
  const modeId = `${uid}-modo`;
  const modeIn = h('input', { id: modeId, class: 'mono', type: 'text', placeholder: '1920x1080x59.94', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${modeId}-ajuda ${modeId}-erro`, on: { input: () => edit('display_mode', modeIn.value) } });
  const modeErr = h('span', { class: 'f-error', id: `${modeId}-erro`, role: 'alert', hidden: true });
  const modeField = h('div', { class: 'field' },
    h('label', { class: 'f-label', for: modeId, text: 'Substituição do modo de monitor' }),
    modeIn,
    h('span', { class: 'f-help', id: `${modeId}-ajuda`, text: 'O R3D PLAY vai ignorar o modo de monitor pedido pelo celular e usar este valor. Deixe em branco para correspondência automática. Formato: LARGURAxALTURAxFPS (ex.: 2400x1080x60). Use só em celulares com tela fixa, porque o celular não é avisado dessa troca. Vale na próxima conexão.' }),
    modeErr);
  const cmdSwitch = switchField(uid, 'Permitir comandos do cliente',
    'Permite que comandos do cliente sejam executados ao conectar-se a este dispositivo.',
    'Padrão: marcado', (v) => edit('allow_client_commands', v));
  const cmdOffNote = h('div', { class: 'banner warn', hidden: true }, icon('warning'), h('div', { class: 'dv-grow' },
    'Com esta opção desmarcada, os comandos abaixo continuam guardados e podem rodar ao abrir um aplicativo novo. Para desativar de verdade, esvazie também as listas.'));
  const doEd = cmdEditor(c, uid, 'do', 'Comandos de conexão do cliente', 'Comandos a serem executados quando o cliente conecta. Todos os comandos são executados como desvinculados.', edit);
  const undoEd = cmdEditor(c, uid, 'undo', 'Comandos de desconexão do cliente', 'Comandos a serem executados quando o cliente desconecta. Todos os comandos são executados como desvinculados.', edit);
  const cmdBox = h('div', { class: 'dv-cmd-box' }, doEd.el, undoEd.el);
  const idRow = h('p', { class: 'dv-uuid f-help' }, 'Identificador: ', h('code', { text: dev.uuid.slice(0, 8) }), ' ', h('span', { class: 'f-hint', text: '(usado para editar, desconectar e desparear)' }));
  const advCount = h('span', { class: 'dv-fold-count' });
  const advFold = h('details', { class: 'fold dv-fold' },
    h('summary', {}, icon('tune'), 'Opções avançadas', advCount),
    h('div', { class: 'fold-body' }, legacy.el, vdisplay.el, modeField, cmdSwitch.el, cmdOffNote, cmdBox, idRow));

  /* ----- barra de alterações e ações ----- */
  const saveInfo = h('span', { class: 'dv-save-info' });
  const saveBtn = h('button', { class: 'btn primary', type: 'button', on: { click: () => busy(saveBtn, () => c.save()) } }, icon('check'), 'Salvar');
  const discardBtn = h('button', { class: 'btn ghost', type: 'button', on: { click: () => c.discard() } }, icon('undo'), 'Descartar');
  const saveBar = h('div', { class: 'dv-savebar', hidden: true, role: 'group', 'aria-label': 'Alterações deste dispositivo' }, icon('edit'), saveInfo, h('div', { class: 'dv-grow' }), discardBtn, saveBtn);
  const discBtn = h('button', { class: 'btn', type: 'button', hidden: true, on: { click: () => disconnectDevice(c, discBtn) } }, icon('power_settings_new'), 'Desconectar');
  const unpairBtn = h('button', { class: 'btn danger', type: 'button', on: { click: () => unpairDevice(c, unpairBtn) } }, icon('link_off'), 'Desparear');

  c.el = h('article', { class: 'card dv-card', 'aria-label': 'Dispositivo' },
    h('div', { class: 'dv-head' },
      h('span', { class: 'dv-phone', 'aria-hidden': 'true' }, icon('smartphone')),
      h('div', { class: 'dv-title' }, nameIn, nameHint),
      h('div', { class: 'dv-badges' }, badgeConn, badgePreset, badgeLimited, badgeUnsaved)),
    h('div', { class: 'dv-access' },
      h('div', { class: 'field dv-f-model' }, h('label', { class: 'f-label', for: presetSel.id, text: 'Modelo de acesso' }),
        h('div', { class: 'input-row' }, presetSel, riskTag), presetHelp),
      fullBtn),
    permFold, advFold, saveBar,
    h('div', { class: 'row-actions dv-actions' }, discBtn, unpairBtn));

  /* ----- repintura: reflete o rascunho (c.draft) e o salvo (c.base) ----- */
  c.paint = (force = false) => {
    const d = c.draft;
    const b = c.base;
    const changed = keys();
    const dirty = changed.length > 0;
    const full = P.isFullAccess(b.perm);
    c.el.classList.toggle('dirty', dirty);
    c.el.setAttribute('aria-label', `Dispositivo ${nameOf(b)}`);
    if ((force || document.activeElement !== nameIn) && nameIn.value !== d.name) nameIn.value = d.name;
    const dup = c.touched.has('name') ? K.findDuplicateName(lastList, K.sanitizeDeviceName(d.name), c.uuid) : null;
    nameHint.textContent = dup ? 'Já existe outro dispositivo com esse nome. O R3D PLAY vai acrescentar “(2)” ao nome.' : 'Clique no nome para renomear. Enter salva; Esc cancela.';
    nameHint.classList.toggle('warn', !!dup);

    badgeConn.hidden = !b.connected;
    const savedPreset = P.presetOf(b.perm);
    badgePreset.textContent = savedPreset ? savedPreset.label : P.CUSTOM_LABEL;
    badgePreset.className = `badge ${(P.RISKS[P.riskOf(b.perm)] || {}).tone || ''}`.trim();
    badgePreset.title = `Modelo de acesso salvo (${(P.RISKS[P.riskOf(b.perm)] || {}).label || ''})`;
    badgeLimited.hidden = full;
    fullBtn.hidden = full;
    badgeUnsaved.hidden = !dirty;

    const preset = P.presetOf(d.perm);
    presetSel.value = preset ? preset.id : 'custom';
    customOpt.hidden = !!preset;
    presetHelp.textContent = preset ? preset.help : 'Permissões escolhidas à mão. Escolha um modelo para marcar várias de uma vez.';
    const risk = P.RISKS[P.riskOf(d.perm)] || P.RISKS.baixo;
    riskTag.textContent = risk.label;
    riskTag.className = `badge ${risk.tone}`.trim();

    for (const p of P.SHOWN_PERMISSIONS) {
      const row = permRows.get(p.name);
      const lock = P.lockedBy(d.perm, p.name);
      row.input.checked = P.hasPerm(d.perm, p.name);
      row.input.disabled = !!lock || c.saving;
      row.note.hidden = !lock;
      row.note.textContent = lock ? `Obrigatória porque “${P.permByName(lock).label}” está marcada.` : '';
    }
    permSummary.textContent = `${P.countShown(d.perm)} de ${P.SHOWN_PERMISSIONS.length} liberadas`;

    legacy.input.checked = d.enable_legacy_ordering;
    vdisplay.el.hidden = !isWindows();
    vdisplay.input.checked = d.always_use_virtual_display;
    if ((force || document.activeElement !== modeIn) && modeIn.value !== d.display_mode) modeIn.value = d.display_mode;
    // Modo inválido que o usuário digitou: erro (e o Salvar recusa). Modo inválido que JÁ estava salvo (painel antigo): só avisa;
    // ele não impede salvar o resto, mas o usuário precisa saber que está lá.
    const modeBad = P.validateDisplayMode(d.display_mode);
    const modeProblem = modeBad && c.touched.has('display_mode')
      ? modeBad
      : modeBad ? 'Este dispositivo tem um modo de monitor salvo que não é válido (por exemplo, sem o FPS). Corrija para LARGURAxALTURAxFPS ou apague o valor e salve.' : null;
    modeErr.hidden = !modeProblem;
    modeErr.textContent = modeProblem || '';
    modeField.classList.toggle('invalid', !!modeProblem);
    advCount.textContent = modeBad ? 'Modo de monitor inválido' : '';
    advCount.classList.toggle('warn', !!modeBad);
    cmdSwitch.input.checked = d.allow_client_commands;
    cmdBox.hidden = !d.allow_client_commands;
    cmdOffNote.hidden = d.allow_client_commands || (P.cleanCommands(d.do).length + P.cleanCommands(d.undo).length) === 0;
    doEd.sync();
    undoEd.sync();

    saveBar.hidden = !dirty;
    saveInfo.textContent = dirty ? `Alterações não salvas: ${changed.map((k) => P.FIELD_LABELS[k] || k).join(', ')}.` : '';
    discBtn.hidden = !b.connected;
    // Durante o salvamento trava os outros controles (o botão Salvar já é controlado por busy()); só mexe quando o estado muda,
    // para não reabilitar um botão que busy() está segurando.
    if (c.saving !== !!c.locked) { c.locked = c.saving; for (const el of [discardBtn, unpairBtn, discBtn, fullBtn, presetSel]) el.disabled = c.saving; }
  };

  c.setBase = (dev2) => {
    P.pruneTouched(c.base, c.draft, c.touched);   // marcou e desmarcou: não é edição (senão a mudança feita em outro lugar seria desfeita)
    c.base = dev2;
    c.draft = P.rebaseDraft(c.draft, c.touched, dev2);
    c.paint();
  };

  c.discard = () => {
    c.touched.clear();
    c.draft = P.draftFrom(c.base);
    nameIn.value = c.draft.name;
    modeIn.value = c.draft.display_mode;
    c.paint();
  };

  c.save = async () => {
    if (c.saving) return;
    const changed = keys();
    if (!changed.length) return;
    const changes = {};
    for (const k of changed) changes[k] = c.draft[k];
    const sentDraft = JSON.stringify(changed.map((k) => c.draft[k]));   // retrato do que está sendo enviado (para saber se o usuário mexeu durante o envio)
    const label = nameOf(c.base);
    if ('name' in changes) {
      changes.name = K.sanitizeDeviceName(changes.name);
      if (!changes.name) { toast('Dê um nome ao dispositivo antes de salvar.', 'err'); nameIn.focus(); return; }
    }
    if ('display_mode' in changes) {
      changes.display_mode = String(changes.display_mode).trim();
      const bad = P.validateDisplayMode(changes.display_mode);
      if (bad) { advFold.open = true; modeIn.focus(); toast(bad, 'err'); return; }
    }
    for (const k of ['do', 'undo']) if (k in changes) changes[k] = P.cleanCommands(changes[k]);
    if (['do', 'undo'].some((k) => k in changes && P.addsElevated(c.base[k], changes[k]))) {
      const ok = await confirmDlg('Você marcou comandos para rodar como administrador. Eles serão executados no seu PC, sem pedir confirmação, toda vez que este celular conectar ou desconectar. Salvar mesmo assim?', 'Salvar', { title: 'Comandos como administrador' });
      if (!ok) return;
    }
    if ('perm' in changes && c.base.connected && P.revokesStreaming(changes.perm) && !P.revokesStreaming(c.base.perm)) {
      const ok = await confirmDlg(`“${label}” está transmitindo agora. Sem as permissões “Ver transmissões” e “Iniciar aplicativos” ele será desconectado na hora. Continuar?`, 'Salvar e desconectar', { title: 'Isso derruba a transmissão' });
      if (!ok) return;
    }
    c.saving = true;
    c.paint();
    let res;
    try { res = await updateDevice(c.uuid, changes); } finally { c.saving = false; }
    if (!res.ok) {
      c.paint();
      toast(res.error, 'err');
      if (res.gone || res.list) refresh();
      return;
    }
    // Só libera o campo se continua igual ao que foi enviado; se o usuário digitou mais durante o envio, isso segue como "Não salvo".
    const sent = JSON.parse(sentDraft);
    changed.forEach((k, i) => { if (JSON.stringify(c.draft[k]) === JSON.stringify(sent[i])) c.touched.delete(k); });
    if (res.device) c.base = res.device;   // o que o servidor guardou já é a base: o que foi digitado durante o envio é comparado com ELA
    if (res.list) applyList(res.list, { force: true }); else { c.paint(); await refresh(); }
    c.paint(true);   // mostra o que o servidor guardou (ex.: nome com colchetes), mesmo com o campo em foco
    const later = changed.some((k) => !['name', 'perm'].includes(k)) && c.base.connected;
    toast(later ? 'Salvo. As opções avançadas valem na próxima conexão do celular.' : 'Alterações salvas.', 'ok');
  };

  c.paint();
  return c;
}

/** Interruptor com rótulo e ajuda: {el, input}. */
function switchField(uid, label, help, hint, onChange) {
  const lid = nid(`${uid}-sw`);
  const sw = switchControl(lid, onChange);
  return {
    input: sw.input,
    el: h('div', { class: 'field row dv-sw' },
      h('div', { class: 'f-text' }, h('span', { class: 'dv-sw-label', id: lid, text: label }), h('span', { class: 'f-help', text: help }), h('span', { class: 'f-hint', text: hint })),
      sw.el),
  };
}

/** Editor da lista de comandos (do/undo): linhas com o comando, "como administrador" (só Windows) e remover. */
function cmdEditor(c, uid, key, title, help, edit) {
  const body = h('div', { class: 'dv-cmd-rows' });
  const empty = h('p', { class: 'f-help', text: 'Nenhum comando.' });
  let rows = [];
  const list = () => c.draft[key];
  const render = (focusLast = false) => {
    rows = list().map((item, i) => {
      const id = nid(`${uid}-${key}`);
      const cmd = h('input', { id, class: 'mono', type: 'text', value: item.cmd, placeholder: 'Ex.: C:\\Scripts\\ao-conectar.bat', autocomplete: 'off', spellcheck: 'false', 'aria-label': `${title}: comando ${i + 1}`,
        on: { input: () => { list()[i].cmd = cmd.value; c.touched.add(key); c.paint(); } } });
      const elevId = nid(`${id}-adm`);
      const elev = h('input', { type: 'checkbox', id: elevId, checked: !!item.elevated, on: { change: () => { list()[i].elevated = elev.checked; c.touched.add(key); c.paint(); } } });
      const elevLabel = h('label', { class: 'dv-elev', for: elevId, hidden: !isWindows(), title: 'Executar como Administrador' }, elev, 'Como administrador');
      const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remover o comando ${i + 1}`, on: { click: () => { list().splice(i, 1); edit(key, list()); render(); } } }, icon('delete'));
      return { cmd, elev, elevLabel, el: h('div', { class: 'dv-cmd-row' }, cmd, elevLabel, del) };
    });
    body.replaceChildren(...(rows.length ? rows.map((r) => r.el) : [empty]));
    if (focusLast && rows.length) rows[rows.length - 1].cmd.focus();
  };
  const add = h('button', { class: 'btn ghost', type: 'button', on: { click: () => { list().push({ cmd: '', elevated: false }); c.touched.add(key); render(true); c.paint(); } } }, icon('add'), 'Adicionar comando');
  const el = h('div', { class: 'field dv-cmds' },
    h('span', { class: 'f-label', text: title }),
    h('span', { class: 'f-help', text: help }),
    h('span', { class: 'f-help', text: 'Comandos rodam no seu PC sem pedir confirmação; os marcados “como administrador” rodam com privilégios totais. Vale na próxima conexão.' }),
    body, h('div', {}, add));
  render();
  return {
    el,
    // Chamado a cada repintura: refaz as linhas só se o número mudou; senão apenas acerta os valores (sem roubar o foco).
    sync() {
      if (rows.length !== list().length) { render(); return; }
      rows.forEach((r, i) => {
        if (document.activeElement !== r.cmd && r.cmd.value !== list()[i].cmd) r.cmd.value = list()[i].cmd;
        r.elev.checked = !!list()[i].elevated;
        r.elevLabel.hidden = !isWindows();
      });
    },
  };
}

/* ---------- Ações de um cartão ---------- */
function giveFullAccess(c, btn) { return busy(btn, () => giveFullAccessFlow(c)); }

async function giveFullAccessFlow(c) {
  const label = nameOf(c.base);
  const ok = await confirmDlg(`Dar controle total a “${label}”? Ele poderá abrir e fechar jogos, usar teclado e mouse, ler e escrever na área de transferência e executar os comandos do servidor no seu PC. Faça isso só se o celular for seu ou de alguém em quem você confia.`, 'Dar controle total', { title: 'Dar acesso total?' });
  if (!ok) return;
  const res = await updateDevice(c.uuid, { perm: P.presetById(P.FULL_PRESET_ID).mask });
  if (!res.ok) { toast(res.error, 'err'); if (res.gone) refresh(); return; }
  c.touched.delete('perm');
  if (res.list) applyList(res.list, { force: true }); else { await refresh(); }
  toast(`“${label}” agora tem controle total.`, 'ok');
}

function disconnectDevice(c, btn) { return busy(btn, () => disconnectDeviceFlow(c)); }

async function disconnectDeviceFlow(c) {
  const label = nameOf(c.base);
  const ok = await confirmDlg(`Encerrar a transmissão de “${label}” agora? O jogo continua aberto no PC e o celular pode voltar a conectar depois.`, 'Desconectar', { danger: false, title: 'Desconectar este dispositivo?' });
  if (!ok) return;
  const r = await api('POST', '/api/clients/disconnect', { uuid: c.uuid });
  if (!r.ok) { toast(failMsg(r, 'desconectar o dispositivo'), 'err'); return; }
  toast(r.json?.status === true ? `“${label}” foi desconectado.` : `“${label}” já não estava conectado.`, r.json?.status === true ? 'ok' : '');
  await refresh();
  setTimeout(() => { if (visible) refresh(); }, 1200);   // a sessão leva um instante para cair
}

function unpairDevice(c, btn) { return busy(btn, () => unpairDeviceFlow(c)); }

async function unpairDeviceFlow(c) {
  const label = nameOf(c.base);
  // Lê a lista de novo: é ela que diz se este é o ÚLTIMO pareado (o servidor então fecha o jogo aberto) e se está transmitindo agora.
  const cur = await fetchClients();
  const list = cur.ok ? cur.list : lastList;
  const mine = list.find((d) => d.uuid === c.uuid) || c.base;
  const isLast = list.length === 1 && list[0].uuid === c.uuid;
  const running = state.apps.find((a) => a.uuid === state.currentApp)?.name || (state.currentApp ? 'um aplicativo' : '');
  let msg = `Desparear “${label}”? O celular perde o acesso e precisará de um novo pareamento para voltar.`;
  if (mine.connected) msg += ' Ele está transmitindo agora e será desconectado.';
  if (isLast) msg += ` Como é o único celular pareado, o jogo aberto no PC também será fechado${running ? ` (agora: “${running}”)` : ''}, e o próximo celular que você parear volta a receber controle total.`;
  const ok = await confirmDlg(msg, 'Desparear', { title: isLast && running ? 'Desparear e fechar o jogo?' : 'Desparear este dispositivo?' });
  if (!ok) return;
  const r = await api('POST', '/api/clients/unpair', { uuid: c.uuid });
  if (!r.ok) { toast(failMsg(r, 'desparear o dispositivo'), 'err'); return; }
  toast(r.json?.status === true ? `“${label}” foi despareado.` : `“${label}” já não estava na lista.`, r.json?.status === true ? 'ok' : '');
  await refresh();
}

function unpairEverything(btn) { return busy(btn, () => unpairEverythingFlow()); }

async function unpairEverythingFlow() {
  const n = lastList.length;
  const check = h('input', { type: 'checkbox', id: nid('dv-ok') });
  const connected = lastList.filter((d) => d.connected);
  const body = h('div', { class: 'dv-modal-body' },
    h('p', {}, `Isso remove ${plural(n, 'dispositivo pareado', 'dispositivos pareados')}. Cada celular vai precisar ser pareado de novo.`),
    banner('bad', h('strong', { text: 'Isso encerra a transmissão em andamento ' }), 'e fecha o jogo que estiver aberto no PC.', connected.length ? ` Agora há ${plural(connected.length, 'celular transmitindo', 'celulares transmitindo')}.` : ''),
    h('p', { class: 'f-help', text: 'Depois disso, o próximo celular pareado volta a receber controle total automaticamente.' }),
    h('label', { class: 'dv-check', for: check.id }, check, 'Entendo e quero desparear todos'));
  const yes = await modal({
    title: 'Desparear todos os dispositivos?', body, onOpen: (dlg) => dlg.classList.add('dv-dlg'),
    actions: [{ label: 'Cancelar', value: false }, { label: 'Desparear todos', value: true, kind: 'danger', icon: 'link_off', validate: () => check.checked || 'Marque a caixa para confirmar.' }],
  });
  if (!yes) return;
  const cur = await fetchClients();
  // unpair-all não derruba cada sessão de streaming: desconecta antes quem está transmitindo.
  for (const d of (cur.ok ? cur.list : lastList).filter((x) => x.connected)) await api('POST', '/api/clients/disconnect', { uuid: d.uuid });
  const r = await api('POST', '/api/clients/unpair-all', {});
  if (!r.ok) { toast(failMsg(r, 'desparear todos'), 'err'); return; }
  toast('Todos os dispositivos foram despareados.', 'ok');
  await refresh();
}

/* ====================================================================== */
/* Lista, estados e atualização periódica                                   */
/* ====================================================================== */
let root = null;
let listEl = null;
let stateBox = null;
let staleBanner = null;
let staleError = '';               // motivo da última leitura que falhou ('' = a última deu certo)
let countEl = null;
let dangerCard = null;
let visible = false;
let loaded = false;
let lastSig = null;
let refreshSeq = 0;
let pollTimer = null;
let offs = [];

const emitDevices = () => bus.emit('devices', { devices: lastList.length });
const OFFLINE_STALE = 'Sem resposta do R3D PLAY: mostrando a última lista que foi lida. Esta tela tenta de novo sozinha.';

/** Aviso único (o painel já mostra a faixa global de servidor fora do ar): lista desatualizada, com ícone. Só existe depois da 1ª leitura. */
function paintStale() {
  const text = !loaded ? '' : staleError || (state.online ? '' : OFFLINE_STALE);
  if (!text) { staleBanner.hidden = true; staleBanner.replaceChildren(); delete staleBanner.dataset.msg; return; }
  if (staleBanner.dataset.msg !== text) { staleBanner.replaceChildren(banner('warn', text)); staleBanner.dataset.msg = text; }
  staleBanner.hidden = false;
}

/** Aplica a lista do servidor: cria/atualiza/remove cartões sem refazer os que estão sendo editados. */
function applyList(list, { force = false } = {}) {
  refreshSeq++;   // qualquer leitura que ainda esteja a caminho é mais antiga que esta lista
  lastList = list;
  loaded = true;
  const sig = JSON.stringify(list);
  const changed = lastSig !== null && sig !== lastSig;
  lastSig = sig;
  const seen = new Set(list.map((d) => d.uuid));
  // Remove primeiro quem saiu: assim os que ficam já estão na ordem certa e nenhum nó é movido (mover um nó tira o foco de quem está digitando).
  for (const [uuid, c] of cards) if (!seen.has(uuid)) { c.el.remove(); cards.delete(uuid); }
  list.forEach((dev, i) => {
    let c = cards.get(dev.uuid);
    if (!c) { c = createCard(dev); cards.set(dev.uuid, c); } else c.setBase(dev);
    if (listEl.children[i] !== c.el) listEl.insertBefore(c.el, listEl.children[i] || null);
  });
  // O nome repetido de um cartão depende dos outros: repinta todos quando a lista mudou.
  if (changed || force) for (const c of cards.values()) c.paint();
  countEl.textContent = list.length ? plural(list.length, 'dispositivo pareado', 'dispositivos pareados') : '';
  dangerCard.hidden = list.length === 0;
  staleError = '';
  paintStale();
  showState(list.length === 0 ? 'empty' : '');
  if (changed || force) emitDevices();
}

let stateKind = '';
let stateMsgEl = null;
function showState(kind, msg) {
  // Não refaz o mesmo aviso a cada atualização (o botão perderia o foco); no erro só troca o texto.
  if (kind === stateKind) { if (kind === 'error' && stateMsgEl) stateMsgEl.textContent = msg; return; }
  stateKind = kind;
  stateMsgEl = null;
  stateBox.replaceChildren();
  stateBox.hidden = !kind;
  if (kind === 'loading') {
    stateBox.append(h('div', { class: 'skeleton dv-skel', 'aria-hidden': 'true' }), h('div', { class: 'skeleton dv-skel', 'aria-hidden': 'true' }), h('span', { class: 'sr-only', role: 'status', text: 'Carregando os dispositivos…' }));
  } else if (kind === 'error') {
    stateMsgEl = h('div', { class: 'dv-grow', text: msg });
    stateBox.append(h('div', { class: 'banner bad' }, icon('error'), stateMsgEl,
      h('button', { class: 'btn', type: 'button', on: { click: (e) => busy(e.currentTarget, () => refresh()) } }, icon('refresh'), 'Tentar de novo')));
  } else if (kind === 'empty') {
    stateBox.append(h('div', { class: 'card empty dv-empty' },
      icon('smartphone'),
      h('p', {}, h('strong', { text: 'Nenhum dispositivo pareado ainda.' })),
      h('p', { class: 'muted', text: 'Use o cartão “Parear um dispositivo novo” acima: no celular, abra o R3D LAUNCHER, toque neste PC e digite aqui o PIN que aparecer.' }),
      h('button', { class: 'btn primary', type: 'button', on: { click: () => focusPair() } }, icon('link'), 'Parear agora')));
  }
}

/** Lê o servidor e atualiza a tela. Respostas atrasadas (de uma leitura anterior) são descartadas. */
async function refresh() {
  const my = ++refreshSeq;
  const res = await fetchClients();
  if (my !== refreshSeq) return res;
  if (res.ok) applyList(res.list);
  else if (loaded) { staleError = res.offline ? OFFLINE_STALE : `${res.error} Mostrando a última lista que foi lida.`; paintStale(); }
  else showState('error', res.error);
  return res;
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!visible) return;
  pollTimer = setTimeout(async () => {
    try { if (visible && !document.hidden) await refresh(); } catch (e) { log(`devices: ${e}`); }   // um erro não pode parar a atualização
    schedulePoll();
  }, POLL_MS);
}

function focusPair() {
  if (!pairCard) return;
  pairCard.dvSelect('pin');
  pairCard.scrollIntoView?.({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
  pinIn?.focus({ preventScroll: true });
  pairCard.classList.remove('dv-flash');
  void pairCard.offsetWidth;   // reinicia a animação
  pairCard.classList.add('dv-flash');
}

/* ====================================================================== */
/* Tela                                                                     */
/* ====================================================================== */
export default {
  id: 'devices', tab: 'Dispositivos', title: 'Dispositivos',

  mount(el) {
    root = el;
    root.classList.add('dv-screen');
    pairCard = buildPairCard();
    listEl = h('div', { class: 'dv-list' });
    stateBox = h('div', { class: 'dv-state', hidden: true });
    staleBanner = h('div', { role: 'status', hidden: true });
    countEl = h('span', { class: 'dv-count' });
    const unpairAllBtn = h('button', { class: 'btn danger', type: 'button', on: { click: () => unpairEverything(unpairAllBtn) } }, icon('link_off'), 'Desparear todos');
    dangerCard = h('section', { class: 'card dv-danger', hidden: true, 'aria-labelledby': 'dv-danger-title' },
      h('div', { class: 'card-head' }, h('h3', { id: 'dv-danger-title', text: 'Zona de risco' })),
      h('div', { class: 'dv-danger-row' },
        h('p', { class: 'f-help', text: 'Remove todos os celulares pareados de uma vez. Isso encerra a transmissão em andamento e fecha o jogo aberto. Cada celular precisará ser pareado de novo.' }),
        unpairAllBtn));
    root.append(
      h('div', { class: 'dv-intro' },
        h('p', { class: 'muted', text: 'Gerencie os seus dispositivos pareados e suas permissões. Escolha um modelo de acesso ou marque as permissões uma a uma.' }),
        banner('', 'Quem pareia por aqui é o dono do PC: o celular novo recebe o acesso que você escolher (padrão: controle total). Celulares que já estavam pareados continuam como estão; os que têm acesso limitado mostram um aviso e o botão “Dar acesso total”.'),
        banner('warn', h('strong', { text: 'Pareou por outro caminho (fora deste painel)? ' }), 'O primeiro dispositivo pareado recebe todas as permissões, e os que forem pareados depois recebem só o mínimo (“Lista de aplicativos” e “Ver transmissões”). Depois de despareá-los todos, o próximo celular volta a receber tudo.')),
      pairCard,
      h('div', { class: 'toolbar dv-list-head' },
        h('h3', { class: 'section-title', text: 'Seus dispositivos' }),
        countEl,
        h('button', { class: 'btn ghost right', type: 'button', 'aria-label': 'Atualizar a lista agora', on: { click: (e) => busy(e.currentTarget, () => refresh()) } }, icon('refresh'), 'Atualizar')),
      staleBanner, stateBox, listEl, dangerCard);
  },

  async show(params) {
    visible = true;
    offs.forEach((off) => off());   // show() pode vir duas vezes seguidas (clicar na aba atual): não acumula ouvintes
    offs = [];
    paintStale();
    offs.push(bus.on('online', (ok) => { paintStale(); if (ok && visible) refresh(); }));
    const onVis = () => { if (!document.hidden && visible) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    offs.push(() => document.removeEventListener('visibilitychange', onVis));
    if (params?.focus === 'pair') focusPair();
    if (!loaded) showState('loading');
    await refresh();
    schedulePoll();
  },

  hide() {
    visible = false;
    clearTimeout(pollTimer);
    pollTimer = null;
    offs.forEach((off) => off());
    offs = [];
    stopOtp();                                     // o código é segredo: não fica na tela nem vigiado em segundo plano
    for (const c of cards.values()) c.discard();   // o usuário já confirmou a saída (canLeave)
  },

  /** O app nativo usa isto ao fechar a janela (ver window.__r3dDirty em main.js). */
  isDirty() { return [...cards.values()].some((c) => c.isDirty()); },

  async canLeave() {
    const dirty = [...cards.values()].filter((c) => c.isDirty());
    if (!dirty.length) return true;
    const names = dirty.map((c) => `“${nameOf(c.base)}”`).join(', ');
    return confirmDlg(`Há alterações que ainda não foram salvas em ${names}. Se sair agora, elas serão descartadas.`, 'Sair sem salvar', { danger: false, title: 'Alterações não salvas', no: 'Ficar aqui' });
  },
};
