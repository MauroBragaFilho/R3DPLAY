// Modelo puro dos aplicativos (apps.json): normalização, defaults do schema, validação, diff, ordenação, filtros e origem.
// Nada aqui toca DOM, rede nem localStorage: tudo é testável com `node --test` (dev/tests/games-*.test.mjs).
// O schema (ui/schema/apps.json) é sempre passado como parâmetro: no navegador vem de fetch(), nos testes vem do disco.
'use strict';

/** Chaves de execução/interface que nunca devem ir para o apps.json (o servidor só descarta 'launching' e 'index'). */
export const RUNTIME_KEYS = ['id', 'idx', 'index', 'launching', 'dragover'];

/* ---------- Utilidades básicas ---------- */
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const deepClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}
export const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

/** Converte para booleano de verdade (apps antigos têm "true"/"false" em texto; o servidor quebra com texto nestas chaves). */
export function coerceBool(v, def = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isNaN(v) ? def : v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'on', 'yes', 'enabled', 'sim'].includes(s)) return true;
    if (['false', '0', 'off', 'no', 'disabled', 'nao', 'não'].includes(s)) return false;
  }
  return def;
}
/** Maior inteiro que o servidor lê com segurança (int de 32 bits). Acima disso o JSON vira ponto flutuante e o valor sai truncado ou negativo. */
export const INT_LIMIT = 2147483647;
/** Converte para inteiro; qualquer coisa que não seja número inteiro (ou que nem caiba com precisão num número) vira o padrão. */
export function coerceInt(v, def) {
  let n;
  if (typeof v === 'number') n = Number.isFinite(v) ? Math.trunc(v) : NaN;
  else if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) n = parseInt(v, 10);   // 20 noves viram 1e20: não é inteiro seguro
  else return def;
  return Number.isSafeInteger(n) ? n : def;
}
/** Texto de uma linha só, sem espaços nas pontas (quebra de linha dentro de um comando não faz sentido no apps.json). */
export const cleanText = (v) => (v === null || v === undefined ? '' : String(v)).replace(/[\r\n]+/g, ' ').trim();
/** Caminho de imagem: o servidor exige sem aspas e sem espaços nas pontas (regra image-path-png). */
export const cleanImagePath = (v) => cleanText(v).replace(/"/g, '').trim();
export const isPngPath = (p) => /\.png$/i.test(String(p || '').trim());
/** Os 8 primeiros bytes de um PNG de verdade. */
export function isPngBytes(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return !!bytes && bytes.length >= 8 && sig.every((b, i) => bytes[i] === b);
}

/**
 * Confere o $(VAR) do apps.json do mesmo jeito que o servidor (parse_env_val em process.cpp):
 * "$(" precisa de ")" correspondente (com parênteses aninhados), "$$" vira um "$" e o resto do "$" é ignorado.
 * Um "$(" aberto derruba o carregamento de TODOS os apps, por isso a tela barra antes de gravar. Devolve null ou a mensagem.
 */
export function checkInterpolation(texto) {
  const t = String(texto ?? '');
  let i = t.indexOf('$');
  while (i !== -1) {
    const next = t[i + 1];
    if (next === undefined) break;
    if (next === '(') {
      let depth = 0;
      let close = -1;
      for (let j = i + 1; j < t.length; j++) {
        if (t[j] === '(') depth++;
        else if (t[j] === ')') { depth--; if (depth === 0) { close = j; break; } }
      }
      if (close === -1) return 'Há um "$(" sem o ")" correspondente. Para escrever um cifrão comum, use "$$".';
      i = t.indexOf('$', close);
    } else if (next === '$') {
      i = t.indexOf('$', i + 2);
    } else {
      i = t.indexOf('$', i + 1);
    }
  }
  return null;
}
/**
 * Deixa um texto que o servidor não conseguiria ler (um "$(" sem ")") seguro: cada "$" vira "$$", que o servidor lê como um "$" comum.
 * Texto que já está certo volta igual. Serve para dados que a pessoa não digitou (nome do jogo, pasta de instalação).
 */
export function safeInterpolation(texto) {
  const t = String(texto ?? '');
  return checkInterpolation(t) ? t.replace(/\$/g, () => '$$') : t;
}
/** Aplica safeInterpolation em todo campo do aplicativo que o servidor expande ao carregar o apps.json. Devolve uma cópia. */
export function sanitizeInterpolations(app) {
  if (!isObj(app)) return app;
  const out = { ...app };
  const fix = (v) => (typeof v === 'string' ? safeInterpolation(v) : v);
  for (const k of ['name', 'cmd', 'working-dir', 'output', 'image-path']) if (k in out) out[k] = fix(out[k]);
  if (Array.isArray(out.detached)) out.detached = out.detached.map(fix);
  for (const k of ['prep-cmd', 'state-cmd']) {
    if (Array.isArray(out[k])) out[k] = out[k].map((c) => (isObj(c) ? { ...c, do: fix(c.do), undo: fix(c.undo) } : c));
  }
  return out;
}

/* ---------- Schema ---------- */
export const fieldMap = (schema) => new Map((schema?.fields || []).map((f) => [f.key, f]));

/** Valor padrão de um campo. O nome do modelo ("New App") não é padrão de verdade: o servidor assume '' se faltar. */
export function defaultOf(field, schema) {
  if (field.key === 'name') return '';
  const t = schema?.new_app_template;
  if (t && Object.prototype.hasOwnProperty.call(t, field.key)) return deepClone(t[field.key]);
  return deepClone(field.default ?? (field.type === 'toggle' ? false : field.type === 'number' ? 0 : ''));
}

/** O campo aparece nesta plataforma e com o estado atual? (platform do schema + visible_if "chave == true"). */
export function fieldVisible(field, app, platform = 'windows') {
  if (Array.isArray(field.platform) && !field.platform.includes(platform)) return false;
  const m = typeof field.visible_if === 'string' ? field.visible_if.match(/^([\w-]+)\s*==\s*(true|false)$/) : null;
  if (m) return coerceBool(app?.[m[1]], false) === (m[2] === 'true');
  return true;
}
/** Opções de um select permitidas nesta plataforma. */
export const selectOptions = (field, platform = 'windows') => (field.options || []).filter((o) => !o.platform || o.platform === platform || (Array.isArray(o.platform) && o.platform.includes(platform)));

/* Interruptores: ui_inverted mostra o oposto do valor gravado (exclude-global-* marcado = usar os comandos globais). */
export const toggleChecked = (field, value) => (field.ui_inverted ? !value : !!value);
export const toggleFromChecked = (field, checked) => (field.ui_inverted ? !checked : !!checked);
/** Dica "Padrão: marcado/desmarcado" do ponto de vista do que o usuário vê na tela. */
export function toggleHint(field, schema) {
  const marcado = Object.prototype.hasOwnProperty.call(field, 'ui_default_checked') ? !!field.ui_default_checked : toggleChecked(field, !!field.default);
  return marcado ? schema.toggle_default_hint.checked : schema.toggle_default_hint.unchecked;
}

/* ---------- Normalização ---------- */
function normalizeCmds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list) {
    if (!isObj(it)) continue;
    const item = { ...it, do: cleanText(it.do), undo: cleanText(it.undo), elevated: coerceBool(it.elevated, false) };
    if (!item.do && !item.undo) continue;   // linha em branco não vale nada para o servidor
    out.push(item);
  }
  return out;
}
function normalizeValue(f, v, schema) {
  const def = defaultOf(f, schema);
  switch (f.type) {
    case 'toggle': return coerceBool(v, def);
    case 'number': return coerceInt(v, def);
    case 'detached': {
      const arr = Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? [v] : []);
      return arr.filter((x) => typeof x === 'string' || typeof x === 'number').map(cleanText).filter(Boolean);
    }
    case 'prepcmds': return normalizeCmds(v);
    case 'image': return v === undefined || v === null ? def : cleanImagePath(v);
    default: return v === undefined || v === null ? def : cleanText(v);
  }
}

/**
 * Devolve o aplicativo COMPLETO e com os tipos certos (booleanos e inteiros de verdade, listas sem linhas em branco).
 * Chaves que o schema não conhece são preservadas (o servidor grava qualquer coisa e o app pode ter campos de outras versões).
 */
export function normalizeApp(raw, schema) {
  const src = isObj(raw) ? raw : {};
  const out = deepClone(src);
  for (const k of RUNTIME_KEYS) delete out[k];
  for (const f of schema.fields) {
    if (f.key === 'uuid') continue;
    out[f.key] = normalizeValue(f, src[f.key], schema);
  }
  if (typeof out.uuid !== 'string' || !out.uuid.trim()) delete out.uuid;
  if (!out['use-app-identity']) out['per-client-app-identity'] = false;   // sem efeito sem a identidade do app (regra do schema)
  return out;
}

/** Aplicativo novo, nascido do new_app_template (cópia profunda: listas nunca são compartilhadas entre formulários). */
export function newApp(schema) {
  const t = deepClone(schema.new_app_template);
  delete t._notes;
  t.name = '';   // o usuário precisa dar um nome de verdade (o "New App" do modelo é só texto de exemplo)
  return normalizeApp(t, schema);
}

/** Objeto que vai no POST /api/apps: normalizado e sem as chaves que o servidor quer ausentes quando vazias (working-dir, detached, prep-cmd). */
export function toPayload(app, schema) {
  const out = normalizeApp(app, schema);
  for (const f of schema.fields) {
    if (!f.omit_when_empty) continue;
    const v = out[f.key];
    if (v === '' || (Array.isArray(v) && v.length === 0)) delete out[f.key];
  }
  return out;
}

/** Chaves cujo valor mudou entre dois aplicativos (já normalizados dos dois lados). */
export function changedKeys(a, b, schema) {
  const na = toPayload(a, schema);
  const nb = toPayload(b, schema);
  const keys = new Set([...Object.keys(na), ...Object.keys(nb)]);
  return [...keys].filter((k) => !deepEqual(na[k], nb[k]));
}

/**
 * Aplica ao aplicativo ATUAL do servidor (fresh) só o que o usuário mudou no formulário (original -> edited).
 * Assim uma alteração feita por outro caminho enquanto o editor estava aberto (capa, política dos jogos) não se perde,
 * e as chaves desconhecidas do app continuam como estão.
 */
export function mergeEdit(fresh, original, edited, schema) {
  const base = normalizeApp(fresh, schema);
  const ed = normalizeApp(edited, schema);
  for (const k of changedKeys(original, edited, schema)) {
    if (k === 'uuid') continue;
    if (Object.prototype.hasOwnProperty.call(ed, k)) base[k] = ed[k]; else delete base[k];
  }
  return toPayload(base, schema);
}

/** Quantos campos avançados (visíveis nesta plataforma) estão diferentes do padrão: aparece no título do bloco "Avançado". */
export function advancedCustomCount(app, schema, platform = 'windows') {
  const norm = normalizeApp(app, schema);
  let n = 0;
  for (const f of schema.fields) {
    if (!f.advanced || f.key === 'uuid' || !fieldVisible(f, norm, platform)) continue;
    if (!deepEqual(norm[f.key], defaultOf(f, schema))) n++;
  }
  return n;
}

/* ---------- Validação ---------- */
/**
 * Valida o estado BRUTO do formulário (números ainda como texto digitado). Devolve { errors, warnings }, cada um { chaveDoCampo: mensagem }.
 * Erros impedem salvar; avisos só orientam. Mensagens em português para quem não é técnico.
 * skipImage: não confere o campo da imagem (há uma imagem nova escolhida; o caminho do campo será trocado pelo do envio).
 */
export function validateApp(raw, schema, { platform = 'windows', skipImage = false } = {}) {
  const errors = {};
  const warnings = {};
  const A = isObj(raw) ? raw : {};
  const fields = fieldMap(schema);

  const name = cleanText(A.name);
  if (!name) errors.name = 'Dê um nome ao aplicativo.';
  else if (checkInterpolation(name)) errors.name = checkInterpolation(name);

  for (const key of ['cmd', 'working-dir', 'output']) {
    const bad = checkInterpolation(cleanText(A[key]));
    if (bad) errors[key] = bad;
  }
  const img = cleanImagePath(A['image-path']);
  if (skipImage) { /* a imagem nova vem do envio, não do texto do campo */ }
  else if (img && !isPngPath(img)) errors['image-path'] = 'A imagem precisa ser um arquivo PNG (o nome termina em .png).';
  else if (checkInterpolation(img)) errors['image-path'] = checkInterpolation(img);

  const detached = Array.isArray(A.detached) ? A.detached : [];
  detached.forEach((c, i) => {
    const bad = checkInterpolation(cleanText(c));
    if (bad && !errors.detached) errors.detached = `Comando ${i + 1}: ${bad}`;
  });
  for (const key of ['prep-cmd', 'state-cmd']) {
    (Array.isArray(A[key]) ? A[key] : []).forEach((c, i) => {
      for (const [campo, rotulo] of [['do', 'executar'], ['undo', 'desfazer']]) {
        const bad = checkInterpolation(cleanText(c?.[campo]));
        if (bad && !errors[key]) errors[key] = `Comando ${i + 1} (${rotulo}): ${bad}`;
      }
    });
  }

  for (const f of schema.fields) {
    if (f.type !== 'number' || !fieldVisible(f, A, platform)) continue;
    const s = A[f.key] === undefined || A[f.key] === null ? '' : String(A[f.key]).trim();
    if (s === '') continue;   // vazio = usa o padrão
    const unit = f.unit === '%' ? '%' : f.unit ? ` ${f.unit}` : '';
    if (!/^-?\d+$/.test(s)) { errors[f.key] = 'Digite um número inteiro, sem vírgula nem letras.'; continue; }
    const n = parseInt(s, 10);
    const lo = typeof f.min === 'number' ? f.min : null;
    const hi = typeof f.max === 'number' ? f.max : null;
    if ((lo !== null && n < lo) || (hi !== null && n > hi)) {
      errors[f.key] = lo !== null && hi !== null ? `Use um valor de ${lo}${unit} a ${hi}${unit}.` : lo !== null ? `O menor valor é ${lo}${unit}.` : `O maior valor é ${hi}${unit}.`;
    } else if (!Number.isSafeInteger(n) || Math.abs(n) > INT_LIMIT) {
      errors[f.key] = 'Esse número é grande demais. Use um valor menor.';   // campos sem máximo no schema (exit-timeout) estourariam o inteiro do servidor
    }
  }

  const gp = fields.get('gamepad');
  if (gp && fieldVisible(gp, A, platform) && A.gamepad) {
    if (!selectOptions(gp, platform).some((o) => o.value === A.gamepad)) errors.gamepad = 'Escolha um tipo de controle da lista.';
  }
  if (coerceBool(A['use-app-identity'], false) && typeof A.uuid === 'string' && A.uuid && A.uuid.length !== 36) {
    errors['use-app-identity'] = 'Este aplicativo tem um identificador fora do formato esperado (36 caracteres); a identidade própria do aplicativo não funcionaria. Desligue esta opção.';
  }

  const cmd = cleanText(A.cmd);
  const quoted = cmd.match(/^([A-Za-z]:[\\/][^"]*?\.(?:exe|bat|cmd|com))(?![\w.])/i);
  if (!errors.cmd && quoted && /\s/.test(quoted[1])) warnings.cmd = 'O caminho tem espaços. Coloque o programa entre aspas, por exemplo: "C:\\Pasta com espaço\\jogo.exe".';
  if (!errors.cmd && !cmd && detached.every((c) => !cleanText(c)) && !normalizeCmds(A['prep-cmd']).length) {
    warnings.cmd = 'Sem comando e sem comandos desvinculados, este aplicativo só mostra a área de trabalho do PC.';
  }
  return { errors, warnings };
}

/* ---------- Origem do jogo (Steam, Epic...) ---------- */
export const SOURCE_KEYS = ['steam', 'epic', 'gog', 'ubisoft', 'other'];
export const SOURCE_LABELS = { steam: 'Steam', epic: 'Epic', gog: 'GOG', ubisoft: 'Ubisoft', other: 'Outros' };
/** Rótulo pequeno sob o nome do jogo. */
export const sourceLabel = (key) => (key === 'other' || !SOURCE_LABELS[key] ? 'Aplicativo' : SOURCE_LABELS[key]);
/** Aceita só as origens que o scanner conhece ('' se for outra coisa). */
export const knownSource = (s) => { const k = String(s || '').toLowerCase(); return SOURCE_KEYS.includes(k) && k !== 'other' ? k : ''; };

/** Descobre a origem pelos comandos do aplicativo (sem precisar escanear de novo). '' se não der para saber. */
export function guessSource(app) {
  if (!isObj(app)) return '';
  const textos = [app.cmd, app['working-dir'], ...(Array.isArray(app.detached) ? app.detached : []),
    ...(Array.isArray(app['prep-cmd']) ? app['prep-cmd'].flatMap((c) => [c?.do, c?.undo]) : [])].map((t) => String(t || ''));
  const tem = (re) => textos.some((t) => re.test(t));
  if (tem(/steam:\/\//i) || tem(/--launch-steam\b/i)) return 'steam';
  if (tem(/com\.epicgames\.launcher:\/\//i)) return 'epic';
  if (tem(/\buplay:\/\//i) || tem(/\bubisoft(connect)?:\/\//i)) return 'ubisoft';
  if (tem(/goggalaxy:\/\//i) || tem(/[\\/]GOG(?: Games| Galaxy)?[\\/]/i)) return 'gog';
  return '';
}
/** Origem final: a que o scanner viu (mais confiável), senão o palpite pelos comandos, senão "other". */
export const sourceOf = (app, scanned) => knownSource(scanned) || guessSource(app) || 'other';

/* ---------- Busca, filtro e ordem ---------- */
/** Minúsculas e sem acento: "acao" encontra "Ação". */
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
export const matchesQuery = (name, query) => { const q = norm(query); return !q || norm(name).includes(q); };
export function filterApps(apps, { query = '', source = 'all', sourceOf: getSource = () => 'other' } = {}) {
  return apps.filter((a) => matchesQuery(a.name, query) && (source === 'all' || getSource(a) === source));
}
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
export const sortByName = (apps) => [...apps].sort((a, b) => collator.compare(String(a.name ?? ''), String(b.name ?? '')));
export const isAlphabetized = (apps) => apps.every((a, i) => i === 0 || collator.compare(String(apps[i - 1].name ?? ''), String(a.name ?? '')) <= 0);

/** Aplica uma ordem (lista de uuids) à lista de apps: o que não está na ordem vai para o fim, uuids desconhecidos são ignorados. */
export function orderedApps(apps, order) {
  if (!order) return apps;
  const by = new Map(apps.map((a) => [a.uuid, a]));
  const seen = new Set();
  const out = [];
  for (const u of order) if (by.has(u) && !seen.has(u)) { out.push(by.get(u)); seen.add(u); }
  for (const a of apps) if (!seen.has(a.uuid)) out.push(a);
  return out;
}
/** Move `uuid` para antes/depois de `target` (arrastar e soltar). */
export function moveUuid(order, uuid, target, after = false) {
  if (uuid === target || !order.includes(uuid) || !order.includes(target)) return [...order];
  const rest = order.filter((u) => u !== uuid);
  const i = rest.indexOf(target);
  rest.splice(after ? i + 1 : i, 0, uuid);
  return rest;
}
/** Anda `delta` casas (botões acessíveis por teclado), sem passar das pontas. */
export function stepUuid(order, uuid, delta) {
  const i = order.indexOf(uuid);
  if (i < 0) return [...order];
  const j = Math.max(0, Math.min(order.length - 1, i + delta));
  const rest = order.filter((u) => u !== uuid);
  rest.splice(j, 0, uuid);
  return rest;
}
export const sameOrder = (a, b) => a.length === b.length && a.every((u, i) => u === b[i]);

/** O que mostrar no lugar da capa quando não há imagem: ícone para os apps de sistema, senão a inicial do nome. */
export function placeholderFor(app) {
  const n = norm(app?.name);
  const img = String(app?.['image-path'] || '').toLowerCase();
  if (n === 'desktop' || img === 'desktop.png' || img === 'virtual_desktop.png') return { kind: 'icon', name: 'desktop_windows' };
  if (n.includes('steam big picture') || img === 'steam.png') return { kind: 'icon', name: 'sports_esports' };
  if (img === 'terminate.png') return { kind: 'icon', name: 'stop_circle' };
  if (img === 'input_only.png') return { kind: 'icon', name: 'keyboard' };
  const letra = String(app?.name || '').match(/[\p{L}\p{N}]/u);
  return { kind: 'letter', text: letra ? letra[0].toUpperCase() : '?' };
}
