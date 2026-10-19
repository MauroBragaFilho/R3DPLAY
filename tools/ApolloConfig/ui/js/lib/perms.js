// Permissões e opções dos dispositivos pareados: lógica PURA (sem DOM, sem rede), testada em dev/tests/devices-perms.test.mjs.
// Fonte de verdade dos números: ui/schema/clients.json (o teste confere este arquivo contra o schema, para os dois nunca divergirem).
// Regras que moram aqui: a máscara de bits, as implicações (iniciar => assistir => listar), os modelos de acesso, o selo de risco
// e a montagem do corpo de POST /api/clients/update (que SUBSTITUI o dispositivo inteiro, com tipos estritos).
'use strict';

/* ---------- Máscaras ---------- */
/** Todos os bits que o servidor guarda (0x071F1F00). Qualquer outro bit é descartado por ele ao ler e ao gravar. */
export const PERM_ALL = 119480064;
/** O que o servidor dá a todo dispositivo pareado depois do primeiro: listar + assistir. */
export const PERM_DEFAULT = 50331648;
/** view|launch: sem nenhum dos dois o dispositivo não consegue transmitir (e, se estava transmitindo, é desconectado na hora). */
export const PERM_STREAM = 100663296;

export const GROUPS = [
  { id: 'action', label: 'Jogos e transmissão', help: 'Ver a lista de aplicativos, assistir e abrir/fechar aplicativos.' },
  { id: 'input', label: 'Controles e entradas', help: 'O que o dispositivo pode mandar para o PC enquanto transmite.' },
  { id: 'operation', label: 'Recursos do PC', help: 'Área de transferência, comandos do servidor e arquivos. Use com cuidado.' },
];

/**
 * Permissões na ordem em que aparecem na tela. `implies`/`impliedBy` = implicações (marcar iniciar marca assistir e listar).
 * `shown: false` = o bit existe no servidor mas não faz nada ainda: não vira caixa de seleção (só entra pelo modelo "Controle total").
 */
export const PERMISSIONS = [
  { name: 'list', bit: 16777216, group: 'action', label: 'Lista de aplicativos', danger: 'baixo', shown: true, impliedBy: ['view', 'launch'],
    help: 'Mostra os aplicativos do PC no dispositivo. Sem nenhuma das três permissões de “Jogos e transmissão” (lista, ver transmissões ou iniciar), o dispositivo vê só um aviso de acesso negado no lugar da lista.' },
  { name: 'view', bit: 33554432, group: 'action', label: 'Ver transmissões', danger: 'baixo', shown: true, implies: ['list'], impliedBy: ['launch'],
    help: "Permite entrar numa transmissão que já está aberta (retomar o jogo em execução ou, se o modo só-entrada estiver ativado nas configurações, entrar nele). Necessária para usar a área de transferência (basta “Ver transmissões” ou “Iniciar aplicativos”). Retirar “Ver transmissões” e “Iniciar aplicativos” de um dispositivo conectado o desconecta na hora." },
  { name: 'launch', bit: 67108864, group: 'action', label: 'Iniciar aplicativos', danger: 'medio', shown: true, implies: ['view', 'list'],
    help: 'Permite abrir um aplicativo e encerrar o que está rodando no PC (para abrir outro, o atual precisa ser encerrado antes). Inclui “Ver transmissões” e “Lista de aplicativos”.' },
  { name: 'input_controller', bit: 256, group: 'input', label: 'Entrada de controle', danger: 'baixo', shown: true,
    help: 'Botões, analógicos, gatilhos, touchpad, sensores de movimento e bateria do controle enviados ao PC.' },
  { name: 'input_touch', bit: 512, group: 'input', label: 'Entrada de toque', danger: 'baixo', shown: true,
    help: 'Toques reais na tela (multitoque) repassados ao PC. Se o cliente simula um touchpad, ele envia mouse, que depende da permissão de mouse.' },
  { name: 'input_pen', bit: 1024, group: 'input', label: 'Entrada de caneta', danger: 'baixo', shown: true,
    help: 'Caneta digital com pressão e inclinação.' },
  { name: 'input_mouse', bit: 2048, group: 'input', label: 'Entrada de mouse', danger: 'medio', shown: true,
    help: 'Movimento, cliques e rolagem do mouse. Permite controlar o PC inteiro, não só o jogo.' },
  { name: 'input_kbd', bit: 4096, group: 'input', label: 'Entrada de teclado', danger: 'medio', shown: true,
    help: 'Teclas e digitação de texto. Permite controlar o PC inteiro, não só o jogo.' },
  { name: 'clipboard_set', bit: 65536, group: 'operation', label: 'Escrever na área de transferência', danger: 'medio', shown: true,
    help: "O dispositivo pode colocar texto na área de transferência do PC. Funciona só durante uma transmissão do próprio dispositivo e exige “Ver transmissões” (ou “Iniciar aplicativos”)." },
  { name: 'clipboard_read', bit: 131072, group: 'operation', label: 'Ler da área de transferência', danger: 'alto', shown: true,
    help: "O dispositivo pode copiar o texto da área de transferência do PC (pode conter senhas). Funciona só durante uma transmissão do próprio dispositivo e exige “Ver transmissões” (ou “Iniciar aplicativos”)." },
  { name: 'file_upload', bit: 262144, group: 'operation', label: 'Upload de arquivos', danger: 'alto', shown: false,
    help: 'Reservado: o servidor checa esta permissão num pacote de controle, mas ainda não transfere arquivos.' },
  { name: 'file_dwnload', bit: 524288, group: 'operation', label: 'Download de arquivos', danger: 'alto', shown: false,
    help: 'Reservado: nenhuma parte do servidor usa esta permissão ainda.' },
  { name: 'server_cmd', bit: 1048576, group: 'operation', label: 'Comandos de servidor', danger: 'alto', shown: true,
    help: "Mostra no dispositivo e executa os 'comandos do servidor' cadastrados nas configurações do R3D PLAY (podem rodar como administrador). Só libere para dispositivos de total confiança." },
];
const BY_NAME = Object.fromEntries(PERMISSIONS.map((p) => [p.name, p]));
export const SHOWN_PERMISSIONS = PERMISSIONS.filter((p) => p.shown);
export const permByName = (name) => BY_NAME[name] || null;

/** Modelos de acesso (atalhos que marcam várias permissões de uma vez). `mask` já traz os bits implicados explícitos. */
export const PRESETS = [
  { id: 'bloqueado', label: 'Sem acesso', mask: 0, risk: 'nenhum', icon: 'block',
    help: 'Continua pareado, mas não vê aplicativos nem transmite. Se estiver transmitindo, é desconectado na hora. Útil para suspender um dispositivo sem despareá-lo.' },
  { id: 'apenas_ver', label: 'Apenas ver', mask: 50331648, risk: 'baixo', icon: 'visibility',
    help: 'Vê a lista de aplicativos e assiste a uma transmissão que já está aberta, sem controlar nada e sem abrir ou fechar aplicativos. É o que o servidor dá a todo dispositivo pareado depois do primeiro.' },
  { id: 'participar', label: 'Participar (sem abrir jogos)', mask: 50339584, risk: 'medio', icon: 'group',
    help: 'Entra numa partida que já está aberta e joga com controle, teclado, mouse, toque e caneta, mas não pode abrir nem fechar aplicativos. Só funciona com um jogo já rodando no PC.' },
  { id: 'jogar_controle', label: 'Jogar só com controle', mask: 117440768, risk: 'medio', icon: 'sports_esports',
    help: 'Abre e fecha aplicativos e joga apenas com o controle (gamepad). Sem teclado, mouse, toque ou caneta: não dá para mexer no resto do Windows.' },
  { id: 'jogar', label: 'Jogar', mask: 117448448, risk: 'medio', icon: 'videogame_asset',
    help: 'Abre e fecha aplicativos e usa controle, teclado, mouse, toque e caneta. Sem área de transferência nem comandos do servidor.' },
  { id: 'controle_total', label: 'Controle total', mask: 119480064, risk: 'alto', icon: 'admin_panel_settings',
    help: 'Tudo liberado: jogar, usar a área de transferência e executar comandos do servidor. Só para os seus dispositivos.' },
];
export const CUSTOM_LABEL = 'Personalizado';
export const FULL_PRESET_ID = 'controle_total';
export const presetById = (id) => PRESETS.find((p) => p.id === id) || null;

/** Selos de risco: rótulo em português e o tom do .badge (ok/warn/bad; '' = neutro). */
export const RISKS = {
  nenhum: { label: 'Sem acesso', tone: '' },
  baixo: { label: 'Risco baixo', tone: 'ok' },
  medio: { label: 'Risco médio', tone: 'warn' },
  alto: { label: 'Risco alto', tone: 'bad' },
};

/* ---------- Operações sobre a máscara ---------- */
/**
 * Qualquer coisa -> inteiro sem sinal de 32 bits já recortado pelos bits válidos.
 * Lixo (NaN, texto, null, negativo, maior que 32 bits) vira 0: na dúvida, SEM permissão (nunca "tudo" por acidente).
 */
export function coerceMask(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 0xFFFFFFFF) return 0;
  return (Math.trunc(n) >>> 0) & PERM_ALL;
}

/** Torna explícitas as implicações: iniciar => assistir => listar. É com ela que se comparam máscaras e modelos. */
export function normalizeMask(v) {
  let m = coerceMask(v);
  if (m & BY_NAME.launch.bit) m |= BY_NAME.view.bit;
  if (m & BY_NAME.view.bit) m |= BY_NAME.list.bit;
  return m;
}

/** Bits que `name` obriga a ligar junto (por exemplo iniciar => assistir + listar). Não inclui o próprio bit. */
function impliedBits(name) {
  let bits = 0;
  for (const dep of BY_NAME[name]?.implies || []) bits |= BY_NAME[dep].bit | impliedBits(dep);
  return bits;
}

/** Nome da permissão ligada que obriga `name` a ficar ligada (a caixa aparece marcada e travada), ou null. */
export function lockedBy(mask, name) {
  const m = coerceMask(mask);
  for (const by of BY_NAME[name]?.impliedBy || []) if (m & BY_NAME[by].bit) return by;
  return null;
}

/** A permissão vale (bit ligado OU implicada por outra ligada)? É o que a caixa de seleção mostra. */
export function hasPerm(mask, name) {
  const p = BY_NAME[name];
  if (!p) return false;
  return !!(coerceMask(mask) & p.bit) || lockedBy(mask, name) !== null;
}

/**
 * Liga/desliga uma permissão. Ligar também liga as implicadas (iniciar marca assistir e listar; assistir marca listar).
 * Desligar não faz nada enquanto outra permissão ligada a exige (iniciar trava assistir e listar; assistir trava listar).
 * Bits que a tela não mostra (upload/download) e os demais ficam como estavam.
 */
export function togglePerm(mask, name, on) {
  const p = BY_NAME[name];
  const m = coerceMask(mask);
  if (!p) return m;
  if (on) return m | p.bit | impliedBits(name);
  if (lockedBy(m, name)) return m;
  return m & ~p.bit;
}

/** Bits que existem no servidor mas não viram caixa (upload/download): hoje não fazem nada. */
const HIDDEN_BITS = PERMISSIONS.filter((p) => !p.shown).reduce((m, p) => m | p.bit, 0);
/** Bits que a tela mostra. */
export const VISIBLE_MASK = PERM_ALL & ~HIDDEN_BITS;
/**
 * Forma usada para COMPARAR com os modelos: normalizada e sem os bits escondidos. Sem isso, quem marca as 11 caixas que a tela mostra
 * continuaria "Personalizado" e "Acesso limitado" só por faltarem dois bits que ninguém consegue marcar. (Para GRAVAR vale a máscara inteira.)
 */
const comparable = (v) => normalizeMask(v) & VISIBLE_MASK;

/** Modelo equivalente à máscara dada (comparando como acima), ou null ("Personalizado"). */
export function presetOf(mask) {
  const n = comparable(mask);
  return PRESETS.find((p) => comparable(p.mask) === n) || null;
}

/** Risco da máscara: alto > médio > baixo; "nenhum" se não sobrou permissão nenhuma. */
export function riskOf(mask) {
  const m = coerceMask(mask);
  if (m === 0) return 'nenhum';
  const has = (n) => (m & BY_NAME[n].bit) !== 0;
  if (['server_cmd', 'clipboard_read', 'file_upload', 'file_dwnload'].some(has)) return 'alto';
  if (['launch', 'input_mouse', 'input_kbd', 'clipboard_set'].some(has)) return 'medio';
  return 'baixo';
}

/** É controle total (todas as caixas que a tela mostra)? Quem não é recebe o selo "Acesso limitado" e o botão "Dar acesso total". */
export const isFullAccess = (mask) => comparable(mask) === VISIBLE_MASK;

/** Sem assistir nem iniciar? Então um dispositivo conectado é derrubado na hora (pedir confirmação). */
export const revokesStreaming = (mask) => (normalizeMask(mask) & PERM_STREAM) === 0;

/** Quantas das permissões que a tela mostra estão valendo (para o resumo "7 de 11"). */
export const countShown = (mask) => SHOWN_PERMISSIONS.filter((p) => hasPerm(mask, p.name)).length;

/* ---------- Campos do dispositivo ---------- */
export const FIELD_KEYS = ['name', 'perm', 'enable_legacy_ordering', 'allow_client_commands', 'always_use_virtual_display', 'display_mode', 'do', 'undo'];
export const FIELD_LABELS = {
  name: 'nome', perm: 'permissões', enable_legacy_ordering: 'ordenação legada', allow_client_commands: 'comandos do cliente',
  always_use_virtual_display: 'monitor virtual', display_mode: 'modo de monitor', do: 'comandos ao conectar', undo: 'comandos ao desconectar',
};

/** Valor booleano estrito vindo do servidor (aceita 'true'/'false' por segurança); outra coisa cai no padrão. */
function strictBool(v, dflt) {
  if (v === true || v === 'true' || v === 1) return true;
  if (v === false || v === 'false' || v === 0) return false;
  return dflt;
}

/** Lista de comandos -> [{cmd, elevated:boolean}] com `cmd` aparado e linhas vazias descartadas (o servidor não filtra cmd vazio). */
export function cleanCommands(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list) {
    if (!it || typeof it.cmd !== 'string') continue;
    const cmd = it.cmd.trim();
    if (!cmd) continue;
    out.push({ cmd, elevated: strictBool(it.elevated, false) });
  }
  return out;
}

/** Cópia editável do dispositivo: só os campos que a tela edita, com os tipos certos e os padrões do servidor. */
export function draftFrom(dev) {
  const d = dev || {};
  return {
    name: typeof d.name === 'string' ? d.name : '',
    perm: coerceMask(d.perm),
    enable_legacy_ordering: strictBool(d.enable_legacy_ordering, true),
    allow_client_commands: strictBool(d.allow_client_commands, true),
    always_use_virtual_display: strictBool(d.always_use_virtual_display, false),
    display_mode: typeof d.display_mode === 'string' ? d.display_mode : '',
    // Mantém as linhas como estão (inclusive vazias) para a tela poder editar; a limpeza acontece só ao gravar.
    do: rawCommands(d.do),
    undo: rawCommands(d.undo),
  };
}
function rawCommands(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((it) => it && typeof it === 'object').map((it) => ({ cmd: typeof it.cmd === 'string' ? it.cmd : '', elevated: strictBool(it.elevated, false) }));
}

/** Dois valores do mesmo campo são equivalentes? (perm compara a máscara recortada; comandos comparam a lista limpa.) */
export function sameField(key, a, b) {
  if (key === 'perm') return coerceMask(a) === coerceMask(b);
  if (key === 'do' || key === 'undo') return JSON.stringify(cleanCommands(a)) === JSON.stringify(cleanCommands(b));
  if (key === 'name' || key === 'display_mode') return String(a ?? '').trim() === String(b ?? '').trim();
  return a === b;
}

/** Chaves editáveis que diferem entre dois dispositivos (objetos do servidor). */
export function diffDevice(a, b) {
  const da = draftFrom(a);
  const db = draftFrom(b);
  return FIELD_KEYS.filter((k) => !sameField(k, da[k], db[k]));
}

/** Chaves que o usuário mexeu E que ainda diferem do salvo (mexeu e voltou ao valor original = não conta). */
export function changedKeys(base, draft, touched) {
  const b = draftFrom(base);
  return FIELD_KEYS.filter((k) => touched.has(k) && !sameField(k, b[k], draft[k]));
}

/**
 * Tira de `touched` os campos que o usuário mexeu mas que voltaram ao valor salvo (marcou e desmarcou). Sem isto, uma mudança feita
 * em outro lugar seria desfeita no rascunho e o cartão mostraria "Não salvo" com o valor ANTIGO. Altera o Set recebido.
 */
export function pruneTouched(base, draft, touched) {
  const b = draftFrom(base);
  for (const k of [...touched]) if (sameField(k, b[k], draft[k])) touched.delete(k);
  return touched;
}

/**
 * Atualização vinda do servidor com uma edição em andamento: o que o usuário NÃO mexeu acompanha o servidor
 * (para uma alteração feita em outro lugar não ser desfeita ao salvar); o que ele mexeu é preservado.
 */
export function rebaseDraft(draft, touched, newBase) {
  const nb = draftFrom(newBase);
  const out = { ...draft };
  for (const k of FIELD_KEYS) if (!touched.has(k)) out[k] = nb[k];
  return out;
}

/* ---------- Validações ---------- */
export const DISPLAY_MODE_ERROR = 'Modo inválido. Use LARGURAxALTURAxFPS, por exemplo 2400x1080x60.';
/** Vazio é permitido (modo automático). Exige as 3 partes e nenhuma zero (sem FPS o servidor divide por zero). Devolve null ou a mensagem. */
export function validateDisplayMode(value) {
  const s = String(value ?? '').trim();
  if (s === '') return null;
  const m = /^(\d+)x(\d+)x(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) return DISPLAY_MODE_ERROR;
  if (!(Number(m[1]) > 0 && Number(m[2]) > 0 && Number(m[3]) > 0)) return DISPLAY_MODE_ERROR;
  return null;
}

/** Há algum comando "elevado" (administrador) que NÃO existia na lista salva? Serve para pedir confirmação antes de gravar. */
export function addsElevated(oldList, newList) {
  const had = new Set(cleanCommands(oldList).filter((c) => c.elevated).map((c) => c.cmd));
  return cleanCommands(newList).some((c) => c.elevated && !had.has(c.cmd));
}

/* ---------- Corpo do POST /api/clients/update ---------- */
/**
 * Monta o corpo que SUBSTITUI o dispositivo inteiro: copia o objeto lido da lista (sem `connected`), troca só os campos de `changes`
 * e garante os tipos estritos (perm número recortado; flags boolean; name/display_mode string; do/undo [{cmd, elevated:boolean}]).
 * Campos que não fazem parte das chaves editáveis em `changes` são ignorados. Lança Error (em português) se não der para gravar com segurança.
 */
export function buildUpdateBody(fresh, changes = {}) {
  if (!fresh || typeof fresh.uuid !== 'string' || !fresh.uuid) throw new Error('O dispositivo não tem identificador.');
  const has = (k) => Object.prototype.hasOwnProperty.call(changes, k);
  const curPerm = typeof fresh.perm === 'string' && fresh.perm.trim() !== '' ? Number(fresh.perm) : fresh.perm;   // número, ou texto numérico (defensivo)
  if (!has('perm') && (typeof curPerm !== 'number' || !Number.isFinite(curPerm))) {
    throw new Error('O servidor não informou as permissões atuais deste dispositivo; por segurança nada foi gravado.');
  }
  const body = {};
  for (const [k, v] of Object.entries(fresh)) if (k !== 'connected' && v !== undefined) body[k] = v;
  const cur = draftFrom(fresh);
  const pick = (k) => (has(k) ? changes[k] : cur[k]);

  body.name = String(pick('name') ?? '');
  // Só valida o modo se o usuário mexeu nele: um valor inválido que o painel antigo deixou salvar não pode impedir renomear,
  // mudar permissões etc. Sem mudança, reenvia o valor guardado (só aparado).
  if (has('display_mode')) {
    const mode = String(changes.display_mode ?? '').trim();
    const modeErr = validateDisplayMode(mode);
    if (modeErr) throw new Error(modeErr);
    body.display_mode = mode;
  } else {
    body.display_mode = typeof fresh.display_mode === 'string' ? fresh.display_mode.trim() : '';
  }
  body.perm = has('perm') ? normalizeMask(changes.perm) : coerceMask(fresh.perm);
  body.enable_legacy_ordering = strictBool(pick('enable_legacy_ordering'), true);
  body.allow_client_commands = strictBool(pick('allow_client_commands'), true);
  body.always_use_virtual_display = strictBool(pick('always_use_virtual_display'), false);
  for (const k of ['do', 'undo']) {
    const list = cleanCommands(pick(k));
    // Chave ausente na lista do servidor = vazia; só reenvia se havia algo ou se o usuário mexeu.
    if (list.length || has(k) || k in fresh) body[k] = list;
    else delete body[k];
  }
  return body;
}

/** Depois de gravar: quais campos enviados o servidor NÃO guardou? (o nome fica de fora: o servidor pode ajustá-lo, ex.: acrescenta " (2)".) */
export function lostFields(sent, got) {
  if (!got) return FIELD_KEYS.slice();
  const a = draftFrom(sent);
  const b = draftFrom(got);
  return FIELD_KEYS.filter((k) => k !== 'name' && !sameField(k, a[k], b[k]));
}
