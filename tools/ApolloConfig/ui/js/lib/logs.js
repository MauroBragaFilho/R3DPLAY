// Registro do R3D PLAY: lógica PURA (sem DOM, sem rede) para ler, filtrar e resumir o texto de GET /api/logs.
// Formato (ui/schema/system.json > logs.formato): "[AAAA-MM-DD HH:MM:SS.mmm]: Nível: mensagem". Linhas que não casam com esse
// cabeçalho são CONTINUAÇÃO do registro anterior (mensagens de várias linhas, como os JSON de dispositivos de vídeo).
// O arquivo inteiro vem a cada chamada, então tudo aqui é de uma passada só e não copia o texto sem necessidade.
'use strict';

/** Níveis do servidor, do mais fraco ao mais grave. `label` é o texto mostrado ao usuário; `css` vira classe `lv-<css>`. */
export const LEVELS = Object.freeze([
  { value: 'Verbose', rank: 0, label: 'Detalhe', css: 'verbose' },
  { value: 'Debug', rank: 1, label: 'Depuração', css: 'debug' },
  { value: 'Info', rank: 2, label: 'Info', css: 'info' },
  { value: 'Warning', rank: 3, label: 'Aviso', css: 'warning' },
  { value: 'Error', rank: 4, label: 'Erro', css: 'error' },
  { value: 'Fatal', rank: 5, label: 'Erro grave', css: 'fatal' },
]);
const RANK = Object.freeze(Object.fromEntries(LEVELS.map((l) => [l.value, l.rank])));

/** Mesma expressão do schema (system.json > logs.formato.regex_registro). */
export const HEADER_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]: (Verbose|Debug|Info|Warning|Error|Fatal): /;

/** Filtros por nível da tela (seleção única). `minRank` -1 = mostra tudo, inclusive linhas sem nível. */
export const FILTERS = Object.freeze([
  { id: 'all', label: 'Tudo', minRank: -1 },
  { id: 'warn', label: 'Avisos e erros', minRank: 3 },
  { id: 'error', label: 'Erros', minRank: 4 },
  { id: 'fatal', label: 'Graves', minRank: 5 },
]);

const FILTER_ALIASES = Object.freeze({
  all: 'all', todos: 'all', tudo: 'all',
  warn: 'warn', warning: 'warn', aviso: 'warn', avisos: 'warn', advertencia: 'warn',
  error: 'error', erro: 'error', erros: 'error',
  fatal: 'fatal', grave: 'fatal', graves: 'fatal',
});
/** Acha o filtro pelo id ou por um apelido (aceita "Fatal", "erro", "Graves"...). Valor desconhecido = "Tudo". */
export function filterById(id) {
  const key = String(id ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // hasOwn: "constructor"/"__proto__" existem em todo objeto e não podem passar por apelido
  const real = Object.hasOwn(FILTER_ALIASES, key) ? FILTER_ALIASES[key] : 'all';
  return FILTERS.find((f) => f.id === real) || FILTERS[0];
}

export function levelInfo(name) { return LEVELS.find((l) => l.value === name) || null; }

/** "AAAA-MM-DD HH:MM:SS.mmm" (hora local do PC) → milissegundos, ou null se a data não existir (ex.: 31 de fevereiro). */
export function parseTime(s) {
  if (typeof s !== 'string' || s.length < 23) return null;
  const y = +s.slice(0, 4), mo = +s.slice(5, 7), d = +s.slice(8, 10);
  const hh = +s.slice(11, 13), mi = +s.slice(14, 16), ss = +s.slice(17, 19), ms = +s.slice(20, 23);
  if ([y, mo, d, hh, mi, ss, ms].some((n) => !Number.isFinite(n)) || mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const dt = new Date(y, mo - 1, d, hh, mi, ss, ms);
  // o Date "empurra" datas impossíveis para o mês seguinte: se mudou, a data original era inválida
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt.getTime();
}

/**
 * Separa o texto do log em registros. Devolve {entries, lineCount}.
 * Cada registro: {id, time, ts, level, rank, head, prefixLen, cont[]}
 *  - head = primeira linha INTEIRA (com a hora e o nível); a mensagem é head.slice(prefixLen);
 *  - cont = linhas de continuação; rank -1 e level null = linhas soltas antes do primeiro cabeçalho (arquivo cortado).
 * Tolera BOM, CRLF, arquivo vazio e texto que nem é log (tudo vira um registro sem nível).
 */
export function parseLog(text) {
  let src = typeof text === 'string' ? text : '';
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
  if (!src) return { entries: [], lineCount: 0 };
  const lines = src.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();   // o arquivo termina com quebra de linha: não é uma linha a mais
  const entries = [];
  let cur = null;
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m) {
      cur = { id: entries.length, time: m[1], ts: parseTime(m[1]), level: m[2], rank: RANK[m[2]], head: line, prefixLen: m[0].length, cont: [] };
      entries.push(cur);
    } else if (cur) {
      cur.cont.push(line);
    } else {
      cur = { id: entries.length, time: null, ts: null, level: null, rank: -1, head: line, prefixLen: 0, cont: [] };
      entries.push(cur);
    }
  }
  return { entries, lineCount: lines.length };
}

/** Só a mensagem do registro (sem hora e nível). */
export const entryMessage = (e) => e.head.slice(e.prefixLen);
/** Número de linhas do registro (cabeçalho + continuações). */
export const entryLines = (e) => 1 + e.cont.length + (e.clipped || 0);
/** "HH:MM:SS" do registro, ou '' quando não tem hora. */
export const entryClock = (e) => (e.time ? e.time.slice(11, 19) : '');

/** Texto de busca: tira espaços das pontas; vazio = sem busca. */
export const normalizeQuery = (q) => String(q ?? '').trim();

/**
 * Filtra por nível mínimo e por texto (sem diferenciar maiúsculas de minúsculas). O texto casa com QUALQUER linha do registro
 * (cabeçalho ou continuação) e o registro volta inteiro, para não perder o contexto. Não altera `entries`.
 */
export function filterEntries(entries, { minRank = -1, query = '' } = {}) {
  const min = Number.isFinite(minRank) ? minRank : -1;
  const q = normalizeQuery(query).toLowerCase();
  if (min <= -1 && !q) return entries;
  const out = [];
  for (const e of entries) {
    if (min > -1 && e.rank < min) continue;
    if (q && !e.head.toLowerCase().includes(q) && !e.cont.some((l) => l.toLowerCase().includes(q))) continue;
    out.push(e);
  }
  return out;
}

/** Conta registros por nível: {Verbose, Debug, Info, Warning, Error, Fatal, none (sem nível), total}. */
export function countByLevel(entries) {
  const c = { Verbose: 0, Debug: 0, Info: 0, Warning: 0, Error: 0, Fatal: 0, none: 0, total: 0 };
  for (const e of entries) {
    c.total++;
    if (e.level) c[e.level]++; else c.none++;
  }
  return c;
}

/** Quantos registros têm nível >= minRank (o número que aparece em cada botão de filtro). */
export function countAtLeast(entries, minRank) {
  if (!(minRank > -1)) return entries.length;
  let n = 0;
  for (const e of entries) if (e.rank >= minRank) n++;
  return n;
}

/** Uma mensagem de erro que se repete tantas vezes é "ruído" de fundo (algo periódico), não um fato novo que mereça alarme. */
export const NOISE_REPEATS = 5;
/** Janela em que um erro ainda conta como "recente" (quem investiga um problema olha logo depois que ele acontece). */
export const RECENT_MS = 15 * 60 * 1000;

/**
 * Resume Avisos/Erros/Graves. `recent` = o último Erro/Grave aconteceu há no máximo `recentMs` (padrão 15 min) em relação a `now`.
 * `last` é o último registro Erro/Grave (o arquivo é cronológico). Sem hora legível, conta como recente (melhor avisar do que esconder).
 * Extras: `kinds` = quantas mensagens de erro diferentes; `top` = a mais repetida {message, count};
 * `fresh` = há Erro recente cuja mensagem NÃO é ruído (aparece menos de NOISE_REPEATS vezes) — é isso que acende o aviso em Informações.
 */
export function summarizeIssues(entries, now = Date.now(), recentMs = RECENT_MS) {
  let fatal = 0, error = 0, warning = 0, last = null;
  const counts = new Map();
  const errs = [];
  for (const e of entries) {
    if (e.rank === 5) fatal++;
    else if (e.rank === 4) {
      error++;
      const m = entryMessage(e).trim().slice(0, 300);
      counts.set(m, (counts.get(m) || 0) + 1);
      errs.push([e, m]);
    } else if (e.rank === 3) { warning++; continue; }
    else continue;
    last = e;
  }
  let top = null;
  for (const [message, count] of counts) if (!top || count > top.count) top = { message, count };
  const ageOf = (e) => (e.ts != null ? Math.max(0, now - e.ts) : null);
  const ageMs = last ? ageOf(last) : null;
  const fresh = errs.some(([e, m]) => counts.get(m) < NOISE_REPEATS && (ageOf(e) === null || ageOf(e) <= recentMs));
  return { fatal, error, warning, last, ageMs, recent: last ? (ageMs === null || ageMs <= recentMs) : false, kinds: counts.size, top, fresh };
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "há 5 min", "há 2 h", "há 3 dias"; tempo negativo (relógio mudou) vira "há poucos segundos". */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'há poucos segundos';
  const s = Math.floor(ms / 1000);
  if (s < 45) return 'há poucos segundos';
  const min = Math.round(s / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
}

/**
 * Texto do aviso sobre erros no registro, ou null quando não há Erro/Grave.
 * kind: 'bad' (há erro grave), 'warn' (erro recente), '' (erros antigos, só informativo); preset = filtro que mostra só eles.
 */
export function describeIssues(sum) {
  if (!sum || sum.fatal + sum.error === 0) return null;
  // Sem hora legível não dá para dizer "há quanto tempo": melhor omitir do que afirmar "há poucos segundos".
  let when = '';
  if (sum.last) {
    if (sum.ageMs !== null && sum.ageMs !== undefined) when = ` O último foi ${formatAge(sum.ageMs)}${sum.last.time ? ` (${entryClock(sum.last)})` : ''}.`;
    else if (sum.last.time) when = ` O último foi às ${entryClock(sum.last)}.`;
  }
  if (sum.fatal > 0) {
    const extra = sum.error > 0 ? ` e ${plural(sum.error, 'erro', 'erros')}` : '';
    return { kind: 'bad', preset: 'fatal', text: `O R3D PLAY registrou ${plural(sum.fatal, 'erro grave', 'erros graves')}${extra}.${when} Isso pode impedir a transmissão.` };
  }
  // Só erros comuns. O mesmo erro repetido muitas vezes costuma ser algo periódico e inofensivo: avisa sem alarme (sem cor de alerta).
  const top = sum.top;
  const noisy = !!top && top.count >= NOISE_REPEATS;
  const msg = top ? clipText(top.message || '(sem texto)', 100) : '';
  if (noisy && sum.kinds === 1) {
    return { kind: '', preset: 'error', text: `O registro repete ${top.count} vezes o mesmo erro: "${msg}".${when} Se tudo está funcionando, pode ignorar.` };
  }
  const fresh = !!sum.fresh;
  const repeated = noisy ? ` O mais repetido ("${msg}") aparece ${top.count} vezes.` : '';
  return {
    kind: fresh ? 'warn' : '',
    preset: 'error',
    text: `O registro tem ${plural(sum.error, 'erro', 'erros')}.${repeated}${when}${fresh ? '' : ' Pode não ter relação com o que está acontecendo agora.'}`,
  };
}

/** Corta uma linha muito longa (um JSON de 1 MB travaria a tela), sem partir um par substituto (emoji). */
export function clipText(text, max = 2000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xD800 && c <= 0xDBFF) end--;
  return `${s.slice(0, end)} … (+${s.length - end} caracteres)`;
}

/**
 * Fica só com o FIM do registro (o mais recente) para a tela não travar: no máximo `maxLines` linhas.
 * Se o último registro sozinho passa do limite, mostra o começo dele e marca `clipped` (linhas escondidas).
 * Devolve {entries, shownLines, totalLines, hiddenLines, hiddenEntries, truncated}. Não altera a entrada.
 */
export function limitLines(entries, maxLines = 1500) {
  const max = Math.max(1, Math.floor(Number(maxLines)) || 1);
  let total = 0;
  for (const e of entries) total += entryLines(e);
  if (total <= max) return { entries, shownLines: total, totalLines: total, hiddenLines: 0, hiddenEntries: 0, truncated: false };
  let acc = 0;
  let i = entries.length;
  while (i > 0) {
    const n = entryLines(entries[i - 1]);
    if (acc + n > max) break;
    acc += n;
    i--;
  }
  if (i === entries.length) {
    const e = entries[entries.length - 1];
    const keep = Math.max(0, max - 1);
    const cut = { ...e, cont: e.cont.slice(0, keep), clipped: e.cont.length - keep };
    return { entries: [cut], shownLines: max, totalLines: total, hiddenLines: total - max, hiddenEntries: entries.length - 1, truncated: true };
  }
  return { entries: entries.slice(i), shownLines: acc, totalLines: total, hiddenLines: total - acc, hiddenEntries: i, truncated: true };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Divide o texto em pedaços [{text, match}] para destacar a busca (sem HTML: quem desenha usa textContent). */
export function highlightParts(text, query) {
  const s = String(text ?? '');
  const q = normalizeQuery(query);
  if (!q || !s) return [{ text: s, match: false }];
  const re = new RegExp(escapeRegExp(q), 'gi');
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push({ text: s.slice(last, m.index), match: false });
    parts.push({ text: m[0], match: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ text: s.slice(last), match: false });
  return parts.length ? parts : [{ text: s, match: false }];
}

/** Junta os registros de volta em texto (o que o botão Copiar entrega), com as linhas originais. */
export function entriesToText(entries) {
  const out = [];
  for (const e of entries) {
    out.push(e.head);
    for (const l of e.cont) out.push(l);
  }
  return out.join('\n');
}

const MIN_LEVEL_LABELS = ['Verboso', 'Depuração', 'Informação', 'Advertência', 'Erro', 'Fatal', 'Nenhum'];
const MIN_LEVEL_NAMES = ['verbose', 'debug', 'info', 'warning', 'error', 'fatal', 'none'];
/**
 * Interpreta a chave min_log_level do sunshine.conf do MESMO jeito que o servidor (config.cpp): só os nomes exatos em minúsculas
 * valem; qualquer outro texto vale pelo 1º caractere, se for dígito de 0 a 6 ("10" = 1, "3abc" = 3, "DEBUG" = ignorado);
 * ausente ou ignorado = padrão 2 (Informação). `known` false = valor que o servidor ignora (usa o padrão).
 * `label` é o nome do seletor "Nível do log" em Configurações; `lineLabel` é como as linhas desse nível aparecem no registro
 * (ex.: Advertência → Aviso), para a tela explicar a diferença; vazio para "Nenhum".
 */
export function describeMinLogLevel(raw) {
  const text = String(raw ?? '').trim();
  const out = (rank, known, isDefault) => ({ rank, label: MIN_LEVEL_LABELS[rank], lineLabel: rank <= 5 ? LEVELS[rank].label : '', known, isDefault });
  if (!text) return out(2, true, true);
  let rank = MIN_LEVEL_NAMES.indexOf(text);
  if (rank < 0 && /^[0-6]/.test(text)) rank = Number(text[0]);
  if (rank < 0) return out(2, false, true);
  return out(rank, true, false);
}

/**
 * Texto da dica "Nível do log" sob o registro, a partir de describeMinLogLevel. O seletor de Configurações e as linhas do registro
 * usam nomes diferentes para o mesmo nível (Advertência/Aviso, Informação/Info…): a dica diz os dois para ninguém achar que são níveis distintos.
 * Devolve {kind: 'warn' | '', text}.
 */
export function describeLogLevelHint(lvl) {
  if (!lvl) return null;
  if (!lvl.known) return { kind: 'warn', text: 'O Nível do log tem um valor que o R3D PLAY não reconhece, então ele usa "Informação". Corrija em Configurações e reinicie o R3D PLAY.' };
  if (lvl.rank >= 6) return { kind: 'warn', text: 'O registro está desligado (Nível do log: Nenhum): nada novo é gravado. Ligue em Configurações e reinicie o R3D PLAY.' };
  const alias = lvl.lineLabel && lvl.lineLabel !== lvl.label ? ` (nas linhas do registro aparece como ${lvl.lineLabel})` : '';
  const head = `Nível do log: ${lvl.label}${alias}.`;
  if (lvl.rank >= 2) return { kind: '', text: `${head} Para ver mais detalhes (Depuração) ao investigar um problema, mude em Configurações e reinicie o R3D PLAY.` };
  return { kind: '', text: `${head} O registro pode ficar grande; depois de investigar, volte para "Informação" em Configurações.` };
}
