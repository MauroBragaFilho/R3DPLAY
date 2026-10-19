// Lógica pura da tela Início (sem DOM e sem rede): lê o JSON de uso do PC que vem de native("stats"), calcula percentuais,
// formata os textos em português do Brasil e decide os estados da tela (herói, endereços IP, resumo, driver de tela virtual).
// Tudo aqui tolera dado faltando (null, texto, formato errado): a primeira leitura de CPU vem vazia, há PCs com várias placas
// de vídeo e o servidor pode mudar de versão. Testado em dev/tests/home*.test.mjs.
'use strict';

/* ---------- Conversões seguras ---------- */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

/** Número finito ou null (aceita número e texto numérico; rejeita boolean, vazio, NaN e Infinity). */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
/** Percentual limitado a 0–100, ou null. */
export function clampPct(v) {
  const n = num(v);
  return n === null ? null : Math.min(100, Math.max(0, n));
}
/** used/total em %, limitado a 100; null quando não dá para calcular. */
export function percentOf(used, total) {
  const u = num(used);
  const t = num(total);
  if (u === null || t === null || t <= 0 || u < 0) return null;
  return Math.min(100, (u / t) * 100);
}
const bytesOrNull = (v) => { const n = num(v); return n !== null && n >= 0 ? n : null; };
/** Sensor com 0 °C (ou negativo) ou acima de 150 °C é leitura quebrada, não temperatura de verdade. */
const tempOrNull = (v) => { const n = num(v); return n !== null && n > 0 && n < 150 ? n : null; };

/* ---------- Leitura do JSON de uso do PC ---------- */
/**
 * Normaliza o JSON de GET /r3d/stats (texto ou objeto). Devolve null se não for um objeto com ao menos uma seção conhecida.
 * Formato de saída (campos ausentes viram null, nunca quebram):
 * { host, cpu:{name,usage,tempC,threads}|null, ram:{total,used,free,pct}|null,
 *   gpus:[{name,vendor,usage,tempC,vramTotal,vramUsed}], disks:[{name,total,used,free,pct}], stream:{active,fps}|null }
 */
export function parseStats(input) {
  let o = input;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { return null; }
  }
  if (!isObj(o)) return null;
  if (!['cpu', 'ram', 'gpus', 'disks', 'stream'].some((k) => o[k] !== undefined && o[k] !== null)) return null;

  const cpu = isObj(o.cpu)
    ? { name: text(o.cpu.name), usage: clampPct(o.cpu.usage), tempC: tempOrNull(o.cpu.temp_c), threads: Math.max(0, Math.round(num(o.cpu.threads) ?? 0)) }
    : null;

  let ram = null;
  if (isObj(o.ram)) {
    const total = bytesOrNull(o.ram.total);
    if (total) {   // total 0/ausente: não há como calcular nada
      const used = bytesOrNull(o.ram.used);
      const u = used === null ? null : Math.min(used, total);
      ram = { total, used: u, free: u === null ? null : total - u, pct: u === null ? null : (u / total) * 100 };
    }
  }

  const gpus = (Array.isArray(o.gpus) ? o.gpus : []).filter(isObj).map((g) => {
    const vt = bytesOrNull(g.vram_total);
    const vu = bytesOrNull(g.vram_used);
    return {
      name: text(g.name, 'Placa de vídeo'),
      vendor: text(g.vendor).toLowerCase(),
      usage: clampPct(g.usage),
      tempC: tempOrNull(g.temp_c),
      vramTotal: vt && vt > 0 ? vt : null,
      vramUsed: vu !== null && vt && vt > 0 ? Math.min(vu, vt) : vu,
    };
  });

  const disks = (Array.isArray(o.disks) ? o.disks : []).filter(isObj).map((d) => {
    const total = bytesOrNull(d.total);
    if (!total) return null;   // unidade sem tamanho (leitor vazio): não serve
    const used = bytesOrNull(d.used);
    const u = used === null ? null : Math.min(used, total);
    return { name: text(d.name, '?'), total, used: u, free: u === null ? null : total - u, pct: u === null ? null : (u / total) * 100 };
  }).filter(Boolean);

  const stream = isObj(o.stream)
    ? { active: o.stream.active === true, fps: (() => { const f = num(o.stream.fps); return f !== null && f >= 0 ? f : null; })() }
    : null;

  return { host: text(o.host), cpu, ram, gpus, disks, stream };
}

/** Resultado de native("stats") ({ok, body} ou {ok:false, error}) → {ok, stats, error}. Nunca lança. */
export function parseStatsResult(r) {
  if (!isObj(r)) return { ok: false, stats: null, error: 'sem resposta' };
  if (r.ok === false || (r.error && r.body === undefined)) return { ok: false, stats: null, error: text(String(r.error ?? ''), 'sem resposta') };
  const stats = parseStats(r.body);
  return stats ? { ok: true, stats, error: '' } : { ok: false, stats: null, error: 'resposta inválida' };
}

/* ---------- Formatação (PT-BR: vírgula decimal) ---------- */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
/** Uma casa decimal até 100; inteiro de 100 em diante; sem ",0" sobrando. */
function decimal(x) {
  const s = x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '');
  return s.replace('.', ',');
}
/** O que decimal() mostraria, como número (para saber se o texto vai arredondar para 1024 e merece a unidade seguinte). */
const shown = (x) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);
/** Bytes → {value:'23,8', unit:'GB'} (base 1024, como o Windows mostra). Valor inválido → {value:'—', unit:''}. */
export function splitBytes(n) {
  const v = bytesOrNull(n);
  if (v === null) return { value: '—', unit: '' };
  let x = v;
  let i = 0;
  // Também sobe de unidade quando o valor ARREDONDADO chegaria a 1024 (1023,6 GB vira "1 TB", não "1024 GB").
  while (i < UNITS.length - 1 && (x >= 1024 || shown(x) >= 1024)) { x /= 1024; i++; }
  return i === 0 ? { value: String(Math.round(x)), unit: 'B' } : { value: decimal(x), unit: UNITS[i] };
}
export function formatBytes(n) {
  const { value, unit } = splitBytes(n);
  return unit ? `${value} ${unit}` : value;
}
export function formatPercent(p) {
  const n = clampPct(p);
  return n === null ? '—' : `${Math.round(n)}%`;
}
/** 59 → "59 °C" (espaço sem quebra, para o °C não ir para a linha de baixo). */
export function formatTemp(c) {
  const n = tempOrNull(c);
  return n === null ? '—' : `${Math.round(n)} °C`;
}
export function formatFps(f) {
  const n = num(f);
  return n === null || n < 0 ? '—' : String(Math.round(n));
}
/** Nome do processador sem o ruído de marca: "11th Gen Intel(R) Core(TM) i5-11300H @ 3.10GHz" → "11th Gen Intel Core i5-11300H". */
export function shortCpuName(name) {
  return text(name).split(' @')[0]
    .replace(/\((R|TM)\)/gi, '').replace(/\bCPU\b/g, '').replace(/\b\d+-Core\b/gi, '').replace(/\bProcessor\b/gi, '')
    .replace(/\s+/g, ' ').trim();
}
/** "NVIDIA GeForce GTX 1650" → "GTX 1650"; "Intel(R) Iris(R) Xe Graphics" → "Intel Iris Xe". */
export function shortGpuName(name) {
  return text(name).replace(/NVIDIA GeForce /i, '').replace(/\((R|TM)\)/gi, '').replace(/\bGraphics\b/gi, '')
    .replace(/\s+/g, ' ').trim();
}
export function vendorLabel(vendor) {
  const v = text(vendor).toLowerCase();
  if (!v) return '';
  return { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' }[v] || v.charAt(0).toUpperCase() + v.slice(1);
}
/** "1.2.3.dirty" → "1.2.3 (versão de teste)": o servidor marca compilações locais com "dirty". */
export function formatVersion(v) {
  const s = text(typeof v === 'number' ? String(v) : v).replace(/^v/i, '');
  if (!s) return '';
  return /dirty/i.test(s) ? `${s.replace(/[.-]?dirty$/i, '')} (versão de teste)` : s;
}

/* ---------- Níveis (cor dos medidores) ---------- */
/** 'ok' | 'warn' | 'bad' | 'off' (sem dado). Para CPU/GPU não alarmamos: carga alta durante o jogo é normal. */
export function levelOf(pct, { warn = 70, bad = 90 } = {}) {
  const n = num(pct);
  if (n === null) return 'off';
  return n >= bad ? 'bad' : n >= warn ? 'warn' : 'ok';
}
/** Mesmos limites do celular: a partir de 65 °C amarelo, a partir de 80 °C vermelho. */
export function tempLevel(c) {
  const n = tempOrNull(c);
  if (n === null) return 'off';
  return n >= 80 ? 'bad' : n >= 65 ? 'warn' : 'ok';
}
const NO_ALARM = { warn: Infinity, bad: Infinity };
const FULL_LIMITS = { warn: 85, bad: 95 };   // memória e disco: aperta de verdade perto do limite

/* ---------- Várias placas de vídeo ---------- */
/** Chaves únicas (nome + ocorrência) para lembrar qual placa o usuário escolheu, mesmo com placas de nome igual. */
export function gpuKeys(gpus) {
  const seen = new Map();
  return (gpus || []).map((g) => {
    const base = `${g.vendor}|${g.name}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return `${base}#${n}`;
  });
}
/** Começa na NVIDIA, se houver (como no celular); senão na primeira. -1 quando não há placa. */
export function defaultGpuIndex(gpus) {
  if (!Array.isArray(gpus) || gpus.length === 0) return -1;
  const i = gpus.findIndex((g) => g.vendor === 'nvidia');
  return i >= 0 ? i : 0;
}
/** Índice da placa escolhida (pela chave); chave vazia ou que sumiu volta ao padrão. */
export function resolveGpuIndex(gpus, key) {
  if (!Array.isArray(gpus) || gpus.length === 0) return -1;
  const i = key ? gpuKeys(gpus).indexOf(key) : -1;
  return i >= 0 ? i : defaultGpuIndex(gpus);
}
/** Chave da próxima placa (dá a volta). Sem placas → ''. */
export function nextGpuKey(gpus, key) {
  if (!Array.isArray(gpus) || gpus.length === 0) return '';
  const keys = gpuKeys(gpus);
  return keys[(resolveGpuIndex(gpus, key) + 1) % keys.length];
}

/* ---------- Modelo dos cartões de uso ---------- */
/**
 * Converte as estatísticas já normalizadas (parseStats) nos textos/níveis que a tela mostra.
 * Cada parte é null quando o servidor não mandou aquela seção (a tela mostra "indisponível").
 */
export function buildUsage(stats, { gpuKey = '' } = {}) {
  if (!stats) return null;
  const { cpu, ram, gpus, disks, stream } = stats;

  const cpuVm = cpu && {
    valueText: cpu.usage === null ? '—' : String(Math.round(cpu.usage)),
    unit: cpu.usage === null ? '' : '%',
    pct: cpu.usage,
    level: levelOf(cpu.usage, NO_ALARM),
    measuring: cpu.usage === null,   // a primeira leitura vem vazia: o servidor ainda está medindo
    sub: cpu.usage === null ? 'Medindo o uso…' : shortCpuName(cpu.name),
  };

  const ramVm = ram && (() => {
    const used = splitBytes(ram.used);
    return {
      valueText: ram.used === null ? '—' : used.value,
      unit: ram.used === null ? '' : used.unit,
      pct: ram.pct,
      level: levelOf(ram.pct, FULL_LIMITS),
      tag: formatPercent(ram.pct),
      sub: ram.free === null ? `de ${formatBytes(ram.total)}` : `de ${formatBytes(ram.total)} · livre ${formatBytes(ram.free)}`,
    };
  })();

  const idx = resolveGpuIndex(gpus, gpuKey);
  const g = idx >= 0 ? gpus[idx] : null;
  let gpuVm;
  if (!g) {
    gpuVm = { valueText: '—', unit: '', pct: null, level: 'off', sub: 'nenhuma placa de vídeo detectada', tag: '', extra: '', count: 0, position: 0, key: '' };
  } else {
    let extra = '';
    if (g.vramUsed !== null && g.vramTotal) extra = `Memória de vídeo: ${formatBytes(g.vramUsed)} de ${formatBytes(g.vramTotal)}`;
    else if (g.vramTotal) extra = `Memória de vídeo: ${formatBytes(g.vramTotal)}`;
    gpuVm = {
      valueText: g.usage === null ? '—' : String(Math.round(g.usage)),
      unit: g.usage === null ? '' : '%',
      pct: g.usage,
      level: levelOf(g.usage, NO_ALARM),
      sub: shortGpuName(g.name),
      tag: vendorLabel(g.vendor),
      extra,
      count: gpus.length,
      position: idx + 1,
      key: gpuKeys(gpus)[idx],
    };
  }

  const disksVm = disks.map((d) => ({
    name: d.name,
    pct: d.pct,
    level: levelOf(d.pct, FULL_LIMITS),
    freeText: d.free === null ? '—' : `${formatBytes(d.free)} livres`,
    totalText: `de ${formatBytes(d.total)}`,
  }));

  // Temperaturas: processador e até duas placas de vídeo (as que têm leitura vêm primeiro).
  // pct = temperatura na escala de 0 a 100 °C (só para o medidor).
  const tempVm = (label, c) => ({ label, valueText: formatTemp(c), level: tempLevel(c), pct: tempOrNull(c) === null ? null : Math.min(100, tempOrNull(c)) });
  const temps = [];
  if (cpu) temps.push(tempVm('Processador', cpu.tempC));
  [...gpus].sort((a, b) => (b.tempC !== null) - (a.tempC !== null)).slice(0, 2).forEach((x) => {
    temps.push(tempVm(`Placa de vídeo${vendorLabel(x.vendor) ? ` ${vendorLabel(x.vendor)}` : ''}`, x.tempC));
  });

  const streamVm = stream && {
    active: stream.active,
    valueText: stream.active ? formatFps(stream.fps) : '—',
    unit: stream.active ? 'FPS' : '',
    tag: stream.active ? 'Ao vivo' : 'Parada',
    sub: stream.active ? 'quadros por segundo enviados ao celular' : 'nenhuma transmissão agora',
  };

  return { cpu: cpuVm, ram: ramVm, gpu: gpuVm, disks: disksVm, temps, stream: streamVm };
}

/* ---------- Estado do cartão principal ---------- */
/**
 * kind: restarting | loading | offline | streaming | attention | ready.
 * "attention" = servidor no ar, mas o driver de tela virtual não está pronto (não dá para dizer que está tudo pronto).
 */
export function heroState({ loaded = true, online = false, restarting = false, currentApp = '', apps = [], vdisplayProblem = false, deviceCount = null } = {}) {
  if (restarting) return { kind: 'restarting' };
  if (!online) return { kind: loaded ? 'offline' : 'loading' };
  if (currentApp) {
    const app = (Array.isArray(apps) ? apps : []).find((a) => a && a.uuid === currentApp);
    return { kind: 'streaming', game: text(app && app.name) };
  }
  if (vdisplayProblem) return { kind: 'attention' };
  return { kind: 'ready', needsDevice: deviceCount === 0 };
}

/* ---------- Driver de tela virtual ---------- */
// Textos em linguagem de gente (o enum do servidor fala em "watchdog" e "uninitialized"); entram na frase "A tela virtual não está pronta (…)".
const VDISPLAY_LABELS = { 1: 'Não foi possível verificar', '-1': 'Ainda não iniciou', '-2': 'Versão incompatível', '-3': 'Parou de responder' };
export const VDISPLAY_HELP = 'Verifique se o driver SudoVDA está instalado na versão mais recente e ativado corretamente.';
/** null quando está pronto (0) ou quando o servidor não informou (Windows only; ausente = não alarmar). */
export function vdisplayWarning(status) {
  const n = num(status);
  if (n === null || n === 0) return null;
  return { code: n, label: VDISPLAY_LABELS[String(n)] || VDISPLAY_LABELS[1], help: VDISPLAY_HELP };
}

/* ---------- Falha na leitura do uso do PC ---------- */
/** share_library: o servidor só aceita "enabled"/"disabled"; qualquer variação de "desligado" conta como desligado, o resto (inclusive ausente) é ligado. */
export function isShareLibraryOn(value) {
  return !(typeof value === 'string' && /^(disabled|false|no|off|0)$/i.test(value.trim()));
}
const NETWORK_ERROR = /refus|recus|time|tempo|conex|connect|network|rede|http 0|reset|unreach/i;
export const STATS_RETRY_MS = 3000;
export const STATS_BLOCKED_RETRY_MS = 30000;
/**
 * Por que o uso do PC não aparece. 'blocked' = a opção "Compartilhar biblioteca de jogos" está desligada (o servidor responde 403 em /r3d/stats
 * e a chave só vale após reiniciar): tentar a cada 3 s não adianta. 'offline' = servidor desligado. 'unavailable' = falha passageira.
 * error = texto de parseStatsResult; shareLibrary = valor da configuração (true/false; undefined = não sabemos).
 */
export function statsFailure({ error = '', shareLibrary = true, online = true } = {}) {
  if (!online) {
    return { kind: 'offline', retryMs: STATS_RETRY_MS, message: 'O R3D PLAY está desligado, por isso não há dados de uso. Eles voltam sozinhos quando ele ligar.' };
  }
  const err = String(error ?? '');
  // O 403 é a assinatura certa; a configuração só desempata quando o erro não é de rede (servidor lento não é "bloqueio").
  if (/\b403\b/.test(err) || (shareLibrary === false && !NETWORK_ERROR.test(err))) {
    return {
      kind: 'blocked', retryMs: STATS_BLOCKED_RETRY_MS,
      message: 'O uso do PC está desligado nas configurações (opção "Compartilhar biblioteca de jogos"). Ative-a em Configurações > Outras e reinicie o R3D PLAY.',
    };
  }
  return { kind: 'unavailable', retryMs: STATS_RETRY_MS, message: 'Não consegui ler o uso do PC agora. A leitura tenta de novo sozinha a cada poucos segundos.' };
}

/* ---------- Endereços IP do PC ---------- */
export const IP_LABEL = { wifi: 'Wi-Fi', lan: 'Cabo', tailscale: 'Tailscale (fora de casa)', vpn: 'VPN' };
const KIND_ORDER = ['wifi', 'lan', 'tailscale', 'vpn'];

/** IPv4 válido e útil para conectar (sem 0.0.0.0, loopback nem endereço automático 169.254). */
export function isUsableIpv4(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return false;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return false;
  if (p[0] === 0 || p[0] === 127 || (p[0] === 169 && p[1] === 254)) return false;
  return true;
}
/** Tipo da conexão. A faixa do endereço e o nome da placa valem mais que o "kind" do app, que pode errar (VPN virando "cabo"). */
export function classifyIp({ ip, kind, name } = {}) {
  const [a, b] = String(ip || '').split('.').map(Number);
  const nm = String(name || '');
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale';   // faixa CGNAT usada pelo Tailscale
  if (/tailscale/i.test(nm)) return 'tailscale';
  if (a === 26 || /vpn|radmin|hamachi|zerotier|wireguard/i.test(nm)) return 'vpn';
  return KIND_ORDER.includes(kind) ? kind : 'lan';
}
/** Resultado de native("info") → [{ip, kind, label, name}] sem repetidos, Wi-Fi e cabo primeiro. */
export function normalizeIps(info) {
  const list = info && Array.isArray(info.ips) ? info.ips : [];
  const seen = new Set();
  const out = [];
  for (const it of list) {
    if (!isObj(it) || !isUsableIpv4(it.ip)) continue;
    const ip = it.ip.trim();
    if (seen.has(ip)) continue;
    seen.add(ip);
    const kind = classifyIp({ ip, kind: it.kind, name: it.name });
    out.push({ ip, kind, label: IP_LABEL[kind], name: text(it.name) });
  }
  return out.map((x, i) => ({ x, i })).sort((p, q) => KIND_ORDER.indexOf(p.x.kind) - KIND_ORDER.indexOf(q.x.kind) || p.i - q.i).map((p) => p.x);
}
/** Orientação curta sobre qual endereço usar ('' quando não há o que dizer). */
export function ipsHint(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const home = list.some((x) => x.kind === 'wifi' || x.kind === 'lan');
  const remote = list.some((x) => x.kind === 'tailscale' || x.kind === 'vpn');
  if (!home && remote) return 'Só encontrei endereços de Tailscale ou VPN. Para jogar em casa, conecte o PC ao Wi-Fi ou a um cabo de rede.';
  if (home && remote) return 'Em casa, use o endereço de Wi-Fi ou Cabo. Tailscale e VPN servem para jogar fora de casa.';
  return '';
}

/* ---------- Resumo (números clicáveis) ---------- */
/** GET /api/clients/list → {total, connected}; null se a resposta não for uma lista. */
export function summarizeClients(json) {
  const list = isObj(json) && Array.isArray(json.named_certs) ? json.named_certs.filter(isObj) : null;
  if (!list) return null;
  return { total: list.length, connected: list.filter((c) => c.connected === true).length };
}
/**
 * Os três números do resumo. clients = {status:'loading'|'ok'|'error', total, connected}.
 * Sem servidor não dá para saber nada: mostra "–" em vez de um zero que pareceria verdade.
 */
export function summaryTiles({ online = false, appsCount = 0, streaming = false, clients = null } = {}) {
  const n = Math.max(0, Math.floor(num(appsCount) ?? 0));
  const games = online
    ? { value: String(n), sub: n === 0 ? 'nenhum na lista' : 'na sua lista' }
    : { value: '–', sub: 'sem conexão' };

  let devices;
  const c = clients || { status: 'loading' };
  if (!online) devices = { value: '–', sub: 'sem conexão' };
  else if (c.status === 'loading') devices = { value: '…', sub: 'verificando' };
  else if (c.status !== 'ok') devices = { value: '–', sub: 'não foi possível ler' };
  else {
    const conn = c.connected || 0;
    devices = {
      value: String(c.total || 0),
      sub: !c.total ? 'nenhum celular pareado' : conn === 0 ? 'nenhum conectado agora' : conn === 1 ? '1 conectado agora' : `${conn} conectados agora`,
    };
  }

  const streams = online
    ? { value: streaming ? '1' : '0', sub: streaming ? 'em andamento' : 'nenhuma agora' }
    : { value: '–', sub: 'sem conexão' };

  return [
    { id: 'games', tab: 'games', label: 'Jogos', ...games },
    { id: 'devices', tab: 'devices', label: 'Dispositivos', ...devices },
    { id: 'streams', tab: 'games', label: 'Transmissões', ...streams },
  ];
}
