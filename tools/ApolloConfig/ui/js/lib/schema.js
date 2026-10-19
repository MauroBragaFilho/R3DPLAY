// Catálogo das opções da tela Configurações (lido de ui/schema/*.json) e regras PURAS sobre ele:
// plataforma, condições showIf, textos por plataforma, busca, descrição de dependências e o estado do driver de tela virtual.
// Sem DOM e sem importar o core: roda no navegador (loadCatalog) e no Node (buildCatalog, usado pelos testes).
'use strict';

/* ---------- Categorias do menu lateral ---------- */
// file = nome do schema; label = rótulo curto do menu; intro = frase de apoio para quem não é técnico.
export const CATEGORIES = [
  { id: 'general', file: 'general', label: 'Geral', icon: 'tune', intro: 'Nome do PC, idioma, comandos automáticos e pareamento.' },
  { id: 'audiovideo', file: 'audiovideo', label: 'Áudio e vídeo', icon: 'videocam', intro: 'Som, monitor capturado, tela virtual e qualidade máxima do vídeo.' },
  { id: 'encoders', file: 'encoders', label: 'Codificadores', icon: 'memory', intro: 'Ajustes finos do codificador de vídeo. Só mexa na seção da marca da sua placa de vídeo (NVIDIA, Intel ou AMD); as outras são ignoradas.' },
  { id: 'inputs', file: 'inputs', label: 'Entradas', icon: 'sports_esports', intro: 'Controle de jogo, teclado e mouse enviados pelo celular.' },
  { id: 'network', file: 'network', label: 'Rede e arquivos', icon: 'lan', intro: 'Portas, segurança do painel e onde o R3D PLAY guarda seus arquivos.' },
  { id: 'advanced', file: 'advanced', label: 'Avançado', icon: 'build', intro: 'Ajustes técnicos. Os valores padrão funcionam bem para a maioria dos casos.' },
  { id: 'outros', file: 'outros', label: 'Outras', icon: 'more_horiz', intro: 'Opções que não se encaixam nas demais categorias.' },
];
export const SCHEMA_FILES = CATEGORIES.map((c) => c.file);

/* ---------- Textos: marca e linguagem ---------- */
// A marca visível é R3D PLAY (o app do celular é o R3D LAUNCHER). Cobre o que sobrou dos textos herdados dos schemas.
const BRAND_RULES = [
  [/clientes? Artemis\/Moonlight/gi, 'aplicativo do celular'],
  [/clientes Artemis/gi, 'aplicativos do celular'],
  [/clientes Moonlight/gi, 'aplicativos do celular'],
  [/cliente Moonlight/gi, 'aplicativo do celular'],
  [/pelo Moonlight/gi, 'pelo aplicativo do celular'],
  [/do Moonlight/gi, 'do aplicativo do celular'],
  [/\bMoonlight\b/g, 'aplicativo do celular'],
  [/\bArtemis\b/g, 'aplicativo do celular'],
  [/\b(Apollo|Sunshine)\b/g, 'R3D PLAY'],
  // Restos de tradução e de interface antiga que não existem neste painel.
  [/\(traduzido\)\s*/gi, ''],
  [/na guia Solução de Problemas/g, 'na aba Sistema, em Registro'],
  [/\balgums\b/g, 'alguns'],
  [/\bForce um\b/g, 'Use um'],
  [/launcher R3D PLAY/g, 'R3D LAUNCHER'],
  // Vocabulário do resto do painel: "celular" e "este PC" em vez de cliente/servidor/convidados.
  [/\bos convidados controlem o (teclado|mouse) do servidor/g, 'quem usa o celular controle o $1 deste PC'],
  [/\bos convidados controlem o servidor/g, 'quem usa o celular controle este PC'],
  [/gamepad do cliente/g, 'controle do celular'],
  [/emulado no servidor/g, 'emulado neste PC'],
  [/entrada incorreta no servidor/g, 'entrada incorreta neste PC'],
  [/teclas do cliente/g, 'teclas do celular'],
  [/inserir manualmente o IP do host no cliente/g, 'digitar manualmente o endereço IP deste PC no aplicativo do celular'],
  [/pelo cliente\b/g, 'pelo aplicativo do celular'],
];
/** Troca nomes de outras marcas por termos neutros. Puro. */
export function brandSafe(text) {
  if (typeof text !== 'string') return text;
  return BRAND_RULES.reduce((t, [re, to]) => t.replace(re, to), text);
}

// Correções pontuais de jargão confuso (o significado não muda). Só rótulo/ajuda/placeholder.
const TEXT_FIXES = {
  locale: {
    label: 'Idioma da página web interna',
    help: 'Idioma da página web interna do servidor. Este painel sempre aparece em português, qualquer que seja a escolha. Só vale depois de reiniciar o R3D PLAY.',
  },
  sunshine_name: {
    label: 'Nome deste PC no celular',
    help: 'O nome que aparece no celular ao procurar este PC. Se ficar em branco, o R3D PLAY usa o nome do computador.',
    placeholder: 'Nome do computador',
  },
  global_prep_cmd: { label: 'Comandos antes e depois de qualquer jogo' },
  global_state_cmd: { label: 'Comandos ao retomar e ao pausar' },
  server_cmd: { label: 'Comandos do servidor (disparados pelo celular)' },
  enable_pairing: { help: 'Permite parear celulares novos. O pareamento autentica o celular com o servidor e cria uma conexão segura.' },
  dd_resolution_option: { help: 'Para isto funcionar, a opção "Otimizar configurações do jogo" precisa estar ativada no aplicativo do celular.' },
  max_bitrate: {
    label: 'Taxa de bits máxima (limite da qualidade do vídeo)',
    help: 'Limite da taxa de bits do vídeo, em Kbps. Com 0, o R3D PLAY usa sempre a taxa pedida pelo aplicativo do celular.',
  },
  key_rightalt_to_key_win: { help: 'Alguns aplicativos de celular não conseguem enviar a tecla Windows. Nesses casos, pode ser útil fazer o R3D PLAY tratar a tecla Alt direito como se fosse a tecla Windows.' },
  ping_timeout: { help: 'Quanto tempo esperar, em milissegundos, por dados do aplicativo do celular antes de encerrar a transmissão.' },
  legacy_ordering: { help: 'Ativa uma solução para aplicativos de celular antigos ordenarem a lista de jogos. Pode causar problemas com aplicativos ou scripts que não tratam UTF-8 corretamente. Os aplicativos mais novos já oferecem esse suporte por padrão.' },
  origin_web_ui_allowed: {
    label: 'Quem pode abrir este painel',
    help: 'De onde é permitido abrir esta interface web: somente deste PC, da rede local (casa ou Wi-Fi) ou de qualquer lugar.',
  },
  share_library: { label: 'Compartilhar a biblioteca de jogos com o R3D LAUNCHER' },
  external_ip: { placeholder: '203.0.113.25' },   // endereço de exemplo (faixa reservada para documentação), não um IP real
  fallback_mode: { help: 'O R3D PLAY usa este modo quando o aplicativo do celular não pede um modo ou quando o jogo é iniciado pelo painel. Formato: LarguraxAlturaxFPS, por exemplo 1920x1080x60.' },
  keybindings: {
    help: 'Faz uma tecla do celular funcionar como outra no PC (por exemplo, a tecla Windows, que alguns aplicativos não conseguem enviar). Digite pares “tecla de origem,tecla de destino” entre colchetes, em decimal ou em hexadecimal com 0x, sempre em quantidade par.\nExemplo: [0x10,0xA0,0x11,0xA2,0x12,0xA4,0x4A,0x4B]. Em hexadecimal use sempre 2 dígitos (0x4A, 0x05) e não coloque espaço antes das vírgulas. Os três mapeamentos padrão (Shift, Ctrl e Alt para as versões esquerdas) continuam sempre ativos. Os códigos das teclas estão no link abaixo.',
  },
};

// Rótulos de escolhas repetidos, em inglês ou confusos (o valor gravado não muda). Chave -> valor -> rótulo.
const CHOICE_FIXES = {
  qsv_preset: {
    veryfast: 'O mais rápido (menor qualidade)', faster: 'Mais rápido (qualidade menor)', fast: 'Rápido (qualidade baixa)', medium: 'Médio (padrão)',
    slow: 'Lento (boa qualidade)', slower: 'Mais lento (melhor qualidade)', veryslow: 'O mais lento (máxima qualidade)',
  },
  amd_quality: { speed: 'Velocidade', balanced: 'Equilibrado (padrão)', quality: 'Qualidade' },
  origin_web_ui_allowed: { pc: 'Somente este PC', lan: 'Somente a rede local (Wi-Fi ou cabo de casa)', wan: 'Qualquer pessoa, inclusive pela Internet' },
  dd_configuration_option: { disabled: 'Desativado', ensure_primary: 'Ativar a tela automaticamente e torná-la a tela primária (padrão)' },
};
// O padrão que o R3D PLAY grava na instalação (main.js, ensureDefaults) é diferente do padrão do motor que está no schema.
// Mostrado e restaurado é o do R3D PLAY; uma chave ausente do arquivo continua sendo lida como o padrão do motor.
export const PANEL_DEFAULTS = { dd_configuration_option: 'ensure_primary' };
// Sinônimos que o usuário digita na busca e que não aparecem nos textos do schema.
const SEARCH_ALIASES = {
  max_bitrate: 'qualidade bitrate mbps kbps',
  sunshine_name: 'nome pc computador servidor hostname',
  upnp: 'roteador porta fora de casa internet',
  port: 'porta firewall roteador',
  origin_web_ui_allowed: 'seguranca acesso painel rede',
  dd_configuration_option: 'tela virtual monitor display',
  headless_mode: 'monitor virtual sem monitor',
  system_tray: 'bandeja icone relogio',
  min_log_level: 'registro log erros',
  hevc_mode: 'h265 codec',
  av1_mode: 'codec',
  keybindings: 'atalhos teclas remapear',
};

const REAL_KEYS = new Set(['key_repeat_frequency', 'minimum_fps_target']);   // únicos campos que aceitam decimal (ver _serializacao.md 8.2)
export const KEEP_EXPLICIT = new Set(['dd_configuration_option']);            // gravar mesmo igual ao padrão: o main.js repõe "ensure_primary" quando a chave some
const MONO_KEYS = new Set(['file_apps', 'credentials_file', 'log_path', 'pkey', 'cert', 'file_state', 'output_name', 'keybindings', 'external_ip', 'fallback_mode', 'dd_manual_resolution', 'dd_manual_refresh_rate']);
// Campo obrigatório quando visível (o servidor ignora a configuração de tela inteira se faltar).
const REQUIRED_WHEN_VISIBLE = new Set(['dd_manual_resolution', 'dd_manual_refresh_rate']);

/* ---------- Normalização ---------- */
const asList = (p) => (Array.isArray(p) && p.length ? p.map(String) : null);
/** A opção/grupo vale nesta plataforma? Lista vazia ou nula = todas. Puro. */
export function platformOk(list, platform) {
  return !list || list.length === 0 || list.includes(platform);
}

function kindOf(raw) {
  if (raw.ui === 'toggle') return 'bool';
  if (raw.ui === 'select') return 'choice';
  if (raw.ui === 'text') return 'text';
  if (raw.ui === 'number') return (raw.step === 'any' || REAL_KEYS.has(raw.key)) ? 'real' : 'int';
  if (raw.ui === 'custom') return 'json';
  throw new Error(`ui desconhecida em ${raw.key}: ${raw.ui}`);
}

function fixText(raw, field) {
  const t = TEXT_FIXES[raw.key]?.[field] ?? raw[field];
  return brandSafe(t);
}

function normOption(raw, cat, section, order) {
  const byPlatform = (obj) => (obj ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? brandSafe(v) : v])) : null);
  return {
    key: raw.key,
    kind: kindOf(raw),
    ui: raw.ui,
    label: fixText(raw, 'label'),
    help: fixText(raw, 'help') || '',
    default: raw.default,
    panelDefault: PANEL_DEFAULTS[raw.key] ?? null,
    platform: asList(raw.platform),
    advanced: raw.advanced === true,
    serialize: raw.serialize,
    choices: Array.isArray(raw.options) ? raw.options.map((o) => ({ value: String(o.value), label: brandSafe(CHOICE_FIXES[raw.key]?.[String(o.value)] ?? o.label), platform: asList(o.platform) })) : null,
    showIf: raw.showIf || null,
    helpShowIf: raw.helpShowIf || null,
    group: raw.group || null,
    groupUid: raw.group ? `${cat.id}.${section.id}.${raw.group}` : null,
    min: raw.min, max: raw.max, step: raw.step, unit: raw.unit || '',
    placeholder: fixText(raw, 'placeholder') ?? '',
    validate: raw.validate || null,
    widget: raw.widget || null,
    widgetConfig: raw.widgetConfig || null,
    engineDefault: raw.engineDefault,
    learnMore: raw.learn_more || raw.widgetConfig?.learnMore || null,
    labelByPlatform: byPlatform(raw.labelByPlatform),
    helpByPlatform: byPlatform(raw.helpByPlatform),
    placeholderByPlatform: raw.placeholderByPlatform || null,
    extrasByPlatform: raw.extrasByPlatform || null,
    mono: MONO_KEYS.has(raw.key),
    requiredWhenVisible: REQUIRED_WHEN_VISIBLE.has(raw.key),
    cat: cat.id,
    sec: `${cat.id}.${section.id}`,
    secTitle: section.title,
    order,
  };
}

/**
 * Monta o catálogo a partir dos schemas já lidos: raws = { general: {...}, audiovideo: {...}, ... }.
 * Devolve { categories:[{...cat, sections:[{uid,id,title,options,groups,statusWidgets}]}], options:[...todas, em ordem], byKey: Map }.
 */
export function buildCatalog(raws) {
  const categories = [];
  const options = [];
  const byKey = new Map();
  const groupByUid = new Map();
  let order = 0;
  for (const cat of CATEGORIES) {
    const file = raws[cat.file];
    if (!file) throw new Error(`schema ausente: ${cat.file}`);
    const sections = [];
    for (const sec of file.sections || []) {
      const uid = `${cat.id}.${sec.id}`;
      const groups = (sec.groups || []).map((g) => ({
        id: g.id, uid: `${uid}.${g.id}`, kind: g.kind || 'accordion', open: g.open === true,
        title: brandSafe(g.title), titleBy: g.titleBy ? { key: g.titleBy.key, map: Object.fromEntries(Object.entries(g.titleBy.map).map(([k, v]) => [k, brandSafe(v)])) } : null,
        platform: asList(g.platform), showIf: g.showIf || null, notice: g.notice ? { kind: g.notice.kind || 'info', text: brandSafe(g.notice.text) } : null,
      }));
      for (const g of groups) groupByUid.set(g.uid, g);
      const opts = (sec.options || []).map((o) => {
        const opt = normOption(o, cat, sec, order++);
        if (byKey.has(opt.key)) throw new Error(`chave repetida nos schemas: ${opt.key}`);
        byKey.set(opt.key, opt);
        options.push(opt);
        return opt;
      });
      sections.push({ uid, id: sec.id, title: brandSafe(sec.title), cat: cat.id, options: opts, groups, statusWidgets: sec.statusWidgets || [] });
    }
    categories.push({ ...cat, title: file.title, sections });
  }
  return { categories, options, byKey, groupByUid };
}

/** Lê os schemas do navegador (relativo a este arquivo: ui/schema/*.json) e monta o catálogo. */
export async function loadCatalog(fetchFn = fetch) {
  const raws = {};
  await Promise.all(SCHEMA_FILES.map(async (f) => {
    const r = await fetchFn(new URL(`../../schema/${f}.json`, import.meta.url));
    if (!r.ok) throw new Error(`schema ${f}.json: HTTP ${r.status}`);
    raws[f] = await r.json();
  }));
  return buildCatalog(raws);
}

/* ---------- Condições ---------- */
/** Avalia {key, in:[...], notIn, and:[...], or:[...]} sobre get(chave) → texto do valor atual. Sem condição = verdadeiro. */
export function evalCond(cond, get) {
  if (!cond) return true;
  if (cond.key !== undefined) {
    const v = String(get(cond.key) ?? '');
    if (Array.isArray(cond.in) && !cond.in.includes(v)) return false;
    if (Array.isArray(cond.notIn) && cond.notIn.includes(v)) return false;
  }
  if (Array.isArray(cond.and) && !cond.and.every((c) => evalCond(c, get))) return false;
  if (Array.isArray(cond.or) && cond.or.length && !cond.or.some((c) => evalCond(c, get))) return false;
  return true;
}
/** Plataforma certa E dependências (showIf) satisfeitas. */
export function isActive(opt, get, platform) {
  return platformOk(opt.platform, platform) && evalCond(opt.showIf, get);
}
export function groupActive(group, get, platform) {
  return platformOk(group.platform, platform) && evalCond(group.showIf, get);
}
/** A opção aparece na tela agora? (plataforma, showIf próprio E showIf/plataforma do grupo onde ela mora; ignora o filtro Essenciais/Todas). */
export function isShown(opt, catalog, get, platform) {
  if (!isActive(opt, get, platform)) return false;
  const g = opt.groupUid ? catalog.groupByUid?.get(opt.groupUid) : null;
  return !g || groupActive(g, get, platform);
}
export function groupTitle(group, get) {
  if (group.titleBy) {
    const v = String(get(group.titleBy.key) ?? '');
    return Object.hasOwn(group.titleBy.map, v) ? group.titleBy.map[v] : group.title;   // hasOwn: um valor "constructor" no arquivo não pode virar título
  }
  return group.title;
}
/** Chaves das quais a visibilidade da opção depende. */
export function dependsOn(cond, out = new Set()) {
  if (!cond) return out;
  if (cond.key) out.add(cond.key);
  (cond.and || []).forEach((c) => dependsOn(c, out));
  (cond.or || []).forEach((c) => dependsOn(c, out));
  return out;
}

/* ---------- Textos por plataforma ---------- */
export const labelFor = (opt, platform) => opt.labelByPlatform?.[platform] ?? opt.label;
export const helpFor = (opt, platform) => opt.helpByPlatform?.[platform] ?? opt.help;
export const placeholderFor = (opt, platform) => opt.placeholderByPlatform?.[platform] ?? opt.placeholder ?? '';
export const extrasFor = (opt, platform) => opt.extrasByPlatform?.[platform] ?? [];
/** Opções de um select já filtradas pela plataforma. */
export function choicesFor(opt, platform) {
  return (opt.choices || []).filter((c) => platformOk(c.platform, platform));
}
const choiceLabel = (opt, value, platform) => choicesFor(opt, platform).find((c) => c.value === String(value))?.label;

/** Valor que "Restaurar padrão" devolve e que a tela chama de padrão (o do R3D PLAY, quando difere do motor). */
export const restoreValue = (opt) => opt.panelDefault ?? opt.default;

/** Tira o "(padrão)" do rótulo da escolha, já que o texto "Padrão: …" repete a informação. */
export function plainDefault(label) {
  return String(label)
    .replace(/\s*\(padrão\)/gi, '')          // "médio (padrão)" -> "médio"
    .replace(/\s*[,;]\s*padrão\)/gi, ')')    // "P1 (mais rápido, padrão)" -> "P1 (mais rápido)"
    .replace(/\s*\(\s*\)/g, '')
    .trim();
}

/** Texto "Padrão: …" mostrado sob o campo. */
export function defaultLabel(opt, platform) {
  const d = restoreValue(opt);
  switch (opt.kind) {
    case 'bool': return d === 'enabled' ? 'Ativado' : 'Desativado';
    case 'choice': return plainDefault(choiceLabel(opt, d, platform) ?? String(d));
    case 'text': return d === '' || d === undefined ? '' : String(d);
    case 'json': return Array.isArray(d) ? 'lista vazia' : 'nenhum remapeamento';
    default: return `${d}${opt.unit ? ` ${opt.unit}` : ''}`;
  }
}

/** Explica em português quando a opção só vale ("quando X estiver Y"). Vazio se não há condição. */
export function describeCond(cond, catalog, platform) {
  if (!cond) return '';
  const parts = [];
  if (cond.key) {
    const parent = catalog.byKey.get(cond.key);
    const name = parent ? `“${labelFor(parent, platform).replace(/:$/, '')}”` : `“${cond.key}”`;
    const vals = cond.in || [];
    if (parent?.kind === 'bool' && vals.length === 1) {
      parts.push(`${name} estiver ${vals[0] === 'enabled' ? 'ativado' : 'desativado'}`);
    } else if (parent?.kind === 'choice' && vals.length) {
      const all = choicesFor(parent, platform).map((c) => c.value);
      const rest = all.filter((v) => !vals.includes(v));
      const lab = (v) => `“${choiceLabel(parent, v, platform) ?? v}”`;
      if (rest.length && rest.length < vals.length) parts.push(`${name} não estiver em ${rest.map(lab).join(', ')}`);
      else parts.push(`${name} estiver em ${vals.map(lab).join(' ou ')}`);
    } else if (vals.length) {
      parts.push(`${name} for ${vals.join(' ou ')}`);
    }
  }
  for (const c of cond.and || []) {
    const t = describeCond(c, catalog, platform);
    if (t) parts.push(t);
  }
  return parts.join(' e ');
}

/* ---------- Busca ---------- */
/** Minúsculas e sem acentos, para comparar "configuração" com "configuracao". */
export function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function searchHaystack(opt, platform) {
  return {
    label: norm(`${labelFor(opt, platform)}`),
    key: norm(`${opt.key} ${opt.key.replace(/_/g, ' ')}`),
    help: norm(helpFor(opt, platform)),
    other: norm(`${opt.secTitle} ${SEARCH_ALIASES[opt.key] || ''} ${(opt.choices || []).map((c) => c.label).join(' ')}`),
  };
}
/**
 * Procura em rótulo, ajuda e chave (além de sinônimos, título da seção e rótulos das escolhas). Todas as palavras precisam aparecer,
 * casando com o COMEÇO de uma palavra ("porta" acha "portas", mas não "suporta"). Ignora o filtro Essenciais/Todas (inclui avançadas).
 * Opções de outra plataforma ficam de fora. Devolve [{opt, score}] por relevância.
 */
export function searchCatalog(catalog, query, platform) {
  const tokens = norm(query).split(/\s+/).filter((t) => /[a-z0-9]/.test(t));   // só pontuação não é busca
  if (!tokens.length) return [];
  const starts = (hay, t) => hay.startsWith(t) || hay.includes(` ${t}`) || new RegExp(`[^a-z0-9]${escapeRe(t)}`).test(hay);
  const out = [];
  for (const opt of catalog.options) {
    if (!platformOk(opt.platform, platform)) continue;
    const h = searchHaystack(opt, platform);
    let score = 0;
    let all = true;
    for (const t of tokens) {
      let s = 0;
      if (starts(h.label, t)) s = 10 + (h.label.startsWith(t) ? 2 : 0);
      else if (starts(h.key, t)) s = 6;
      else if (starts(h.help, t)) s = 3;
      else if (starts(h.other, t)) s = 1;
      if (!s) { all = false; break; }
      score += s;
    }
    if (all) out.push({ opt, score });
  }
  return out.sort((a, b) => b.score - a.score || a.opt.order - b.opt.order);
}

/* ---------- Regras de listas ---------- */
/**
 * Lê "trim(do) != '' || trim(undo) != ''" (widgetConfig.keepItemWhen) sem usar eval.
 * Devolve { mode: 'any'|'all', fields: [...] } ou null se a expressão não for do formato esperado.
 */
export function parseKeepRule(expr) {
  if (typeof expr !== 'string') return null;
  const parts = expr.split(/\s*(\|\||&&)\s*/);
  const fields = [];
  const ops = new Set();
  for (let i = 0; i < parts.length; i++) {
    if (i % 2) { ops.add(parts[i]); continue; }
    const m = /^trim\((\w+)\)\s*!=\s*''$/.exec(parts[i].trim());
    if (!m) return null;
    fields.push(m[1]);
  }
  if (ops.size > 1 || !fields.length) return null;
  return { mode: ops.has('&&') ? 'all' : 'any', fields };
}

export const REMAP_LISTS = ['mixed', 'resolution_only', 'refresh_rate_only'];
/**
 * Qual das 3 listas de dd_mode_remapping está ativa (null = não se aplica, o editor fica escondido).
 * get(chave) → texto do valor atual. Mesma regra do painel original (getRemappingType/canBeRemapped).
 */
export function activeRemapList(get) {
  const cfg = String(get('dd_configuration_option') || 'disabled');   // vazio/ausente = padrão
  const res = String(get('dd_resolution_option') || 'auto');
  const fps = String(get('dd_refresh_rate_option') || 'auto');
  if (cfg === 'disabled' || (res !== 'auto' && fps !== 'auto')) return null;
  if (res !== 'auto') return 'refresh_rate_only';
  if (fps !== 'auto') return 'resolution_only';
  return 'mixed';
}

/* ---------- Driver de tela virtual (vdisplayStatus) ---------- */
// Textos e níveis de system.json (info, chave vdisplayStatus): 0 = pronto; qualquer outro valor = aviso.
const VDISPLAY = {
  0: { text: 'Pronto', level: 'ok' },
  1: { text: 'Desconhecido', level: 'warn' },
  '-1': { text: 'Não inicializado', level: 'warn' },
  '-2': { text: 'Versão incompatível', level: 'warn' },
  '-3': { text: 'Falha no watchdog', level: 'warn' },
};
export const VDISPLAY_WARNING = 'Verifique se o driver de tela virtual (SudoVDA) está instalado na versão mais recente e ativado corretamente.';
/** Interpreta o vdisplayStatus de GET /api/config. Devolve null quando não existe (outros sistemas). */
export function vdisplayInfo(code) {
  if (code === undefined || code === null || code === '') return null;
  const n = Number(code);
  if (!Number.isInteger(n)) return null;
  const known = VDISPLAY[n];
  if (known) return { code: n, ...known, hint: known.level === 'ok' ? '' : VDISPLAY_WARNING };
  return { code: n, text: `Código ${n}`, level: 'warn', hint: VDISPLAY_WARNING };
}

/* ---------- Avisos que dependem do valor atual ---------- */
// Mudanças que podem trancar a pessoa fora ou apagar pareamentos. Aparecem sob o campo assim que ele é editado e voltam num
// diálogo ao Salvar. O painel nativo (Program.cs) fala SEMPRE com https://localhost:47990 (= porta padrão 47989 + 1).
export const PANEL_PORT = '47989';
const RISKS = {
  port: {
    when: (v) => v !== PANEL_PORT,
    text: (v) => `Este painel só consegue falar com o R3D PLAY na porta padrão (${PANEL_PORT}). Com a porta ${v}, depois de reiniciar o painel perde a conexão e não dá mais para mudar nada por aqui; o celular também passa a precisar da nova porta. Para desfazer será preciso editar o arquivo sunshine.conf à mão.`,
  },
  file_state: {
    when: () => true,
    text: () => 'Mudar este arquivo faz o R3D PLAY começar com um arquivo novo e vazio: os celulares já pareados e o login deste painel podem se perder.',
  },
  credentials_file: {
    when: () => true,
    text: () => 'Mudar este arquivo faz o R3D PLAY começar sem usuário e senha: depois de reiniciar, este painel vai pedir para criar o acesso de novo.',
  },
  pkey: {
    when: () => true,
    text: () => 'Trocar a chave privada muda a identidade do R3D PLAY: os celulares já pareados deixam de funcionar e precisam ser pareados de novo.',
  },
  cert: {
    when: () => true,
    text: () => 'Trocar o certificado muda a identidade do R3D PLAY: os celulares já pareados deixam de funcionar e precisam ser pareados de novo.',
  },
};
/** Riscos de gravar estas chaves. valueOf(chave) -> texto que vai para o arquivo (ou vazio/undefined se a chave sai dele). Devolve [{key, text}]. */
export function riskNotes(keys, valueOf) {
  const out = [];
  for (const key of keys) {
    const r = RISKS[key];
    if (!r) continue;
    const raw = valueOf(key);
    const v = raw === undefined || raw === null || String(raw).trim() === '' ? (key === 'port' ? PANEL_PORT : '') : String(raw).trim();
    if (r.when(v)) out.push({ key, text: r.text(v) });
  }
  return out;
}
/**
 * Avisos ao vivo de algumas opções (porta fora da faixa, acesso pela Internet, arquivos de identidade…). get(chave) → texto do valor atual.
 * dirty = a opção foi editada e ainda não salva (os riscos só aparecem depois de mexer). Devolve [{kind:'warn'|'bad'|'info', text}].
 */
export function liveNotes(key, get, { dirty = false } = {}) {
  const out = [];
  if (key === 'port') {
    const p = Number(get('port'));
    if (Number.isFinite(p) && p > 0) {
      if (p - 5 < 1024) out.push({ kind: 'bad', text: 'O R3D PLAY não consegue usar portas abaixo de 1024.' });
      if (p + 21 > 65535) out.push({ kind: 'bad', text: 'Portas acima de 65535 não existem.' });
    }
  }
  if (dirty && RISKS[key]) {
    const raw = String(get(key) ?? '').trim();
    const v = raw === '' && key === 'port' ? PANEL_PORT : raw;
    if (RISKS[key].when(v)) out.push({ kind: 'bad', text: RISKS[key].text(v) });
  }
  if (key === 'origin_web_ui_allowed' && get('origin_web_ui_allowed') === 'wan') {
    out.push({ kind: 'warn', text: 'Deixar este painel acessível pela Internet é um risco de segurança. Faça isso só se souber o que está fazendo.' });
    if (get('upnp') === 'enabled') out.push({ kind: 'bad', text: 'Com o UPnP ligado, o roteador também abrirá a porta deste painel para a Internet.' });
  }
  return out;
}
/** Portas usadas a partir da porta base (para a tabelinha da opção "Porta"). */
export function portTable(base) {
  const p = Number(base);
  if (!Number.isInteger(p)) return [];
  return [
    { proto: 'TCP', port: String(p - 5), note: 'Conexão segura (HTTPS)' },
    { proto: 'TCP', port: String(p), note: 'Conexão do celular' },
    { proto: 'TCP', port: String(p + 1), note: 'Este painel (interface web)' },
    { proto: 'TCP', port: String(p + 21), note: 'Controle da transmissão (RTSP)' },
    { proto: 'UDP', port: `${p + 9} a ${p + 11}`, note: 'Vídeo, controle e áudio' },
  ];
}
