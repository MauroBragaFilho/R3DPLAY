// Conversão, validação e gravação das configurações (regras de ui/schema/_serializacao.md). PURO: sem DOM, testado em dev/tests.
//
// Vocabulário:
//  - "raw"   = o texto que está no sunshine.conf (GET /api/config devolve tudo como texto; listas como JSON em texto);
//  - "draft" = o valor editável na tela: toggle = boolean, select/texto/número = string digitada, lista = array/objeto;
//  - "toFile" devolve o que vai no POST: sempre TEXTO (inteiros puros), exceto as listas, que vão como array/objeto JSON de verdade.
'use strict';
import {
  platformOk, isShown, dependsOn, parseKeepRule, activeRemapList, REMAP_LISTS, KEEP_EXPLICIT, choicesFor,
} from './schema.js';

/** Chaves de metadados do GET que NUNCA voltam no POST (iguais a META_KEYS de config.js; um teste confere). */
export const NEVER_SEND = ['status', 'platform', 'version', 'vdisplayStatus'];

/* ---------- Utilidades ---------- */
export const deepCopy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/** Ordena as chaves de objetos em todos os níveis (o servidor grava em ordem alfabética; config.js compara com JSON.stringify). */
export function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep(v[k])]));
  return v;
}
const str = (v) => (v === undefined || v === null ? '' : String(v));
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
// O servidor corta o valor no "#" (config.cpp: parse_option) e o GET devolve o valor cortado: gravar daria um valor diferente do digitado.
const HASH_ERROR = 'O caractere # não pode ser usado: o R3D PLAY ignora tudo o que vem depois dele.';
/** Valor de "[...]" escrito à mão em várias linhas (o servidor aceita) vira uma linha só; sem isso o writeConfig recusa a gravação inteira. */
export const flattenBracketLines = (text) => (/^\s*\[/.test(text) && /[\r\n]/.test(text) ? text.replace(/\s*[\r\n]+\s*/g, '') : text);

/* ---------- Booleanos ---------- */
/** Pares de vocabulário que o painel original preserva (Checkbox.vue); o primeiro item é o "ligado". */
export const BOOL_PAIRS = [['true', 'false'], ['1', '0'], ['enabled', 'disabled'], ['enable', 'disable'], ['yes', 'no'], ['on', 'off']];
/** Como o servidor lê (bool_f): verdadeiro se for true/yes/enable/enabled/on OU contiver o caractere 1; diferencia maiúsculas. Vazio = indefinido. */
export function parseBool(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const s = String(raw);
  return ['true', 'yes', 'enable', 'enabled', 'on'].includes(s) || s.includes('1');
}
/** Vocabulário do valor que já está no arquivo (sem diferenciar maiúsculas); fora da lista usa enabled/disabled. */
export function boolVocab(raw) {
  const s = str(raw).toLowerCase();
  return BOOL_PAIRS.find((p) => p.includes(s)) || ['enabled', 'disabled'];
}
export function formatBool(on, existingRaw) {
  const pair = boolVocab(existingRaw);
  return on ? pair[0] : pair[1];
}

/* ---------- Números ---------- */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
/**
 * Lê o que a pessoa digitou. Inteiro: só dígitos (sinal "-" opcional), sem decimais. Real: aceita vírgula ou ponto.
 * Devolve { empty:true } | { error } | { value: 'texto canônico', number }. Não confere faixa (ver checkRange).
 */
export function parseNumberText(text, real = false) {
  const t = str(text).trim();
  if (t === '') return { empty: true, value: '' };
  if (real) {
    const c = t.replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(c)) return { error: 'Digite um número (por exemplo 24.9 ou 24,9).' };
    const value = c.replace(/^(-?)0+(?=\d)/, '$1').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    const number = Number(value);
    if (!Number.isFinite(number)) return { error: 'Número grande demais.' };
    return { value: number === 0 ? '0' : value, number };
  }
  if (!/^-?\d+$/.test(t)) return { error: 'Digite apenas números inteiros, sem vírgula nem ponto.' };
  const number = Number(t);
  if (!Number.isSafeInteger(number) || number < INT32_MIN || number > INT32_MAX) return { error: 'Número grande demais.' };
  return { value: String(number), number };
}
/** Confere min/max do schema. Devolve a mensagem ou ''. */
export function checkRange(opt, number) {
  if (typeof opt.min === 'number' && number < opt.min) return `O valor mínimo é ${opt.min}${opt.unit ? ` ${opt.unit}` : ''}.`;
  if (typeof opt.max === 'number' && number > opt.max) return `O valor máximo é ${opt.max}${opt.unit ? ` ${opt.unit}` : ''}.`;
  return '';
}

/* ---------- Texto ---------- */
const FORMAT_HINTS = {
  dd_manual_resolution: 'Use o formato LARGURAxALTURA, por exemplo 2560x1440.',
  dd_manual_refresh_rate: 'Digite um número com ponto decimal, por exemplo 59.9558.',
};
/** Ajustes que não mudam o sentido: espaços nas pontas e vírgula decimal na taxa de atualização. */
export function normalizeText(opt, text) {
  let t = str(text).trim();
  if (opt.key === 'dd_manual_refresh_rate') t = t.replace(/^(\d+),(\d+)$/, '$1.$2');
  return t;
}
/** Confere um texto livre. Devolve { value, error? }. */
export function validateText(opt, text) {
  const raw = str(text);
  if (/[\r\n]/.test(raw)) return { value: raw, error: 'O texto não pode ter quebra de linha.' };
  if (CONTROL_RE.test(raw.replace(/\t/g, ' '))) return { value: raw, error: 'O texto tem caracteres inválidos.' };
  const value = normalizeText(opt, raw);
  if (value === '') return { value };
  if (value.startsWith('[') && opt.key !== 'keybindings') return { value, error: 'O texto não pode começar com o caractere [.' };
  const v = opt.validate;
  if (v?.pattern) {
    const strict = v.savePattern ? new RegExp(v.savePattern) : new RegExp(v.pattern);
    if (!strict.test(value)) {
      if (v.savePattern && new RegExp(v.pattern).test(value)) return { value, error: 'O FPS precisa ser um número inteiro (por exemplo 1920x1080x60).' };
      return { value, error: v.message || FORMAT_HINTS[opt.key] || 'Formato inválido.' };
    }
  }
  if (value.includes('#')) return { value, error: HASH_ERROR };
  return { value };
}

/* ---------- Listas de comandos (global_prep_cmd, global_state_cmd, server_cmd) ---------- */
/** Colunas da lista nesta plataforma (a coluna "elevated" só existe no Windows). */
export function listColumns(opt, platform) {
  return (opt.widgetConfig?.columns || []).filter((c) => platformOk(c.platform, platform));
}
const textFields = (opt, platform) => listColumns(opt, platform).filter((c) => c.input === 'text').map((c) => c.field);
/** Item novo e vazio, na forma certa para a plataforma. */
export function newListItem(opt, platform) {
  const wc = opt.widgetConfig || {};
  return deepCopy(wc.newItemByPlatform?.[platform] ?? wc.newItem ?? {});
}
function keepRule(opt) {
  return parseKeepRule(opt.widgetConfig?.keepItemWhen) || { mode: 'any', fields: textFields(opt, 'windows') };
}
const filled = (item, f) => str(item?.[f]).trim() !== '';
function keepItem(item, rule) {
  return rule.mode === 'all' ? rule.fields.every((f) => filled(item, f)) : rule.fields.some((f) => filled(item, f));
}
function cleanRow(it, fields, platform) {
  const out = { ...it };
  for (const f of fields) out[f] = str(out[f]).trim();
  if (platform === 'windows') out.elevated = !!out.elevated;
  return sortKeysDeep(out);
}
/** Lista como será gravada: sem itens vazios, textos aparados, "elevated" booleano no Windows, chaves em ordem alfabética. */
export function finalizeList(opt, items, platform) {
  const rule = keepRule(opt);
  const fields = textFields(opt, platform);
  return (Array.isArray(items) ? items : []).filter((it) => keepItem(it, rule)).map((it) => cleanRow(it, fields, platform));
}
/**
 * Como finalizeList, mas guarda também as linhas preenchidas só pela metade (ex.: server_cmd com nome e sem comando). É o que decide se a lista
 * foi editada: uma linha pela metade precisa contar como alteração para ser validada (e bloquear o Salvar), e não sumir em silêncio.
 */
export function partialRows(opt, items, platform) {
  const fields = textFields(opt, platform);
  return (Array.isArray(items) ? items : []).filter((it) => fields.some((f) => filled(it, f))).map((it) => cleanRow(it, fields, platform));
}
/**
 * O servidor lê "[...]" contando colchetes sem respeitar aspas: um "]" solto dentro de um comando encerra o valor antes da hora
 * e deixa o JSON inválido (o servidor pode nem iniciar). Esta função repete a contagem dele.
 */
export function bracketsBalanced(text) {
  if (!String(text).startsWith('[')) return true;
  let depth = 0;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') {
      depth--;
      if (depth < 0 || (depth === 0 && i !== s.length - 1)) return false;
    }
  }
  return depth === 0;
}
/** Confere a lista. Devolve { error?, rows:[{i, field, message}] } (i = linha na lista editada, começando em 0). */
export function validateList(opt, items, platform) {
  const rows = [];
  const rule = keepRule(opt);
  const fields = textFields(opt, platform);
  (Array.isArray(items) ? items : []).forEach((it, i) => {
    const any = rule.fields.some((f) => filled(it, f));
    for (const f of fields) {
      const v = str(it?.[f]);
      if (/[\r\n]/.test(v)) rows.push({ i, field: f, message: 'Não pode ter quebra de linha.' });
      else if (CONTROL_RE.test(v.replace(/\t/g, ' '))) rows.push({ i, field: f, message: 'Tem caracteres inválidos.' });
      else if (v.includes('#')) rows.push({ i, field: f, message: 'Não use o caractere #: o R3D PLAY ignora o que vem depois dele e a lista pode ficar quebrada.' });
    }
    if (any && rule.mode === 'all') {
      for (const f of rule.fields) if (!filled(it, f)) rows.push({ i, field: f, message: 'Preencha este campo ou remova a linha.' });
    }
  });
  const out = { rows };
  if (!rows.length && !bracketsBalanced(JSON.stringify(finalizeList(opt, items, platform)))) {
    out.error = 'Os comandos têm colchetes [ ] sem par. Use sempre os dois ou nenhum.';
  }
  if (rows.length) out.error = 'Corrija as linhas marcadas.';
  return out;
}

/* ---------- Remapeamento de modos de tela (dd_mode_remapping) ---------- */
const REMAP_FIELDS = {
  mixed: ['requested_resolution', 'requested_fps', 'final_resolution', 'final_refresh_rate'],
  resolution_only: ['requested_resolution', 'final_resolution'],
  refresh_rate_only: ['requested_fps', 'final_refresh_rate'],
};
export const remapFields = (list) => REMAP_FIELDS[list] || [];
const REMAP_PATTERNS = {
  requested_resolution: /^\d+x\d+$/, final_resolution: /^\d+x\d+$/, requested_fps: /^\d+$/, final_refresh_rate: /^\d+(\.\d+)?$/,
};
const REMAP_MESSAGES = {
  requested_resolution: 'Use o formato LARGURAxALTURA, por exemplo 1920x1080.',
  final_resolution: 'Use o formato LARGURAxALTURA, por exemplo 2560x1440.',
  requested_fps: 'Digite só números inteiros, por exemplo 60.',
  final_refresh_rate: 'Digite um número, com ponto decimal se precisar (por exemplo 119.95).',
};
/** Garante o objeto com as 3 listas (o servidor lança erro se faltar alguma). Mantém o resto como veio. */
export function ensureRemap(v) {
  const out = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {};
  for (const l of REMAP_LISTS) out[l] = Array.isArray(out[l]) ? out[l] : [];
  return out;
}
const cleanRemapItem = (it) => Object.fromEntries(Object.entries(it || {}).map(([k, v]) => [k, k === 'final_refresh_rate' ? str(v).trim().replace(/^(\d+),(\d+)$/, '$1.$2') : str(v).trim()]));
const emptyRemapItem = (it) => Object.values(it || {}).every((v) => str(v).trim() === '');
/** Objeto como será gravado: 3 listas sempre; na lista ativa os textos são aparados e as linhas vazias saem. As outras ficam intactas. */
export function finalizeRemap(value, get) {
  const out = ensureRemap(deepCopy(value));
  const active = activeRemapList(get);
  if (active) out[active] = out[active].map(cleanRemapItem).filter((it) => !emptyRemapItem(it));
  return sortKeysDeep(out);
}
export function validateRemap(value, get) {
  const active = activeRemapList(get);
  const rows = [];
  if (!active) return { rows };
  const list = ensureRemap(value)[active];
  list.forEach((raw, i) => {
    const it = cleanRemapItem(raw);
    if (emptyRemapItem(it)) return;
    for (const f of REMAP_FIELDS[active]) {
      const v = str(raw?.[f]);
      if (/[\r\n]/.test(v) || CONTROL_RE.test(v.replace(/\t/g, ' '))) rows.push({ i, field: f, message: 'Tem caracteres inválidos.' });
      else if (v.includes('#')) rows.push({ i, field: f, message: 'Não use o caractere #.' });
      else if (it[f] && !REMAP_PATTERNS[f].test(it[f])) rows.push({ i, field: f, message: REMAP_MESSAGES[f] });
    }
    const finals = REMAP_FIELDS[active].filter((f) => f.startsWith('final_'));
    if (!finals.some((f) => it[f])) {
      for (const f of finals) rows.push({ i, field: f, message: active === 'mixed' ? 'Preencha pelo menos um valor final.' : 'O valor final é obrigatório.' });
    }
  });
  return rows.length ? { rows, error: 'Corrija as linhas marcadas.' } : { rows };
}

/* ---------- Valores: padrão, leitura do arquivo, comparação ---------- */
// O servidor também aceita estes apelidos; a tela mostra o valor "oficial" da lista.
const CHOICE_ALIASES = {
  min_log_level: { verbose: '0', debug: '1', info: '2', warning: '3', error: '4', fatal: '5', none: '6' },
  qsv_coder: { ac: 'cabac', vlc: 'cavlc' },
  amd_coder: { ac: 'cabac', vlc: 'cavlc' },
  qsv_preset: { slowest: 'veryslow' },
};
/** Valor padrão como draft. */
export function defaultDraft(opt) {
  switch (opt.kind) {
    case 'bool': return opt.default === 'enabled';
    case 'json': return opt.widget === 'display_mode_remapping' ? ensureRemap(deepCopy(opt.default)) : deepCopy(opt.default) ?? [];
    default: return str(opt.default);
  }
}
/**
 * Lê o texto do arquivo e devolve { value: draft, absent, error? }.
 * Lista com JSON ilegível: error preenchido e value = padrão; a tela mostra o aviso e NÃO deixa sobrescrever sem ordem do usuário.
 */
export function parseFile(opt, raw, ctx = {}) {
  if (raw === undefined || raw === null) return { value: defaultDraft(opt), absent: true };
  switch (opt.kind) {
    case 'bool': {
      const b = parseBool(raw);
      return b === undefined ? { value: defaultDraft(opt), absent: true } : { value: b };
    }
    case 'choice': {
      const s = str(raw);
      const aliases = CHOICE_ALIASES[opt.key];
      return { value: aliases && Object.hasOwn(aliases, s) ? aliases[s] : s };   // hasOwn: "constructor"/"toString" no arquivo não podem virar função
    }
    case 'json': {
      let v = raw;
      if (typeof raw === 'string') {
        try { v = JSON.parse(raw); } catch { return { value: defaultDraft(opt), error: 'O valor gravado no arquivo não é um JSON válido.' }; }
      }
      if (opt.widget === 'display_mode_remapping') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return { value: defaultDraft(opt), error: 'O valor gravado no arquivo não tem o formato esperado.' };
        return { value: ensureRemap(deepCopy(v)) };
      }
      if (!Array.isArray(v) || v.some((it) => !it || typeof it !== 'object' || Array.isArray(it))) return { value: defaultDraft(opt), error: 'O valor gravado no arquivo não tem o formato esperado.' };
      const list = deepCopy(v);
      if (ctx.platform === 'windows') list.forEach((it) => { it.elevated = !!it.elevated; });   // igual ao painel original: força booleano ao carregar
      return { value: list };
    }
    case 'text': return { value: flattenBracketLines(str(raw)) };
    default: return { value: str(raw) };
  }
}
/** Texto canônico do draft, para comparar (dirty, igual ao padrão). Valor inválido vira "!texto" (diferente de qualquer válido). */
export function canon(opt, draft, ctx = {}) {
  switch (opt.kind) {
    case 'bool': return draft ? '1' : '0';
    case 'choice': return str(draft);
    case 'text': return normalizeText(opt, draft);
    case 'int': case 'real': {
      const r = parseNumberText(draft, opt.kind === 'real');
      if (r.empty) return parseNumberText(opt.default, opt.kind === 'real').value;   // em branco = usar o padrão
      return r.error ? `!${str(draft).trim()}` : r.value;
    }
    default:
      if (opt.widget === 'display_mode_remapping') return JSON.stringify(finalizeRemap(draft, ctx.get || (() => '')));
      return JSON.stringify(partialRows(opt, draft, ctx.platform));
  }
}
export function sameValue(opt, a, b, ctx = {}) {
  if (opt.kind === 'int' || opt.kind === 'real') {
    const x = parseNumberText(a, opt.kind === 'real');
    const y = parseNumberText(b, opt.kind === 'real');
    if (!x.error && !y.error && !x.empty && !y.empty) return x.number === y.number;
  }
  return canon(opt, a, ctx) === canon(opt, b, ctx);
}
/** Valor que "Restaurar padrão" coloca na tela: o padrão do R3D PLAY quando difere do padrão do motor (PANEL_DEFAULTS), senão o do schema. */
export function restoreDraft(opt) {
  if (opt.panelDefault != null && opt.kind === 'choice') return str(opt.panelDefault);
  return defaultDraft(opt);
}
/** O valor é o padrão? (campos de número vazios contam como "usar o padrão") */
export function isDefaultDraft(opt, draft, ctx = {}) {
  if ((opt.kind === 'int' || opt.kind === 'real' || opt.kind === 'text') && str(draft).trim() === '') {
    return opt.kind === 'text' ? str(opt.default) === '' : true;
  }
  return sameValue(opt, draft, restoreDraft(opt), ctx);
}

/* ---------- Validação e gravação de uma opção ---------- */
/** Confere o draft de uma opção. Devolve { error?, rows? }. */
export function validateValue(opt, draft, ctx = {}) {
  const platform = ctx.platform || 'windows';
  switch (opt.kind) {
    case 'bool': return {};
    case 'choice': {
      const ok = choicesFor(opt, platform).some((c) => c.value === str(draft));
      return ok ? {} : { error: 'Escolha uma das opções da lista.' };
    }
    case 'text': {
      const r = validateText(opt, draft);
      return r.error ? { error: r.error } : {};
    }
    case 'int': case 'real': {
      const r = parseNumberText(draft, opt.kind === 'real');
      if (r.empty) return {};
      if (r.error) return { error: r.error };
      const range = checkRange(opt, r.number);
      return range ? { error: range } : {};
    }
    default: {
      const r = opt.widget === 'display_mode_remapping' ? validateRemap(draft, ctx.get || (() => '')) : validateList(opt, draft, platform);
      return r;
    }
  }
}
/**
 * O que gravar para esta opção: { remove:true } (chave sai do arquivo e vale o padrão) ou { value } (texto, ou array/objeto nas listas).
 * Iguais ao padrão saem do arquivo (como o painel original), exceto KEEP_EXPLICIT. Assume que validateValue já passou.
 */
export function toFile(opt, draft, ctx = {}) {
  const platform = ctx.platform || 'windows';
  const keep = KEEP_EXPLICIT.has(opt.key);
  switch (opt.kind) {
    case 'bool': {
      if (!keep && !!draft === (opt.default === 'enabled')) return { remove: true };
      return { value: formatBool(!!draft, ctx.existingRaw) };
    }
    case 'choice': {
      const s = str(draft);
      if (s === '' || (!keep && s === str(opt.default))) return { remove: true };
      return { value: s };
    }
    case 'text': {
      const s = normalizeText(opt, draft);
      if (s === '' || (!keep && s === str(opt.default))) return { remove: true };
      return { value: s };
    }
    case 'int': case 'real': {
      const r = parseNumberText(draft, opt.kind === 'real');
      if (r.empty || r.error) return { remove: true };
      if (!keep && r.number === Number(opt.default)) return { remove: true };
      return { value: r.value };
    }
    default: {
      const fin = opt.widget === 'display_mode_remapping' ? finalizeRemap(draft, ctx.get || (() => '')) : finalizeList(opt, draft, platform);
      const def = opt.widget === 'display_mode_remapping' ? finalizeRemap(defaultDraft(opt), ctx.get || (() => '')) : [];
      if (JSON.stringify(fin) === JSON.stringify(def)) return { remove: true };
      return { value: fin };
    }
  }
}

/* ---------- Modelo: valores do arquivo, edições e chaves sujas ---------- */
/**
 * Estado da tela, sem DOM. values = o que está no arquivo; draft = edições; dirty = chaves que diferem do arquivo.
 * get(chave) é o objeto ÚNICO de configuração (arquivo + edições + padrões) usado pelas condições showIf, inclusive entre categorias.
 */
export function createModel(catalog, { platform = 'windows' } = {}) {
  const m = {
    catalog,
    platform,
    values: {},            // texto do arquivo, como veio do GET (sem as chaves de metadados)
    draft: {},             // chave -> valor editável
    base: {},              // chave -> valor lido do arquivo (para saber se mudou)
    parseErrors: {},       // chave -> mensagem (lista ilegível no arquivo)
    dirty: new Set(),
  };
  const ctxFor = (key) => ({ platform: m.platform, get: m.get, existingRaw: m.values[key] });

  /** Valor atual como texto, para as condições. Booleano = "enabled"/"disabled". */
  m.get = (key) => {
    const opt = catalog.byKey.get(key);
    if (!opt) return str(m.values[key]);
    if (!(key in m.draft)) return '';
    const d = m.draft[key];
    switch (opt.kind) {
      case 'bool': return d ? 'enabled' : 'disabled';
      case 'json': return '';
      case 'int': case 'real': { const t = str(d).trim(); return t === '' ? str(opt.default) : t; }
      default: return str(d);
    }
  };
  const recompute = (key) => {
    const opt = catalog.byKey.get(key);
    if (!opt || m.parseErrors[key]) { m.dirty.delete(key); return; }
    const ctx = ctxFor(key);
    if (canon(opt, m.draft[key], ctx) !== canon(opt, m.base[key], ctx)) m.dirty.add(key); else m.dirty.delete(key);
  };

  m.setPlatform = (p) => { m.platform = p || 'windows'; };
  /** Carrega o texto do arquivo e descarta as edições. */
  m.load = (values) => {
    m.values = { ...(values || {}) };
    for (const k of NEVER_SEND) delete m.values[k];
    m.draft = {}; m.base = {}; m.parseErrors = {}; m.dirty.clear();
    for (const opt of catalog.options) {
      const r = parseFile(opt, m.values[opt.key], { platform: m.platform });
      m.draft[opt.key] = deepCopy(r.value);
      m.base[opt.key] = deepCopy(r.value);
      if (r.error) m.parseErrors[opt.key] = r.error;
    }
  };
  m.set = (key, value) => {
    if (m.parseErrors[key]) return;
    m.draft[key] = value;
    recompute(key);
    for (const o of catalog.options) if (o.kind === 'json' && o.key !== key) recompute(o.key);   // a lista ativa do remapeamento depende de outras chaves
  };
  m.reset = (key) => m.set(key, restoreDraft(catalog.byKey.get(key)));
  /** A opção aparece na tela agora (plataforma, showIf dela e do grupo)? Edições em opções que não aparecem não bloqueiam o Salvar. */
  m.shown = (opt) => isShown(opt, catalog, m.get, m.platform);
  /** O usuário aceitou jogar fora um valor ilegível: passa a valer o padrão e a chave fica "suja" (será removida). */
  m.overrideBroken = (key) => {
    const opt = catalog.byKey.get(key);
    delete m.parseErrors[key];
    m.draft[key] = defaultDraft(opt);
    m.dirty.add(key);
  };
  m.discard = () => { m.load(m.values); };
  m.isDirty = (key) => m.dirty.has(key);
  m.isDefault = (key) => isDefaultDraft(catalog.byKey.get(key), m.draft[key], ctxFor(key));
  m.check = (key) => validateValue(catalog.byKey.get(key), m.draft[key], ctxFor(key));
  /** Chaves sujas na ordem do catálogo. */
  m.dirtyKeys = () => catalog.options.filter((o) => m.dirty.has(o.key)).map((o) => o.key);

  /**
   * Monta o corpo do POST: parte do arquivo ATUAL (fresh = GET feito agora) e troca só as chaves sujas.
   * Chaves que a tela não conhece (flags, share_library…) e as não editadas passam intactas; metadados nunca vão.
   * Devolve { ok, body, errors:{chave: mensagem}, rowErrors:{chave: rows}, changes:[{key, action}], skipped:[chave] }.
   * skipped = edições inválidas em opções que a tela não mostra agora (showIf/plataforma): não bloqueiam o Salvar e o valor do arquivo é mantido.
   */
  m.buildSave = (fresh) => {
    const body = {};
    for (const [k, v] of Object.entries(fresh || {})) if (!NEVER_SEND.includes(k)) body[k] = v;
    const errors = {}; const rowErrors = {}; const changes = []; const skipped = [];
    const dirty = new Set(m.dirtyKeys());
    for (const opt of catalog.options) {
      const key = opt.key;
      const ctx = { platform: m.platform, get: m.get, existingRaw: fresh?.[key] ?? m.values[key] };
      const shown = m.shown(opt);
      if (opt.requiredWhenVisible && shown) {
        const touched = dirty.has(key) || [...dependsOn(opt.showIf)].some((k) => dirty.has(k));
        if (touched && str(m.draft[key]).trim() === '') { errors[key] = 'Preencha este campo ou escolha outra opção acima.'; continue; }
      }
      if (!dirty.has(key)) continue;
      const res = validateValue(opt, m.draft[key], ctx);
      if (res.error) {
        // Campo escondido (a pessoa desligou o interruptor que o controla): ninguém consegue corrigir o erro, então não trava o Salvar.
        if (!shown) { skipped.push(key); continue; }
        errors[key] = res.error;
        if (res.rows?.length) rowErrors[key] = res.rows;
        continue;
      }
      const out = toFile(opt, m.draft[key], ctx);
      if (out.remove) { delete body[key]; changes.push({ key, action: 'remove' }); } else { body[key] = out.value; changes.push({ key, action: 'set' }); }
    }
    // Valor "[...]" escrito à mão em várias linhas (listas e keybindings): o GET devolve o texto com quebras e writeConfig recusaria TUDO.
    // Listas legíveis vão como JSON de verdade; o resto (inclusive lista ilegível, preservada) vai em uma linha só, com o mesmo conteúdo.
    for (const [k, v] of Object.entries(body)) {
      if (typeof v !== 'string' || !/[\r\n]/.test(v) || !/^\s*\[/.test(v)) continue;
      let out = null;
      if (catalog.byKey.get(k)?.kind === 'json') { try { out = sortKeysDeep(JSON.parse(v)); } catch { /* ilegível: vai achatado */ } }
      body[k] = out ?? flattenBracketLines(v);
    }
    return { ok: Object.keys(errors).length === 0, body, errors, rowErrors, changes, skipped };
  };
  return m;
}
