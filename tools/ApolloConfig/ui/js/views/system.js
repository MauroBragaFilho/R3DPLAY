// Tela Sistema: informações, ações de manutenção, segurança (senha e sessão) e registro (log) do R3D PLAY.
// Contrato: ui/schema/system.json (+ _serializacao.md). Regras que esta tela segue à risca:
//  R01 POST sempre com corpo JSON (api() já manda {}); R02 quit: status 0 = sucesso e 200 vazio = falha; restart: status 0 = reiniciando;
//  R03 botão nunca fica travado (try/finally em tudo); R05/R08 depois de trocar a senha, entrar de novo com a NOVA (native login);
//  R10 o log vem inteiro a cada chamada: só atualiza sozinho com a aba visível; R12 sair da conta = native('logout') + recarregar.
// As funções "puras" do começo são exportadas para os testes (dev/tests/system.helpers.test.mjs) e não tocam no DOM.
import { h, icon, api, native, state, bus, toast, confirmDlg, busy, restartServer, go, loadApps, setOnline, sleep, log } from '../core.js';
import { readConfig } from '../lib/config.js';
import {
  FILTERS, filterById, levelInfo, parseLog, entryMessage, entryClock, filterEntries, countAtLeast, summarizeIssues, describeIssues,
  limitLines, clipText, highlightParts, entriesToText, describeMinLogLevel, describeLogLevelHint,
} from '../lib/logs.js';

/* =====================================================================================================================
   Lógica pura (sem DOM)
   ===================================================================================================================== */

export const PLATFORMS = Object.freeze({ windows: 'Windows', linux: 'Linux', macos: 'macOS' });
/** Lê uma chave PRÓPRIA do mapa (valores como "constructor" existem em todo objeto e não podem virar rótulo). */
const own = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);
export function platformLabel(p) {
  const key = String(p ?? '').trim().toLowerCase();
  return own(PLATFORMS, key) || (key ? String(p) : 'Não informado');
}

const VDISPLAY_TEXT = { 0: 'Pronto', 1: 'Desconhecido', '-1': 'Não inicializado', '-2': 'Versão incompatível', '-3': 'Falha no monitoramento (watchdog)' };
export const VDISPLAY_HELP = 'Verifique se o driver de tela virtual (SudoVDA) está instalado na versão mais recente e ativado corretamente.';
/** Estado do driver de tela virtual (vdisplayStatus). Só existe no Windows: sem valor = "Não informado". Compara como número (pode vir "0"). */
export function describeVdisplay(v) {
  if (v === undefined || v === null || String(v).trim() === '') return { text: 'Não informado', level: 'none', help: '' };
  if (typeof v !== 'number' && typeof v !== 'string') return { text: 'Estado desconhecido', level: 'warn', help: VDISPLAY_HELP };   // true/objeto: o servidor não manda isso
  const n = Number(v);
  if (n === 0) return { text: VDISPLAY_TEXT[0], level: 'ok', help: '' };
  const text = Number.isInteger(n) && VDISPLAY_TEXT[n] ? VDISPLAY_TEXT[n] : `Estado ${String(v)}`;
  return { text, level: 'warn', help: VDISPLAY_HELP };
}

/** Quem pode abrir o painel web (origin_web_ui_allowed). Ausente ou desconhecido = padrão do servidor, "lan". */
export function describeOrigin(v) {
  const key = String(v ?? '').trim().toLowerCase();
  if (key === 'pc') return { value: 'pc', label: 'Somente neste PC', risky: false };
  if (key === 'wan') return { value: 'wan', label: 'Qualquer pessoa, até pela internet', risky: true };
  return { value: 'lan', label: 'Aparelhos da sua rede (Wi-Fi ou cabo)', risky: false };
}

/** Rótulo do tipo de rede devolvido por native('info'). */
const KIND_LABELS = Object.freeze({ wifi: 'Wi-Fi', lan: 'Cabo', tailscale: 'Tailscale (fora de casa)', vpn: 'VPN' });
export function kindLabel(kind, name) {
  return own(KIND_LABELS, kind) || name || 'Rede';
}

/** Nome que aparece no celular: o que o servidor anuncia (host_name de GET /api/apps); sem ele, o nome configurado; por último o nome do PC. */
export function castNameOf({ hostName, configName, pcName } = {}) {
  for (const v of [hostName, configName, pcName]) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
}

/** Mensagem em português para um status HTTP que não é o esperado (0 = o R3D PLAY não respondeu). */
export function describeFailure(status) {
  const s = Number(status);
  if (!s) return 'O R3D PLAY não está respondendo. Confira se ele está aberto (ícone na bandeja do Windows) e tente de novo.';
  if (s === 401) return 'Sua sessão expirou. Use "Sair da conta" na aba Segurança e entre de novo.';
  if (s === 403) return 'Este endereço não tem permissão para usar o painel do R3D PLAY.';
  if (s >= 300 && s < 400) return 'O R3D PLAY ainda não tem usuário e senha. Crie o acesso na tela de entrada.';
  if (s === 400) return 'O R3D PLAY não entendeu o pedido. Tente de novo.';
  if (s >= 500) return `O R3D PLAY teve um problema interno (erro ${s}). Tente de novo; se continuar, reinicie-o.`;
  return `Resposta inesperada do R3D PLAY (erro ${s}).`;
}

/**
 * Antes de reiniciar a tela confere o servidor (GET /api/apps). Devolve o motivo (texto) para NÃO reiniciar, ou '' para seguir.
 * Só barra o que também faria o POST falhar (sem resposta, sem sessão, sem permissão, sem usuário). Erro 5xx = ele está ligado mas
 * com problema: é justamente quando reiniciar ajuda, então segue.
 */
export function describeRestartPrecheck(r) {
  if (r && r.ok) return '';
  const s = Number(r && r.status);
  if (s >= 500) return '';
  if (!s) return 'O R3D PLAY não está respondendo agora, então não há o que reiniciar. Abra-o pelo Menu Iniciar (procure por R3D PLAY) ou pela bandeja do Windows.';
  return describeFailure(s);
}

/** Resposta de um POST que devolve {"status":true} (forçar fechamento, redefinir monitor). refused = o servidor respondeu {"status":false}. */
export function interpretStatus(r) {
  if (r && r.ok && r.json && r.json.status === true) return { ok: true };
  if (r && r.ok && r.json && r.json.status === false) return { ok: false, refused: true, message: 'O R3D PLAY recusou o pedido.' };
  if (r && r.ok) return { ok: false, message: 'O R3D PLAY respondeu algo inesperado. Tente de novo.' };
  return { ok: false, message: describeFailure(r && r.status) };
}

/**
 * /api/quit (R02): a conexão cair (status 0) é o SUCESSO provável; HTTP 200 (corpo vazio) é FALHA, o servidor não saiu em 5 s.
 * outcome 'dropped' ainda precisa ser conferido (a ponte também devolve 0 se estourar o tempo de 30 s).
 */
export function interpretQuit(r) {
  const s = Number(r && r.status);
  if (!s) return { outcome: 'dropped' };
  if (s === 200) return { outcome: 'failed', message: 'O R3D PLAY não confirmou o encerramento (passou de 5 segundos). Ele pode continuar aberto: tente de novo.' };
  return { outcome: 'failed', message: describeFailure(s) };
}

/**
 * Valida o formulário de troca de senha. Usuários são aparados; senhas NÃO (espaço pode fazer parte da senha).
 * Devolve {ok, errors:{campo:texto}, warnings:{campo:texto}, currentUsername, newUsername, effectiveUser}.
 * effectiveUser = usuário que o servidor vai gravar (o novo, ou o atual digitado quando o novo fica em branco: R08).
 */
export function validatePasswordForm(input) {
  const v = input || {};
  const currentUsername = String(v.currentUsername ?? '').trim();
  const newUsername = String(v.newUsername ?? '').trim();
  const currentPassword = String(v.currentPassword ?? '');
  const newPassword = String(v.newPassword ?? '');
  const confirm = String(v.confirmNewPassword ?? '');
  const errors = {};
  const warnings = {};
  if (!currentUsername) errors.currentUsername = 'Informe o usuário atual.';
  if (!currentPassword) errors.currentPassword = 'Informe a senha atual.';
  if (!newPassword) errors.newPassword = 'Digite a nova senha.';
  if (!confirm) errors.confirmNewPassword = 'Repita a nova senha.';
  else if (newPassword && confirm !== newPassword) errors.confirmNewPassword = 'As senhas não são iguais.';
  if (!errors.newPassword && !errors.currentPassword && !errors.currentUsername && newPassword === currentPassword && (!newUsername || newUsername === currentUsername)) {
    errors.newPassword = 'Nada mudou: digite uma senha diferente da atual ou informe também um novo usuário.';
  }
  if (newPassword && newPassword.length < 8) warnings.newPassword = 'Senha curta: prefira 8 caracteres ou mais. Você pode salvar assim mesmo.';
  else if (newPassword && newPassword !== newPassword.trim()) warnings.newPassword = 'A senha começa ou termina com espaço. Confira se é isso mesmo.';
  return { ok: Object.keys(errors).length === 0, errors, warnings, currentUsername, newUsername, effectiveUser: newUsername || currentUsername };
}

/** Traduz o erro de POST /api/password (R07). `field` diz qual campo destacar. */
export function explainPasswordError(status, error) {
  const s = Number(status);
  const e = String(error ?? '').trim();
  if (!s) return { message: describeFailure(0), field: '' };
  if (/^invalid current credentials$/i.test(e)) return { message: 'Usuário ou senha atuais incorretos.', field: 'currentPassword' };
  if (/^password mismatch$/i.test(e)) return { message: 'As senhas não são iguais.', field: 'confirmNewPassword' };
  if (/^invalid username$/i.test(e)) return { message: 'Informe o nome de usuário.', field: 'currentUsername' };
  if (/^content type/i.test(e)) return { message: 'Erro interno do painel (cabeçalho da requisição). Feche e abra a janela do R3D PLAY.', field: '' };
  if (s === 400) return { message: 'O R3D PLAY não entendeu o pedido. Tente de novo.', field: '' };
  return { message: describeFailure(s), field: '' };
}

const realWait = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Depois de POST /api/password com sucesso (R05/R08): a sessão caiu e o login guardado ficou velho. Entra com as credenciais NOVAS.
 *  'new' = entrou com a senha nova (tudo certo) · 'old' = só a antiga ainda vale (o servidor disse que salvou, mas não gravou)
 *  'none' = nenhuma serviu · 'unreachable' = o R3D PLAY não respondeu ao login (a senha pode ter mudado mesmo assim).
 * `login(user, pass)` devolve {ok} (resposta do servidor) ou {error} (não conseguiu falar com ele).
 */
export async function reloginAfterPasswordChange(login, { next, previous }, wait = realWait) {
  let unreachable = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await login(next.user, next.pass);
    if (r && r.ok) return 'new';
    unreachable = !r || !!r.error;
    if (!unreachable) break;                 // o servidor respondeu e recusou: repetir não adianta
    if (attempt === 0) await wait(1200);     // sem resposta: ele pode estar gravando o arquivo; tenta mais uma vez
  }
  if (unreachable) return 'unreachable';
  const old = await login(previous.user, previous.pass);
  return old && old.ok ? 'old' : 'none';
}

/** Depois deste tempo, o resultado de uma ação deixa de valer quando a pessoa volta para a tela. */
export const RESULT_TTL_MS = 60 * 1000;
/**
 * O resultado mostrado num cartão de ação ainda vale? Devolve true quando deve sumir.
 *  - "encerrado" (quit ok/aviso) e "não voltou" (restart erro) só valem enquanto o servidor segue fora do ar: se ele voltou, somem;
 *  - "aplicativo encerrado" some quando outro aplicativo começa; "ainda aparece em execução" some quando já não há nenhum;
 *  - `aged` (a pessoa voltou à tela): o que tem mais de RESULT_TTL_MS some, exceto os dois casos que ainda são verdade com o servidor fora.
 */
export function shouldClearResult({ id, kind, ageMs = 0, online = true, hasApp = false, aged = false } = {}) {
  if (!kind || kind === 'progress') return false;
  if (id === 'quit' && (kind === 'ok' || kind === 'warn') && online) return true;
  if (id === 'restart' && kind === 'bad' && online) return true;
  if (id === 'close_app' && kind === 'ok' && hasApp) return true;
  if (id === 'close_app' && kind === 'warn' && !hasApp) return true;
  if (!aged) return false;
  const stillTrue = !online && ((id === 'quit' && kind === 'ok') || (id === 'restart' && kind === 'bad'));
  return !stillTrue && ageMs > RESULT_TTL_MS;
}

/** Texto para o usuário copiar e mandar a quem o ajuda (sem senhas, sem endereços). */
export function buildSupportText({ version, platform, vdisplay, pcName, castName, logLevel, when = new Date() }) {
  return [
    'R3D PLAY - informações do sistema',
    `Versão: ${version || 'não informada'}`,
    `Sistema operacional: ${platformLabel(platform)}`,
    `Driver de tela virtual: ${vdisplay && vdisplay.text ? vdisplay.text : 'não informado'}`,
    `Nome do PC: ${pcName || 'não informado'}`,
    `Nome mostrado no celular: ${castName || 'não informado'}`,
    `Nível do log: ${logLevel || 'não informado'}`,
    `Gerado em: ${when.toLocaleString('pt-BR')}`,
  ].join('\n');
}

/* =====================================================================================================================
   Interface
   ===================================================================================================================== */

const SECTIONS = [
  { id: 'info', label: 'Informações', icon: 'info' },
  { id: 'actions', label: 'Ações', icon: 'build' },
  { id: 'security', label: 'Segurança', icon: 'lock' },
  { id: 'logs', label: 'Registro', icon: 'description' },
];
const SECTION_ALIASES = {
  info: 'info', informacoes: 'info', informações: 'info', system: 'info', sistema: 'info', about: 'info',
  actions: 'actions', acoes: 'actions', ações: 'actions', maintenance: 'actions', manutencao: 'actions', manutenção: 'actions',
  security: 'security', seguranca: 'security', segurança: 'security', password: 'security', senha: 'security',
  logs: 'logs', log: 'logs', registro: 'logs',
};
const MAX_LINES = 1500;          // o arquivo vem inteiro; desenhar tudo travaria a janela
const AUTO_MS = 5000;            // atualização automática do registro (schema: 5 s, só com a aba visível)
const DATA_DIR_FALLBACK = '%LOCALAPPDATA%\\ApolloConfig';   // pasta de dados da janela, quando o app nativo não informa

const ACTIONS = [
  {
    id: 'close_app', icon: 'close', title: 'Forçar fechamento do aplicativo', label: 'Forçar fechamento', busyLabel: 'Fechando…',
    text: 'Use se o celular avisar que já existe um aplicativo em execução, ou se um jogo ficou preso no PC. Isso fecha o jogo e encerra a transmissão em andamento.',
  },
  {
    id: 'restart', icon: 'restart_alt', title: 'Reiniciar o R3D PLAY', label: 'Reiniciar', busyLabel: 'Reiniciando…',
    text: 'Se o R3D PLAY não estiver funcionando direito, reiniciar costuma resolver. Leva alguns segundos e derruba a transmissão em andamento.',
  },
  {
    id: 'quit', icon: 'power_settings_new', title: 'Encerrar o R3D PLAY', label: 'Encerrar o R3D PLAY', busyLabel: 'Encerrando…', danger: true,
    text: 'Desliga o R3D PLAY neste PC. Todas as transmissões terminam e os celulares só conseguem se conectar de novo depois que você abrir o R3D PLAY outra vez, pelo Menu Iniciar.',
  },
  {
    id: 'dd_reset', icon: 'monitor', title: 'Redefinir as configurações do monitor', label: 'Redefinir monitor', busyLabel: 'Redefinindo…', windowsOnly: true,
    text: 'Se o R3D PLAY ficar preso tentando restaurar as configurações do monitor, esta opção apaga essa memória e destrava. Se a tela do PC ficar com tamanho estranho, ajuste a resolução nas configurações de vídeo do Windows.',
  },
];

const S = {
  mounted: false, active: false, tab: 'info',
  net: null,           // resposta de native('info')
  cfg: null,           // valores de GET /api/config (sem metadados)
  cfgOk: false,
  hostName: '',        // host_name de GET /api/apps: o nome que o servidor realmente anuncia ao celular
  broken: false,       // o servidor responde, mas com erro 5xx (main.js o marca "fora do ar"); reiniciar ainda ajuda
  infoJob: null,
  infoAt: 0,
  lock: null,          // id da ação em andamento: bloqueia as outras (restart e quit se excluem, R03)
  restart: null,       // {t0} enquanto reinicia
  tick: 0,
  pwBusy: false,
  whoami: undefined,
  offs: [],
  autoTimer: 0,
  searchTimer: 0,
  // raw = texto da última leitura (se vier igual, não redesenha: a seleção do mouse e a rolagem ficam como estão); view = o que está na tela
  log: { entries: [], lineCount: 0, raw: '', loadedAt: 0, error: '', filter: 'all', query: '', follow: true, promise: null, auto: false, issueKey: '', view: { filtered: null, lim: null } },
};
const E = { cards: {}, v: {}, offline: [], offlineText: [], pw: {} };   // referências aos elementos

/* ---------- Pequenos utilitários ---------- */
function prefGet(key, fallback) { try { const v = localStorage.getItem(`r3d.system.${key}`); return v === null ? fallback : v; } catch { return fallback; } }
function prefSet(key, value) { try { localStorage.setItem(`r3d.system.${key}`, value); } catch { /* sem armazenamento: só não lembra */ } }

/** Copia texto. O WebView2 pode negar a área de transferência moderna, então cai no método antigo. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* tenta o método antigo */ }
  const ta = h('textarea', { 'aria-hidden': 'true', tabindex: '-1', readOnly: true, style: { position: 'fixed', left: '-9999px', top: '0', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
/** Leva a pessoa até uma opção de Configurações: essa tela lê `key` (rola, destaca e dá foco); `focus` é o nome usado pelas outras telas. */
const goSetting = (key) => go('settings', { key, focus: key });
const nameOfApp = (uuid) => (state.apps.find((a) => a.uuid === uuid) || {}).name || 'o aplicativo atual';
const fmtNum = (n) => Number(n).toLocaleString('pt-BR');
const clockNow = () => new Date().toLocaleTimeString('pt-BR');
const skeleton = () => h('span', { class: 'skeleton sy-sk', 'aria-label': 'Carregando' });

/** Aviso padrão: ícone + texto (+ botão opcional). kind: '', 'warn', 'bad', 'ok'. */
function notice(kind, iconName, text, extra) {
  return h('div', { class: `banner${kind ? ` ${kind}` : ''}` }, icon(iconName), h('div', { class: 'sy-notice-text' }, text), extra || null);
}
const OFFLINE_TEXT = 'O R3D PLAY não está respondendo. Os botões abaixo que dependem dele ficam indisponíveis até ele voltar; esta tela se atualiza sozinha. Abra o R3D PLAY pelo Menu Iniciar (procure por R3D PLAY) ou pela bandeja do Windows.';
const BROKEN_TEXT = 'O R3D PLAY está ligado, mas respondendo com erro. Reiniciá-lo costuma resolver; os outros botões ficam indisponíveis até ele voltar ao normal.';
function offlineBanner() {
  const text = h('div', { class: 'sy-notice-text', text: OFFLINE_TEXT });
  const el = h('div', { class: 'banner warn sy-offline', role: 'status', hidden: true }, icon('warning'), text);
  E.offline.push(el);
  E.offlineText.push(text);
  return el;
}

/* ---------- Estrutura ---------- */
function buildTabs() {
  const list = h('div', { class: 'subtabs sy-tabs', role: 'tablist', 'aria-label': 'Seções da tela Sistema' });
  E.tabs = {};
  for (const s of SECTIONS) {
    if (s.id === 'logs') E.logBadge = h('span', { class: 'sy-badge', hidden: true });
    const btn = h('button', {
      type: 'button', role: 'tab', id: `sy-tab-${s.id}`, 'aria-controls': `sy-panel-${s.id}`, 'aria-selected': 'false', tabindex: '-1', dataset: { tab: s.id },
      on: { click: () => selectTab(s.id), keydown: onTabKey },
    }, icon(s.icon), h('span', { text: s.label }), s.id === 'logs' ? E.logBadge : null);
    E.tabs[s.id] = btn;
    list.append(btn);
  }
  return list;
}
function onTabKey(e) {
  const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const i = SECTIONS.findIndex((s) => s.id === S.tab);
  const to = keys[e.key] === 'first' ? 0 : keys[e.key] === 'last' ? SECTIONS.length - 1 : (i + keys[e.key] + SECTIONS.length) % SECTIONS.length;
  selectTab(SECTIONS[to].id, { focus: true });
}
function panel(id, ...kids) {
  return h('section', { class: 'sy-panel', id: `sy-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `sy-tab-${id}`, hidden: true }, ...kids);
}

function selectTab(id, { focus = false } = {}) {
  if (!SECTIONS.some((s) => s.id === id)) id = 'info';
  S.tab = id;
  for (const s of SECTIONS) {
    const on = s.id === id;
    E.tabs[s.id].setAttribute('aria-selected', String(on));
    E.tabs[s.id].tabIndex = on ? 0 : -1;
    E.panels[s.id].hidden = !on;
  }
  if (focus) E.tabs[id].focus();
  if (id === 'logs') {
    renderLog();
    loadLog().then(() => { if (S.log.follow) scrollLogToEnd(); }).catch((e) => log(`sistema/registro: ${e && e.stack || e}`));
  }
  if (id === 'security') prefillUser();
  syncAutoTimer();
}

/* ---------- Informações ---------- */
function buildInfo() {
  E.infoIssue = h('div', { class: 'sy-issue', hidden: true });
  const row = (key, label, mono = true) => {
    E.v[key] = h('dd', { class: mono ? 'mono' : '' }, skeleton());
    return [h('dt', { text: label }), E.v[key]];
  };
  const card = (iconName, title, ...kids) => h('article', { class: 'card sy-card' }, h('div', { class: 'card-head' }, icon(iconName), h('h3', { text: title })), ...kids);
  E.copyInfo = h('button', { class: 'btn', type: 'button', on: { click: () => busy(E.copyInfo, onCopyInfo) } }, icon('content_copy'), 'Copiar informações');
  E.refreshInfo = h('button', { class: 'btn ghost', type: 'button', on: { click: () => busy(E.refreshInfo, onRefreshInfo) } }, icon('refresh'), 'Atualizar');
  E.infoMeta = h('span', { class: 'sy-meta sy-meta-inline', role: 'status' });
  return panel('info',
    E.infoIssue,
    h('div', { class: 'cards sy-cards' },
      card('dns', 'Este programa', h('dl', { class: 'kv sy-kv' },
        row('version', 'Versão do R3D PLAY'), row('os', 'Sistema operacional', false), row('vdisplay', 'Driver de tela virtual', false), row('stream', 'Transmissão agora', false))),
      card('computer', 'Este PC', h('dl', { class: 'kv sy-kv' },
        row('pcName', 'Nome do PC'), row('castName', 'Nome no celular'), row('ips', 'Endereços na rede', false), row('panelUrl', 'Endereço interno do painel'))),
      card('folder_open', 'Pasta de dados da janela',
        h('p', { class: 'sy-text', text: 'Aqui ficam o login salvo (criptografado, só para o seu usuário do Windows), o histórico de erros desta janela (ui.log) e as preferências da janela.' }),
        h('dl', { class: 'kv sy-kv' }, row('dataDir', 'Pasta'), row('uiLog', 'Histórico da janela'))),
      card('favorite', 'Sobre',
        h('p', { class: 'sy-text', text: 'O R3D PLAY transmite os jogos do seu PC para o celular, pela sua rede.' }),
        h('p', { class: 'sy-text sy-credit', text: 'Créditos: o R3D PLAY é baseado nos projetos de código aberto Apollo (ClassicOldSong) e Sunshine (LizardByte), usados sob a licença GPL-3.0. Essa licença garante a qualquer pessoa o direito de usar, estudar e compartilhar o código.' }))),
    h('div', { class: 'row-actions sy-footer' }, E.copyInfo, E.refreshInfo, E.infoMeta));
}

function paintInfo() {
  if (!S.mounted) return;
  const meta = state.meta || {};
  const set = (key, ...kids) => E.v[key].replaceChildren(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  const dash = '—';
  set('version', meta.version ? `v${meta.version}` : dash);
  set('os', platformLabel(meta.platform));
  const vd = describeVdisplay(meta.vdisplayStatus);
  if (vd.level === 'none') set('vdisplay', h('span', { class: 'muted-text', text: vd.text }));
  else set('vdisplay', h('span', { class: `badge ${vd.level}` }, icon(vd.level === 'ok' ? 'check_circle' : 'warning'), vd.text), vd.help ? h('p', { class: 'f-help sy-vd-help', text: vd.help }) : null);
  paintStream();
  const net = S.net;
  set('pcName', net && net.host ? net.host : dash);
  set('castName', castName() || dash);
  if (!net) set('ips', dash);
  else if (!(net.ips || []).length) set('ips', h('span', { class: 'muted-text', text: 'Sem rede detectada.' }));
  else {
    set('ips', h('div', { class: 'chips sy-chips-ip' }, (net.ips || []).map((i) => h('button', {
      class: 'chip', type: 'button', title: 'Copiar este endereço', 'aria-label': `Copiar ${i.ip} (${kindLabel(i.kind, i.name)})`,
      on: { click: async () => { const ok = await copyText(i.ip); toast(ok ? 'Endereço copiado.' : 'Não foi possível copiar.', ok ? 'ok' : 'err'); } },
    }, icon('content_copy'), i.ip, ' ', h('small', { text: kindLabel(i.kind, i.name) })))));
  }
  set('panelUrl', net && net.url ? net.url : dash);
  const dir = (net && net.dataDir) || DATA_DIR_FALLBACK;
  set('dataDir', dir);
  set('uiLog', `${dir}\\ui.log`);
}
function paintStream() {
  if (!S.mounted) return;
  const e = E.v.stream;
  if (state.currentApp) e.replaceChildren(h('span', { class: 'badge live', text: 'Ao vivo' }), ' ', nameOfApp(state.currentApp));
  else e.replaceChildren(h('span', { class: 'muted-text', text: 'Nenhuma' }));
}

/** Nome que o celular enxerga: host_name do servidor, senão o nome configurado, senão o do PC. */
const castName = () => castNameOf({ hostName: S.hostName, configName: S.cfg && S.cfg.sunshine_name, pcName: S.net && S.net.host });

/**
 * Pergunta ao servidor (GET /api/apps) o que a ponte do core descarta: o host_name e se ele está ligado mas respondendo com erro (5xx).
 * Sem isso, com erro 5xx o painel inteiro ficaria sem botão de reiniciar justamente quando reiniciar mais ajuda.
 */
async function probeServer() {
  const r = await api('GET', '/api/apps');
  S.broken = !r.ok && r.status >= 500;
  if (r.ok && r.json && typeof r.json.host_name === 'string') S.hostName = r.json.host_name;
  return r;
}

async function refreshInfo() {
  if (S.infoJob) return S.infoJob;
  S.infoJob = (async () => {
    let good = false;
    try {
      const [cfg, net, probe] = await Promise.all([
        readConfig().catch(() => ({ ok: false })),
        native('info').catch(() => null),
        probeServer().catch(() => ({ ok: false, status: 0 })),
        loadApps().catch(() => false),          // atualiza state.currentApp para os avisos de transmissão
      ]);
      if (cfg && cfg.ok) { S.cfg = cfg.values; S.cfgOk = true; }
      if (net && !net.error) S.net = net;
      good = !!(cfg && cfg.ok) && !!(probe && probe.ok);
      if (good) S.infoAt = Date.now();
      paintInfo();
      paintSecurity();
      paintLogHint();
      paintActionHints();
      syncPlatform();
      syncActionState();
      paintInfoMeta();
    } catch (e) {
      log(`sistema/info: ${e && e.stack || e}`);
    } finally { S.infoJob = null; }
    return good;
  })();
  return S.infoJob;
}

/** Clique em "Atualizar" da aba Informações: dá retorno (texto "Atualizado às…" e aviso), mesmo quando nada mudou. */
async function onRefreshInfo() {
  const ok = await refreshInfo();
  if (ok) toast('Informações atualizadas.', 'ok');
  else toast('Não consegui atualizar tudo agora. Confira se o R3D PLAY está ligado; a tela mostra o que já tinha.', 'err');
}
function paintInfoMeta() {
  if (!E.infoMeta) return;
  E.infoMeta.textContent = S.infoAt ? `Atualizado às ${new Date(S.infoAt).toLocaleTimeString('pt-BR')}.` : '';
}

async function onCopyInfo() {
  const meta = state.meta || {};
  const text = buildSupportText({
    version: meta.version, platform: meta.platform, vdisplay: describeVdisplay(meta.vdisplayStatus),
    pcName: S.net && S.net.host, castName: castName(),
    logLevel: S.cfg ? describeMinLogLevel(S.cfg.min_log_level).label : '',
  });
  const ok = await copyText(text);
  toast(ok ? 'Informações copiadas. Cole onde precisar.' : 'Não foi possível copiar.', ok ? 'ok' : 'err');
}

/* ---------- Ações ---------- */
function buildActions() {
  const cards = ACTIONS.map((a) => {
    const c = { ...a, msg: null, kind: '', timer: null };
    c.btn = h('button', { class: `btn${a.danger ? ' danger' : ''}`, type: 'button', on: { click: () => onAction(c) } }, icon(a.icon), a.label);
    c.hint = h('p', { class: 'sy-hint' });
    c.result = h('div', { class: 'sy-result', role: 'status', 'aria-live': 'polite' });
    c.root = h('article', { class: `card sy-action${a.danger ? ' sy-danger' : ''}`, dataset: { action: a.id }, hidden: a.windowsOnly && state.meta.platform !== 'windows' },
      h('div', { class: 'card-head' }, icon(a.icon), h('h3', { text: a.title })),
      h('p', { class: 'sy-text', text: a.text }), c.hint,
      h('div', { class: 'row-actions' }, c.btn), c.result);
    E.cards[a.id] = c;
    return c.root;
  });
  // sy-cards-top: cada cartão tem a altura do próprio conteúdo (o resultado de uma ação não empurra o botão do vizinho)
  return panel('actions', offlineBanner(), h('div', { class: 'cards sy-cards sy-cards-top' }, cards));
}

function syncPlatform() {
  if (!S.mounted) return;
  const win = !state.meta.platform || String(state.meta.platform).toLowerCase() === 'windows';
  for (const a of ACTIONS) if (a.windowsOnly) E.cards[a.id].root.hidden = !win;
}
function paintActionHints() {
  if (!S.mounted) return;
  E.cards.close_app.hint.textContent = state.currentApp ? `Em execução agora: ${nameOfApp(state.currentApp)}.` : 'Nenhum aplicativo em execução agora.';
  const live = state.currentApp ? `Há uma transmissão em andamento (${nameOfApp(state.currentApp)}). Ela será encerrada.` : '';
  E.cards.restart.hint.textContent = !state.online && S.broken ? 'O R3D PLAY está respondendo com erro. Reiniciar costuma resolver.' : live;
  E.cards.quit.hint.textContent = live;
}
/**
 * Mostra/some os avisos "sem servidor" e desabilita o que depende dele. Um botão desabilitado aqui nunca fica preso: bus 'online' recalcula.
 * Com o servidor ligado mas dando erro 5xx (S.broken), só "Reiniciar" continua disponível: é a saída para esse caso.
 */
function syncActionState() {
  if (!S.mounted) return;
  const broken = !state.online && S.broken;
  for (const el of E.offline) el.hidden = state.online || !!S.restart;   // durante um reinício pedido por nós, "fora do ar" é esperado
  for (const t of E.offlineText) t.textContent = broken ? BROKEN_TEXT : OFFLINE_TEXT;
  for (const a of ACTIONS) E.cards[a.id].btn.disabled = !!S.lock || !(state.online || (broken && a.id === 'restart'));
  syncPwState();
}

function setBtn(c, working) {
  c.btn.replaceChildren(working ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon(c.icon), working ? c.busyLabel : c.label);
}
/** Mostra o resultado da ação dentro do cartão. kind: 'progress' | 'ok' | 'bad' | 'warn' | null (limpa). */
function showResult(id, kind, text) {
  const c = E.cards[id];
  c.kind = kind || '';
  c.at = Date.now();       // para expirar resultados velhos quando a pessoa volta à tela (shouldClearResult)
  c.timer = null;
  if (!kind) { c.result.replaceChildren(); return; }
  if (kind === 'progress') {
    c.timer = h('span', { class: 'sy-timer', 'aria-hidden': 'true' });
    c.result.replaceChildren(h('div', { class: 'banner' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('div', { class: 'sy-notice-text', text }), c.timer));
    return;
  }
  const iconName = { ok: 'check_circle', bad: 'error', warn: 'warning' }[kind];
  c.result.replaceChildren(h('div', { class: `banner ${kind}`, role: kind === 'bad' ? 'alert' : null }, icon(iconName), h('div', { class: 'sy-notice-text', text })));
}

/** Limpa os resultados que deixaram de valer (ver shouldClearResult). `aged` = a pessoa voltou à tela: o que é velho também sai. */
function expireResults({ aged = false } = {}) {
  if (!S.mounted) return;
  const now = Date.now();
  for (const a of ACTIONS) {
    const c = E.cards[a.id];
    if (shouldClearResult({ id: a.id, kind: c.kind, ageMs: now - (c.at || now), online: state.online, hasApp: !!state.currentApp, aged })) showResult(a.id, null);
  }
}

/** Roda uma ação com trava global, confirmação opcional e SEMPRE destrava (R03). */
async function runAction(c, { confirm, run }) {
  if (S.lock) return;
  S.lock = c.id;          // a trava lógica vale já; os botões só são desabilitados depois da confirmação (se a pessoa cancelar, o foco volta ao botão)
  try {
    if (confirm && !(await confirm())) return;
    syncActionState();
    for (const a of ACTIONS) showResult(a.id, null);       // só o resultado mais recente vale: os antigos ficariam enganosos
    setBtn(c, true);
    await busy(c.btn, run);
  } catch (e) {
    log(`sistema/${c.id}: ${e && e.stack || e}`);
    showResult(c.id, 'bad', 'Algo deu errado ao executar esta ação. Tente de novo.');
    toast('Algo deu errado. Tente de novo.', 'err');
  } finally {
    S.lock = null;
    setBtn(c, false);
    syncActionState();
    // o botão ficou desabilitado durante a ação e o navegador solta o foco: devolve para quem usa só o teclado
    if (S.active && !c.btn.disabled && (!document.activeElement || document.activeElement === document.body)) c.btn.focus({ preventScroll: true });
  }
}

function onAction(c) {
  ({ close_app: actCloseApp, restart: actRestart, quit: actQuit, dd_reset: actDdReset })[c.id](c);
}

function actCloseApp(c) {
  return runAction(c, {
    confirm: state.currentApp ? () => confirmDlg(`Fechar "${nameOfApp(state.currentApp)}" agora? O jogo será encerrado à força e a transmissão em andamento termina.`, 'Forçar fechamento', { title: 'Forçar fechamento' }) : null,
    run: async () => {
      const had = !!state.currentApp;
      showResult(c.id, 'progress', 'Fechando o aplicativo… pode levar alguns segundos.');
      const out = interpretStatus(await api('POST', '/api/apps/close', {}));
      if (!out.ok) { showResult(c.id, 'bad', out.message); toast('Não foi possível fechar o aplicativo.', 'err'); return; }
      await sleep(800);             // o servidor leva um instante para soltar o app; só então a lista reflete
      if (!(await loadApps())) {    // sem reler a lista, state.currentApp é o valor antigo: não dá para afirmar nada sobre o aplicativo
        showResult(c.id, 'warn', 'O pedido foi aceito, mas não consegui conferir se o aplicativo fechou. Veja na tela Jogos.');
        return;
      }
      if (state.currentApp) showResult(c.id, 'warn', 'O pedido foi aceito, mas o aplicativo ainda aparece em execução. Espere alguns segundos e confira na tela Jogos; se continuar, tente de novo.');
      else showResult(c.id, 'ok', had ? 'Aplicativo encerrado.' : 'Pronto. Não havia nenhum aplicativo em execução.');
      if (!state.currentApp) toast(had ? 'Aplicativo encerrado.' : 'Nenhum aplicativo estava em execução.', 'ok');
    },
  });
}

function actRestart(c) {
  return runAction(c, {
    confirm: () => confirmDlg(
      state.currentApp
        ? `Há uma transmissão em andamento (${nameOfApp(state.currentApp)}). Reiniciar o R3D PLAY vai encerrá-la e desconectar os celulares por alguns segundos. Continuar?`
        : 'Reiniciar o R3D PLAY agora? Os celulares conectados são desconectados por alguns segundos e voltam sozinhos quando ele terminar de reiniciar.',
      'Reiniciar', { danger: !!state.currentApp, title: 'Reiniciar o R3D PLAY' }),
    run: async () => {
      const pre = await api('GET', '/api/apps');          // se ele já está fora do ar, não há o que reiniciar (e esperar 90 s seria em vão)
      const why = describeRestartPrecheck(pre);           // erro 5xx NÃO barra: ele está ligado com problema e reiniciar é o remédio
      if (why) { showResult(c.id, 'bad', why); return; }
      S.restart = { t0: Date.now() };
      showResult(c.id, 'progress', 'Reiniciando o R3D PLAY… isso leva alguns segundos. Não feche esta janela.');
      startTick();
      let ok = false;
      const t0 = S.restart.t0;
      try { ok = await restartServer(); } finally { stopTick(); S.restart = null; }   // mesmo se falhar, o contador não fica ligado
      if (ok) S.broken = false;                           // voltou: o "respondendo com erro" de antes não vale mais
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      if (ok) { showResult(c.id, 'ok', `R3D PLAY reiniciado em ${secs} s. Os celulares já podem se conectar de novo.`); toast('R3D PLAY reiniciado.', 'ok'); }
      else { showResult(c.id, 'bad', 'O R3D PLAY não voltou a responder. Abra o R3D PLAY pela bandeja do Windows ou pelo Menu Iniciar; se não aparecer, reinicie o computador.'); toast('O R3D PLAY não voltou a responder.', 'err'); }
    },
  });
}

function actQuit(c) {
  return runAction(c, {
    confirm: async () => {
      const first = await confirmDlg('Encerrar o R3D PLAY? Todas as transmissões terminam e os celulares só conseguem se conectar de novo depois que você abrir o R3D PLAY outra vez, pelo Menu Iniciar (procure por R3D PLAY). Se ele não abrir, reinicie o computador.', 'Encerrar o R3D PLAY', { title: 'Encerrar o R3D PLAY' });
      if (!first) return false;
      if (!state.currentApp) return true;
      return confirmDlg(`Há uma transmissão em andamento (${nameOfApp(state.currentApp)}). Ela será interrompida agora. Encerrar mesmo assim?`, 'Encerrar mesmo assim', { title: 'Transmissão em andamento' });
    },
    run: async () => {
      showResult(c.id, 'progress', 'Encerrando o R3D PLAY…');
      const out = interpretQuit(await api('POST', '/api/quit', {}));
      if (out.outcome === 'failed') { showResult(c.id, 'bad', out.message); toast('Não foi possível encerrar o R3D PLAY.', 'err'); return; }
      // A conexão caiu (isso é o sucesso), mas a ponte também devolve 0 ao estourar o tempo: confere se ele parou de responder de verdade.
      let down = false;
      for (let i = 0; i < 10 && !down; i++) {
        if ((await api('GET', '/api/apps')).status) await sleep(1000); else down = true;
      }
      if (!down) { showResult(c.id, 'warn', 'O pedido foi enviado, mas o R3D PLAY ainda responde. Espere um pouco e use "Atualizar" na aba Informações; se continuar ligado, tente de novo.'); return; }
      setOnline(false);
      showResult(c.id, 'ok', 'R3D PLAY encerrado. O ícone dele some da bandeja do Windows. Para usá-lo de novo, abra o R3D PLAY pelo Menu Iniciar (procure por R3D PLAY). Se ele não abrir, reinicie o computador. Esta janela reconecta sozinha quando ele voltar.');
      toast('R3D PLAY encerrado.', 'ok');
    },
  });
}

function actDdReset(c) {
  return runAction(c, {
    run: async () => {
      showResult(c.id, 'progress', 'Redefinindo as configurações do monitor…');
      const out = interpretStatus(await api('POST', '/api/reset-display-device-persistence', {}));
      if (out.ok) {
        showResult(c.id, 'ok', 'Pronto: o R3D PLAY esqueceu as configurações salvas do monitor. Se a tela do PC ficou com o tamanho errado, ajuste nas configurações de vídeo do Windows.');
        toast('Configurações do monitor redefinidas.', 'ok');
      } else {
        showResult(c.id, 'bad', out.refused ? 'Não foi possível redefinir as configurações do monitor. Tente de novo ou reinicie o R3D PLAY.' : out.message);
        toast('Não foi possível redefinir o monitor.', 'err');
      }
    },
  });
}

/* Contador de segundos do reinício (só enquanto a tela está aberta; o texto fixo não é relido toda hora por leitores de tela). */
function startTick() {
  stopTick();
  const c = E.cards.restart;
  const paint = () => { if (S.restart && c.timer) c.timer.textContent = `${Math.round((Date.now() - S.restart.t0) / 1000)} s`; };
  paint();
  S.tick = setInterval(paint, 1000);
}
function stopTick() { if (S.tick) { clearInterval(S.tick); S.tick = 0; } }

/* ---------- Segurança ---------- */
function pwField({ name, label, autocomplete, help, password = true }) {
  const id = `sy-pw-${name}`;
  const input = h('input', {
    id, name, type: password ? 'password' : 'text', autocomplete, spellcheck: 'false', autocapitalize: 'off', 'aria-describedby': `${id}-msg`,
    on: { input: () => onPwInput(name) },
  });
  const eye = password ? h('button', {
    class: 'icon-btn sy-eye', type: 'button', 'aria-label': 'Mostrar senha', 'aria-pressed': 'false', title: 'Mostrar ou ocultar',
    on: { click: () => setReveal(E.pw[name], input.type === 'password') },
  }, icon('visibility')) : null;
  const err = h('p', { class: 'f-error', id: `${id}-err`, role: 'alert', hidden: true });
  const warn = h('p', { class: 'f-warn', id: `${id}-warn`, hidden: true });
  const root = h('div', { class: 'field' },
    h('label', { class: 'f-label', for: id }, label),
    h('div', { class: 'input-row' }, input, eye),
    help ? h('p', { class: 'f-help', id: `${id}-msg`, text: help }) : h('span', { id: `${id}-msg`, class: 'sr-only' }), err, warn);
  E.pw[name] = { root, input, err, warn, eye };
  return root;
}
/** Mostra (texto puro) ou oculta (pontinhos) a senha de um campo e deixa o botão do olho coerente com isso. */
function setReveal(f, show) {
  if (!f.eye) return;
  f.input.type = show ? 'text' : 'password';
  f.eye.setAttribute('aria-pressed', String(show));
  f.eye.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  f.eye.firstChild.textContent = show ? 'visibility_off' : 'visibility';
}

function buildSecurity() {
  E.pwResult = h('div', { class: 'sy-result', role: 'status', 'aria-live': 'polite' });
  E.pwBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('key'), 'Salvar nova senha');
  E.pwForm = h('form', { class: 'sy-pw', novalidate: true, on: { submit: onPwSubmit } },
    h('div', { class: 'sy-pw-grid' },
      h('fieldset', { class: 'sy-fieldset' }, h('legend', { text: 'Dados atuais' }),
        pwField({ name: 'currentUsername', label: 'Usuário atual', autocomplete: 'username', password: false, help: 'É o usuário que você escolheu ao criar o acesso ao R3D PLAY (o mesmo da tela de entrada).' }),
        pwField({ name: 'currentPassword', label: 'Senha atual', autocomplete: 'current-password' })),
      h('fieldset', { class: 'sy-fieldset' }, h('legend', { text: 'Novos dados' }),
        pwField({ name: 'newUsername', label: 'Novo usuário (opcional)', autocomplete: 'off', password: false, help: 'Se deixar em branco, o usuário continua o mesmo.' }),
        pwField({ name: 'newPassword', label: 'Nova senha', autocomplete: 'new-password', help: 'Anote em um lugar seguro: é ela que abre o painel neste PC e em outros aparelhos.' }),
        pwField({ name: 'confirmNewPassword', label: 'Repita a nova senha', autocomplete: 'new-password' }))),
    h('div', { class: 'row-actions' }, E.pwBtn), E.pwResult);
  E.originNow = h('p', { class: 'sy-text' });
  E.originWarn = h('div', { class: 'sy-issue', hidden: true });
  E.logoutBtn = h('button', { class: 'btn', type: 'button', on: { click: () => doLogout() } }, icon('logout'), 'Sair da conta');
  return panel('security',
    offlineBanner(),
    h('div', { class: 'sy-stack' },
      h('article', { class: 'card sy-card' }, h('div', { class: 'card-head' }, icon('key'), h('h3', { text: 'Alterar senha' })),
        h('p', { class: 'sy-text', text: 'Troque o usuário e a senha usados para abrir o painel do R3D PLAY. Para confirmar que é você, informe também os dados atuais. Depois da troca, outros aparelhos que abrem o painel pela rede precisam entrar de novo.' }),
        E.pwForm),
      h('div', { class: 'cards sy-cards' },
        h('article', { class: 'card sy-card' }, h('div', { class: 'card-head' }, icon('shield'), h('h3', { text: 'Quem pode abrir o painel pela rede' })),
          E.originNow, E.originWarn,
          h('p', { class: 'f-help', text: 'Isso vale só para abrir ESTE painel a partir de outros aparelhos. Não impede os celulares de se conectar para jogar. Neste PC o painel sempre abre.' }),
          h('div', { class: 'row-actions' }, h('button', { class: 'btn ghost', type: 'button', on: { click: () => goSetting('origin_web_ui_allowed') } }, icon('settings'), 'Mudar em Configurações'))),
        h('article', { class: 'card sy-card' }, h('div', { class: 'card-head' }, icon('logout'), h('h3', { text: 'Sessão neste PC' })),
          h('p', { class: 'sy-text', text: 'Esquece o login salvo neste PC. O painel volta a pedir usuário e senha.' }),
          h('div', { class: 'row-actions' }, E.logoutBtn)))));
}

function paintSecurity() {
  if (!S.mounted) return;
  if (!S.cfgOk) { E.originNow.textContent = 'Não consegui ler esta configuração agora.'; E.originWarn.hidden = true; return; }
  const o = describeOrigin(S.cfg.origin_web_ui_allowed);
  E.originNow.replaceChildren('Hoje o painel pode ser aberto por: ', h('strong', { text: o.label }), S.cfg.origin_web_ui_allowed ? '.' : ' (padrão).');
  E.originWarn.hidden = !o.risky;
  E.originWarn.replaceChildren(...(o.risky ? [notice('warn', 'warning', 'Abrir o painel para a internet é um risco à segurança: qualquer pessoa poderá tentar adivinhar a senha. Só mantenha assim se souber o que está fazendo.')] : []));
}

function syncPwState() {
  if (!E.pwBtn) return;
  E.pwBtn.disabled = S.pwBusy || !state.online;
  E.pwBtn.title = state.online ? '' : 'O R3D PLAY não está respondendo.';
}
function readPw() { return Object.fromEntries(Object.keys(E.pw).map((k) => [k, E.pw[k].input.value])); }
function paintPwErrors(res) {
  for (const [name, f] of Object.entries(E.pw)) {
    const msg = res.errors[name] || '';
    f.root.classList.toggle('invalid', !!msg);
    f.err.hidden = !msg;
    f.err.textContent = msg;
    f.input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    const w = !msg && res.warnings[name] || '';
    f.warn.hidden = !w;
    f.warn.textContent = w;
  }
}
function onPwInput(name) {
  const f = E.pw[name];
  if (!f.err.hidden) { f.err.hidden = true; f.root.classList.remove('invalid'); f.input.setAttribute('aria-invalid', 'false'); }
  if (name === 'newPassword') { const res = validatePasswordForm(readPw()); const w = res.warnings.newPassword || ''; f.warn.hidden = !w; f.warn.textContent = w; }
  if (E.pwResult.firstChild) E.pwResult.replaceChildren();
}
function pwResult(kind, text) {
  if (!kind) { E.pwResult.replaceChildren(); return; }
  E.pwResult.replaceChildren(h('div', { class: `banner ${kind}`, role: kind === 'bad' ? 'alert' : null }, icon({ ok: 'check_circle', bad: 'error', warn: 'warning' }[kind]), h('div', { class: 'sy-notice-text', text })));
}

/** O app nativo ainda não informa o usuário salvo (R09). Se um dia informar (native whoami → {user}), pré-preenche; hoje devolve erro e seguimos. */
async function prefillUser() {
  if (S.whoami !== undefined) return;
  S.whoami = '';
  try {
    const r = await native('whoami');
    if (r && typeof r.user === 'string' && r.user) {
      S.whoami = r.user;
      if (!E.pw.currentUsername.input.value) E.pw.currentUsername.input.value = r.user;
    }
  } catch { /* sem o comando: o usuário digita */ }
}

async function onPwSubmit(ev) {
  ev.preventDefault();
  if (S.pwBusy || !state.online) return;
  const v = readPw();
  const res = validatePasswordForm(v);
  paintPwErrors(res);
  if (!res.ok) {
    pwResult('bad', 'Confira os campos destacados.');
    const first = Object.keys(E.pw).find((k) => res.errors[k]);
    if (first) E.pw[first].input.focus();
    return;
  }
  S.pwBusy = true;
  state.sessionBusy = true;   // o polling do main.js pula esse intervalo: entre a troca e o novo login a sessão está caída
  syncPwState();
  try {
    await busy(E.pwBtn, async () => {
      pwResult(null);
      const r = await api('POST', '/api/password', {
        currentUsername: res.currentUsername, currentPassword: v.currentPassword,
        newUsername: res.newUsername, newPassword: v.newPassword, confirmNewPassword: v.confirmNewPassword,
      });
      if (!r.ok || !r.json || r.json.status !== true) {
        const ex = explainPasswordError(r.status, r.json && r.json.error);
        toast(ex.message, 'err');
        if (ex.field && E.pw[ex.field]) {                 // erro de um campo: mostra junto dele e leva o cursor até lá
          if (ex.field === 'currentPassword') E.pw.currentPassword.input.value = '';
          paintPwErrors({ errors: { [ex.field]: ex.message }, warnings: {} });
          E.pw[ex.field].input.focus();
        } else pwResult('bad', ex.message);
        return;
      }
      // Trocou: a sessão caiu e o login guardado ficou velho. Entra já com os dados novos (R08), sem pausa para o poll não pegar o 401.
      const how = await reloginAfterPasswordChange((user, pass) => native('login', { user, pass }), {
        next: { user: res.effectiveUser, pass: v.newPassword }, previous: { user: res.currentUsername, pass: v.currentPassword },
      });
      wipePw(res.effectiveUser, how === 'old');
      if (how === 'new') {
        const alive = await loadApps();       // confirma que o painel continua funcionando com a sessão nova
        if (alive) { pwResult('ok', 'Senha alterada. O painel já entrou de novo com a nova senha. Outros aparelhos que abrem o painel pela rede precisam entrar com ela.'); toast('Senha alterada.', 'ok'); }
        else pwResult('warn', 'A senha foi alterada, mas não consegui confirmar o acesso agora. Se o painel pedir usuário e senha, use os novos.');
      } else if (how === 'old') {
        pwResult('bad', 'O R3D PLAY disse que salvou, mas a senha não mudou. Provável falta de permissão no arquivo de credenciais; abra o R3D PLAY como administrador e tente de novo.');
        toast('A senha não foi alterada.', 'err');
      } else if (how === 'unreachable') {
        pwResult('warn', 'A senha foi alterada, mas o R3D PLAY não respondeu quando tentei entrar de novo. Espere alguns segundos; se o painel pedir usuário e senha, use os novos.');
      } else {
        pwResult('warn', 'A senha pode ter sido alterada, mas não consegui entrar de novo. Vou abrir a tela de entrada: use o usuário e a senha novos (ou os antigos, se os novos não servirem).');
        setTimeout(() => location.reload(), 3500);
      }
    });
  } catch (e) {
    log(`sistema/senha: ${e && e.message || e}`);       // só a mensagem: nunca os dados digitados
    pwResult('bad', 'Algo deu errado ao trocar a senha. Tente de novo.');
  } finally {
    S.pwBusy = false;
    state.sessionBusy = false;
    syncPwState();
  }
}
/** Limpa as senhas digitadas (não ficam na tela) e deixa o usuário atual pronto para a próxima vez. */
function wipePw(user, keepNew) {
  clearSecrets();
  E.pw.newUsername.input.value = '';
  if (!keepNew && user) E.pw.currentUsername.input.value = user;
  paintPwErrors({ errors: {}, warnings: {} });
}
/** Apaga as três senhas dos campos e esconde de novo (incluindo o botão do olho). Os nomes de usuário ficam. */
function clearSecrets() {
  for (const k of ['currentPassword', 'newPassword', 'confirmNewPassword']) {
    const f = E.pw[k];
    if (!f) continue;
    f.input.value = '';
    setReveal(f, false);
  }
}

async function doLogout() {
  // confirma ANTES de travar o botão: se a pessoa cancelar, o foco do teclado continua nele
  if (!(await confirmDlg('Sair da conta? O painel esquece o login salvo neste PC e passa a pedir o usuário e a senha. Tenha a senha em mãos.', 'Sair da conta', { danger: false, title: 'Sair da conta' }))) return;
  await busy(E.logoutBtn, async () => {
    const r = await native('logout');
    if (!r || r.error || r.ok === false) { toast('Não foi possível sair da conta. Tente de novo.', 'err'); return; }
    location.reload();
  });
}

/* ---------- Registro ---------- */
function buildLogs() {
  const L = S.log;
  E.logIssue = h('div', { class: 'sy-issue', hidden: true });
  E.logError = h('div', { class: 'sy-issue', hidden: true });
  E.chips = h('div', { class: 'seg sy-seg', role: 'radiogroup', 'aria-label': 'Filtrar por gravidade', on: { keydown: onChipKey } });
  E.chipBtn = {};
  for (const f of FILTERS) {
    E.chipBtn[f.id] = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', dataset: { filter: f.id }, on: { click: () => setFilter(f.id) } }, f.label, ' ', h('span', { class: 'sy-n' }));
    E.chips.append(E.chipBtn[f.id]);
  }
  E.search = h('input', {
    type: 'text', id: 'sy-log-search', placeholder: 'Procurar no registro…', 'aria-label': 'Procurar no registro', autocomplete: 'off', spellcheck: 'false',
    on: { input: onSearchInput, keydown: (e) => { if (e.key === 'Escape' && E.search.value) { e.stopPropagation(); E.search.value = ''; onSearchInput(); } } },
  });
  E.searchClear = h('button', { class: 'icon-btn sy-clear', type: 'button', 'aria-label': 'Limpar a busca', hidden: true, on: { click: () => { E.search.value = ''; onSearchInput(); E.search.focus(); } } }, icon('close'));
  E.logRefresh = h('button', { class: 'btn', type: 'button', on: { click: () => busy(E.logRefresh, () => loadLog({ manual: true })) } }, icon('refresh'), 'Atualizar');
  E.logCopy = h('button', { class: 'btn ghost', type: 'button', title: 'Copia tudo o que está filtrado, não só o que cabe na tela', on: { click: () => busy(E.logCopy, onLogCopy) } }, icon('content_copy'), 'Copiar');
  E.logEnd = h('button', { class: 'btn ghost', type: 'button', on: { click: () => { L.follow = true; scrollLogToEnd(); E.logBox.focus({ preventScroll: true }); } } }, icon('arrow_downward'), 'Ir para o fim');
  E.auto = h('input', { type: 'checkbox', role: 'switch', id: 'sy-log-auto', on: { change: onAutoChange } });
  L.auto = prefGet('logAuto', '0') === '1';
  E.auto.checked = L.auto;
  E.logMeta = h('p', { class: 'sy-meta', 'aria-live': 'off' });
  E.logHint = h('div', { class: 'sy-loghint', hidden: true });
  E.logBox = h('div', { class: 'sy-log', role: 'log', tabindex: '0', 'aria-label': 'Registro do R3D PLAY', 'aria-live': 'off', on: { scroll: () => { L.follow = E.logBox.scrollHeight - E.logBox.scrollTop - E.logBox.clientHeight < 48; } } });
  return panel('logs',
    E.logIssue, E.logError,
    h('div', { class: 'toolbar sy-bar' }, E.chips, h('div', { class: 'search sy-search' }, icon('search'), E.search, E.searchClear)),
    h('div', { class: 'sy-bar sy-bar2' }, E.logRefresh, E.logCopy, E.logEnd,
      h('label', { class: 'sy-auto', for: 'sy-log-auto' }, h('span', { class: 'switch' }, E.auto, h('span', { class: 'track' })), h('span', { text: 'Atualizar sozinho (a cada 5 s)' }))),
    E.logMeta, E.logBox, E.logHint);
}

function onChipKey(e) {
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const i = FILTERS.findIndex((f) => f.id === S.log.filter);
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
  const to = FILTERS[(i + d + FILTERS.length) % FILTERS.length].id;
  setFilter(to);
  E.chipBtn[to].focus();
}
function setFilter(id) {
  S.log.filter = filterById(id).id;
  S.log.follow = true;
  renderLog();
}
/** Define filtro e busca de uma vez (atalhos como "Mostrar só estes", "Ver no Registro" e go('system', {level})): a busca antiga NÃO sobrevive. */
function applyLogPreset(filterId, query = '') {
  const L = S.log;
  clearTimeout(S.searchTimer);
  S.searchTimer = 0;
  L.filter = filterById(filterId).id;
  L.query = query;
  L.follow = true;
  if (E.search) { E.search.value = query; E.searchClear.hidden = !query; }
}
function onSearchInput() {
  E.searchClear.hidden = !E.search.value;
  clearTimeout(S.searchTimer);
  S.searchTimer = setTimeout(() => { S.searchTimer = 0; S.log.query = E.search.value; S.log.follow = true; renderLog(); }, 160);
}
function onAutoChange() {
  S.log.auto = E.auto.checked;
  prefSet('logAuto', S.log.auto ? '1' : '0');
  syncAutoTimer();
  if (S.log.auto && S.active && S.tab === 'logs') loadLog({ silent: true });
}
/** Atualização automática: só com a tela aberta, na seção Registro, com a janela visível e o interruptor ligado (R10). */
function syncAutoTimer() {
  const want = S.active && S.tab === 'logs' && S.log.auto && !document.hidden;
  if (want && !S.autoTimer) S.autoTimer = setInterval(() => { if (!document.hidden) loadLog({ silent: true }); }, AUTO_MS);
  else if (!want && S.autoTimer) { clearInterval(S.autoTimer); S.autoTimer = 0; }
}
function onVisibility() {
  syncAutoTimer();
  if (!document.hidden && S.autoTimer) loadLog({ silent: true });
}

/** Há texto selecionado com o mouse dentro da caixa do registro? (redesenhar agora apagaria a seleção de quem está copiando um trecho) */
function selectionInLog() {
  const sel = globalThis.getSelection ? globalThis.getSelection() : null;
  if (!sel || sel.isCollapsed || !sel.rangeCount || !E.logBox) return false;
  return E.logBox.contains(sel.anchorNode) || E.logBox.contains(sel.focusNode);
}

function loadLog(opts = {}) {
  const L = S.log;
  if (L.promise) return L.promise;
  L.promise = (async () => {
    if (!L.loadedAt && S.mounted) { L.error = ''; renderLog(); }
    let r;
    try { r = await api('GET', '/api/logs'); } catch (e) { r = { ok: false, status: 0, text: '' }; }
    if (r.ok && typeof r.text === 'string') {
      if (L.loadedAt && !L.error && r.text === L.raw) {
        // Nada mudou desde a última leitura: só atualiza a hora. Redesenhar apagaria a seleção do mouse e recriaria até 1500 linhas à toa.
        L.loadedAt = Date.now();
        L.paused = false;
        if (S.mounted) { paintLogMeta(); paintIssues(); }     // paintIssues: "há 2 min" anda mesmo sem linha nova
        return;
      }
      if (opts.silent && L.loadedAt && selectionInLog()) {     // há linhas novas, mas a pessoa está copiando um trecho: espera ela soltar
        L.paused = true;
        if (S.mounted) paintLogMeta();
        return;
      }
      const p = parseLog(r.text);
      L.raw = r.text;
      L.entries = p.entries;
      L.lineCount = p.lineCount;
      L.loadedAt = Date.now();
      L.error = '';
      L.paused = false;
    } else {
      L.error = describeFailure(r.status);
      if (opts.manual) toast('Não foi possível atualizar o registro.', 'err');
    }
    if (S.mounted) { renderLog(); paintIssues(); }
  })().finally(() => { L.promise = null; });
  return L.promise;
}

function scrollLogToEnd() { if (E.logBox) E.logBox.scrollTop = E.logBox.scrollHeight; }

/** Desenha um registro. Todo texto vai por nó de texto (nada de HTML); a busca vira <mark>. */
function entryNode(e, query) {
  const lv = levelInfo(e.level);
  const body = h('div', { class: 'sy-msg' });
  const put = (text) => {
    const clipped = clipText(text);
    if (!query) { body.append(clipped); return; }
    for (const p of highlightParts(clipped, query)) body.append(p.match ? h('mark', { class: 'sy-mark', text: p.text }) : p.text);
  };
  put(lv ? entryMessage(e) : e.head);
  for (const l of e.cont) { body.append('\n'); put(l); }
  if (e.clipped) body.append(`\n… (+${fmtNum(e.clipped)} linhas)`);
  if (!lv) return h('div', { class: 'sy-entry lv-none' }, body);
  return h('div', { class: `sy-entry lv-${lv.css}` },
    h('span', { class: 'sy-time', title: e.time, text: entryClock(e) }), h('span', { class: 'sy-lv', text: lv.label }), body);
}

function logEmpty(iconName, title, text, action) {
  return h('div', { class: 'empty sy-empty' }, icon(iconName), h('strong', { text: title }), h('p', { class: 'muted', text }), action || null);
}

/** Nada na lista por causa do filtro/busca. Filtro de erros sem nenhum erro é uma BOA notícia, não um "nada encontrado". */
function emptyFiltered(f, query) {
  const clear = (label) => h('button', { class: 'btn', type: 'button', on: { click: clearFilters } }, label);
  const good = { fatal: ['Nenhum erro grave', 'Boa notícia: o R3D PLAY não registrou erros graves.'], error: ['Nenhum erro', 'Boa notícia: o R3D PLAY não registrou erros.'], warn: ['Nenhum aviso nem erro', 'Boa notícia: o R3D PLAY não registrou avisos nem erros.'] };
  if (!query && Object.hasOwn(good, f.id)) return logEmpty('check_circle', good[f.id][0], good[f.id][1], clear('Ver tudo'));
  const what = query ? (f.id === 'all' ? 'a busca atual' : 'a busca e o filtro atuais') : 'o filtro atual';
  return logEmpty('search_off', 'Nada encontrado', `Nenhum registro combina com ${what}.`, clear('Limpar filtros'));
}

function renderLog() {
  if (!S.mounted || !E.logBox) return;
  const L = S.log;
  const box = E.logBox;
  const prevTop = box.scrollTop;
  const follow = L.follow;
  L.view = { filtered: null, lim: null };
  box.replaceChildren();
  paintChips();
  E.logError.hidden = true;
  if (!L.loadedAt) {
    if (L.error) {
      box.append(logEmpty('error', 'Não consegui ler o registro', L.error, h('button', { class: 'btn', type: 'button', on: { click: (ev) => busy(ev.currentTarget, () => loadLog({ manual: true })) } }, icon('refresh'), 'Tentar de novo')));
    } else {
      box.append(h('div', { class: 'sy-sklist', 'aria-label': 'Carregando o registro' }, Array.from({ length: 9 }, (_, i) => h('div', { class: 'skeleton', style: { width: `${95 - (i * 7) % 40}%` } }))));
    }
    paintLogMeta();
    return;
  }
  if (L.error) {   // já tínhamos um registro: mantém na tela e avisa
    E.logError.hidden = false;
    E.logError.replaceChildren(notice('warn', 'warning', `Não consegui atualizar agora: ${L.error} Mostrando o registro lido às ${new Date(L.loadedAt).toLocaleTimeString('pt-BR')}.`));
  }
  if (!L.entries.length) {
    box.append(logEmpty('description', 'Sem registros ainda', 'O R3D PLAY anota aqui o que acontece enquanto ele roda. Quando algo for gravado, aparece nesta lista.'));
    paintLogMeta();
    return;
  }
  const f = filterById(L.filter);
  const filtered = filterEntries(L.entries, { minRank: f.minRank, query: L.query });
  if (!filtered.length) {
    box.append(emptyFiltered(f, normalizedQuery()));
    L.view = { filtered, lim: null };
    paintLogMeta();
    return;
  }
  const lim = limitLines(filtered, MAX_LINES);
  if (lim.truncated) {
    box.append(h('div', { class: 'sy-trunc' }, icon('info'), `${fmtNum(lim.hiddenLines)} linhas mais antigas não aparecem aqui, para a janela não travar. Use a busca ou os filtros para achá-las, ou "Copiar" para levar tudo.`));
  }
  const frag = document.createDocumentFragment();
  for (const e of lim.entries) frag.append(entryNode(e, normalizedQuery()));
  box.append(frag);
  box.scrollTop = follow ? box.scrollHeight : prevTop;
  L.view = { filtered, lim };
  paintLogMeta();
}
const normalizedQuery = () => S.log.query.trim();

function clearFilters() {
  applyLogPreset('all', '');
  renderLog();
}
function paintChips() {
  const L = S.log;
  for (const f of FILTERS) {
    const b = E.chipBtn[f.id];
    const on = f.id === L.filter;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
    b.querySelector('.sy-n').textContent = L.loadedAt ? fmtNum(countAtLeast(L.entries, f.minRank)) : '';
  }
}
/** Resumo acima da lista (usa o que renderLog guardou em L.view, então também serve quando a lista não foi redesenhada). */
function paintLogMeta() {
  const L = S.log;
  if (!L.loadedAt) { E.logMeta.textContent = L.error ? '' : 'Lendo o registro…'; return; }
  const { filtered, lim } = L.view;
  const when = `Atualizado às ${new Date(L.loadedAt).toLocaleTimeString('pt-BR')}.`;
  const total = L.entries.length;
  const shown = filtered ? filtered.length : total;
  let text = `${fmtNum(total)} ${total === 1 ? 'registro' : 'registros'} no arquivo`;
  if (shown !== total) text += `, ${fmtNum(shown)} combinam com o filtro`;
  text += '. ';
  if (lim && lim.truncated) text += `Mostrando as últimas ${fmtNum(lim.shownLines)} linhas. `;
  if (L.paused) text += 'Há linhas novas; a atualização espera você soltar o texto selecionado. ';
  E.logMeta.textContent = text + when;
}
function paintLogHint() {
  if (!S.mounted) return;
  const hint = E.logHint;
  if (!S.cfgOk) { hint.hidden = true; return; }
  const d = describeLogLevelHint(describeMinLogLevel(S.cfg.min_log_level));
  hint.hidden = false;
  const goBtn = h('button', { class: 'btn ghost sy-small', type: 'button', on: { click: () => goSetting('min_log_level') } }, icon('settings'), 'Mudar em Configurações');
  hint.replaceChildren(notice(d.kind, d.kind === 'warn' ? 'warning' : 'info', d.text, goBtn));
}

/** Avisos de erro no registro: na seção Registro (com atalho para filtrar) e em Informações (atalho para abrir o Registro). */
function paintIssues() {
  if (!S.mounted) return;
  const L = S.log;
  const sum = summarizeIssues(L.entries, Date.now());
  const d = describeIssues(sum);
  // Emblema e faixa de Informações só acendem para o que importa agora: erro grave, ou erro recente que NÃO é o mesmo texto repetido
  // (um erro periódico e inofensivo deixaria o aviso aceso para sempre e a pessoa acharia que algo está quebrado).
  const important = !!d && (d.kind === 'bad' || d.kind === 'warn');
  const total = sum.fatal + sum.error;
  E.logBadge.hidden = !important;
  E.logBadge.textContent = important ? (total > 99 ? '99+' : String(total)) : '';
  E.logBadge.classList.toggle('bad', sum.fatal > 0);
  E.logBadge.title = important ? `${total} ${total === 1 ? 'erro' : 'erros'} no registro` : '';
  E.tabs.logs.setAttribute('aria-label', important ? `Registro, ${total} ${total === 1 ? 'erro' : 'erros'}` : 'Registro');
  // Só refaz os avisos (e os botões deles) quando o texto muda: refazer a cada leitura tiraria o foco de quem navega pelo teclado.
  const key = d ? `${d.kind}|${d.preset}|${d.text}` : '';
  if (key === L.issueKey) return;
  L.issueKey = key;
  if (!d) { E.logIssue.hidden = true; E.infoIssue.hidden = true; E.logIssue.replaceChildren(); E.infoIssue.replaceChildren(); return; }
  const showErrors = h('button', { class: 'btn ghost sy-small', type: 'button', on: { click: () => { applyLogPreset(d.preset); renderLog(); } } }, 'Mostrar só estes');
  const openLog = h('button', { class: 'btn ghost sy-small', type: 'button', on: { click: () => { applyLogPreset(d.preset); selectTab('logs', { focus: true }); } } }, 'Ver no Registro');
  const icn = d.kind === 'bad' ? 'error' : d.kind === 'warn' ? 'warning' : 'info';
  E.logIssue.hidden = false;
  E.logIssue.replaceChildren(notice(d.kind, icn, d.text, showErrors));
  E.infoIssue.hidden = !important;
  E.infoIssue.replaceChildren(...(important ? [notice(d.kind, icn, d.text, openLog)] : []));
}

async function onLogCopy() {
  const L = S.log;
  const f = filterById(L.filter);
  const list = filterEntries(L.entries, { minRank: f.minRank, query: L.query });
  if (!list.length) { toast('Não há nada para copiar.', ''); return; }
  const lines = list.reduce((n, e) => n + 1 + e.cont.length, 0);
  const ok = await copyText(entriesToText(list));
  toast(ok ? `Copiado: ${fmtNum(lines)} linhas.` : 'Não foi possível copiar.', ok ? 'ok' : 'err');
}

/* ---------- Ciclo de vida ---------- */
function sectionFromParams(params) {
  const raw = String((params && (params.section ?? params.tab ?? params.focus)) ?? '').trim().toLowerCase();
  return own(SECTION_ALIASES, raw) || '';
}
/** Recarrega o registro em silêncio (não pisca "carregando" nem mostra aviso de falha em toast). */
function reloadLogQuietly() {
  loadLog({ silent: true }).catch((e) => log(`sistema/registro: ${e && e.stack || e}`));
}
function onOnline() {
  expireResults();                 // "encerrado" e "não voltou" deixam de valer quando o R3D PLAY volta
  syncActionState();
  if (!S.active) return;
  if (state.online) {
    refreshInfo();
    reloadLogQuietly();            // o aviso "não consegui atualizar" do registro sumiria só com um clique em Atualizar
  } else {
    // main.js marca "fora do ar" também quando o servidor responde com erro 5xx; descobre qual dos dois é para liberar o Reiniciar
    probeServer().then(() => { syncActionState(); paintActionHints(); }).catch(() => {});
  }
}
function onRestarted() {
  if (!S.active) return;
  refreshInfo();
  reloadLogQuietly();              // o registro é recomeçado a cada início do servidor: o que está na tela já é o antigo
}
function onApps() {
  expireResults();
  paintActionHints();
  paintStream();
}
function teardown() {
  for (const off of S.offs.splice(0)) { try { off(); } catch { /* já cancelado */ } }
  document.removeEventListener('visibilitychange', onVisibility);
  stopTick();
  clearTimeout(S.searchTimer);
  S.searchTimer = 0;
  if (S.autoTimer) { clearInterval(S.autoTimer); S.autoTimer = 0; }
}

export default {
  id: 'system', tab: 'Sistema', title: 'Sistema',
  mount(root) {
    if (S.mounted) return;
    root.classList.add('sy-screen');
    E.panels = { info: buildInfo(), actions: buildActions(), security: buildSecurity(), logs: buildLogs() };
    root.append(buildTabs(), ...SECTIONS.map((s) => E.panels[s.id]));
    S.mounted = true;
    selectTab('info');
    paintInfo();
    paintSecurity();
    syncActionState();
    paintActionHints();
  },
  async show(params = {}) {
    teardown();                                   // show pode repetir sem hide (go() para a própria tela): não acumula ouvintes
    S.active = true;
    S.offs.push(bus.on('online', onOnline), bus.on('apps', onApps), bus.on('restarted', onRestarted));
    document.addEventListener('visibilitychange', onVisibility);
    expireResults({ aged: true });                // o servidor pode ter voltado (ou o resultado ficado velho) enquanto a tela estava fechada
    // level/query abrem o Registro já filtrado (ex.: go('system', { level: 'fatal' })); sem `query`, a busca antiga não sobrevive
    const wantsLog = !!params.level || typeof params.query === 'string';
    if (wantsLog) applyLogPreset(params.level ? filterById(params.level).id : S.log.filter, typeof params.query === 'string' ? params.query : '');
    selectTab(sectionFromParams(params) || (wantsLog ? 'logs' : S.tab));
    syncActionState();
    paintActionHints();
    if (S.restart) startTick();
    refreshInfo();                                // sem await: a aba aparece na hora e os dados chegam em seguida
    if (S.tab !== 'logs' && Date.now() - S.log.loadedAt > 30000) loadLog().catch((e) => log(`sistema/registro: ${e && e.stack || e}`));   // para o aviso/emblema de erros
  },
  hide() {
    S.active = false;
    teardown();
    // senhas digitadas não ficam na tela (nem reveladas) quando a pessoa sai; os nomes de usuário continuam
    if (S.mounted) { clearSecrets(); if (!S.pwBusy) pwResult(null); paintPwErrors({ errors: {}, warnings: {} }); }
    // registro de depuração pode ter centenas de milhares de linhas: não o segura na memória com a tela fechada
    if (S.log.entries.length > 20000) { S.log.entries = []; S.log.raw = ''; S.log.loadedAt = 0; S.log.lineCount = 0; S.log.view = { filtered: null, lim: null }; }
  },
};
