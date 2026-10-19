// Pareamento de dispositivos: lógica PURA (sem DOM; rede e relógio entram por parâmetro), testada em dev/tests/devices-pairing.test.mjs.
//
// POLÍTICA DE ACESSO (corrige o grantFull() da interface antiga, que dava controle total a QUALQUER aparelho com a permissão padrão):
// quem pareia pelo painel é o dono do PC, então o aparelho que ACABOU de parear recebe o modelo escolhido (padrão: Controle total).
// Para saber qual aparelho acabou de parear, tira-se um retrato dos uuids ANTES de enviar o PIN e, depois do sucesso, procura-se
// (poll curto) os uuids NOVOS. Só eles são alterados. Aparelhos que já existiam nunca são promovidos.
import { normalizeMask } from './perms.js';

export const PIN_LENGTH = 4;
export const OTP_TTL_SECONDS = 180;
export const DEFAULT_PAIR_PORT = 47989;   // porta do painel web (47990) menos 1
export const NAME_MAX = 48;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/* ---------- PIN e nomes ---------- */
/** Valida o PIN digitado. Aceita espaços no meio (colagem "12 34"); só dígitos ASCII. Devolve {ok, pin} ou {ok:false, error}. */
export function validatePin(raw) {
  const s = String(raw ?? '').replace(/\s+/g, '');
  if (!s) return { ok: false, error: `Digite os ${PIN_LENGTH} números que aparecem no celular.` };
  if (!/^[0-9]{4}$/.test(s)) return { ok: false, error: `O PIN tem exatamente ${PIN_LENGTH} números (só dígitos).` };
  return { ok: true, pin: s };
}

/**
 * Nome seguro para o servidor: sem controle/quebra de linha, parênteses viram colchetes (o servidor faz o mesmo no pareamento e
 * corta o nome no primeiro " (" ao gravar), espaços repetidos viram um só, no máximo `max` caracteres.
 */
export function sanitizeDeviceName(raw, max = NAME_MAX) {
  let s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\(/g, '[').replace(/\)/g, ']')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...s];
  if (chars.length > max) s = chars.slice(0, max).join('').trim();
  return s;
}

/** Outro dispositivo já usa este nome? (o servidor acrescenta " (2)" ao repetido.) */
export function findDuplicateName(list, name, exceptUuid = '') {
  const n = String(name ?? '').trim();
  if (!n || !Array.isArray(list)) return null;
  return list.find((d) => d && d.uuid !== exceptUuid && typeof d.name === 'string' && d.name.trim() === n) || null;
}

/* ---------- Retrato de uuids e detecção de aparelho novo ---------- */
/** Aceita Set, lista de uuids ou lista de dispositivos. Ignora entradas sem uuid texto. */
export function uuidsOf(list) {
  const out = new Set();
  const src = list instanceof Set ? [...list] : Array.isArray(list) ? list : [];
  for (const x of src) {
    const u = typeof x === 'string' ? x : x && typeof x.uuid === 'string' ? x.uuid : '';
    if (u) out.add(u);
  }
  return out;
}

/** uuids de `after` que não estavam em `before` (ordem da lista, sem repetir). */
export function findNewUuids(before, after) {
  const had = uuidsOf(before);
  const out = [];
  for (const u of uuidsOf(after)) if (!had.has(u)) out.push(u);
  return out;
}

/** Decisão sobre os aparelhos novos: nenhum / exatamente um (seguro promover) / vários (ambíguo: não promover ninguém). */
export function decideNewDevices(before, after) {
  const uuids = findNewUuids(before, after);
  return { kind: uuids.length === 0 ? 'none' : uuids.length === 1 ? 'one' : 'many', uuids, uuid: uuids.length === 1 ? uuids[0] : null };
}

/**
 * Se (e só se) surgiu EXATAMENTE um aparelho novo, aplica a máscara a ele. Nunca toca em quem já existia.
 * setPerm(uuid, mask) -> {ok, error?}. Devolve {status: 'none'} | {status:'ambiguous', uuids} | {status:'paired', uuid, device, applied, skipped, error?}.
 * skipped = o aparelho já nasceu com o acesso pedido (ex.: o primeiro pareado recebe tudo do servidor) ou não foi pedido modelo.
 */
export async function promoteNewDevice({ before, list, mask, setPerm }) {
  const d = decideNewDevices(before, list);
  if (d.kind === 'none') return { status: 'none' };
  if (d.kind === 'many') return { status: 'ambiguous', uuids: d.uuids };
  const device = list.find((x) => x && x.uuid === d.uuid) || { uuid: d.uuid };
  if (mask === undefined || mask === null) return { status: 'paired', uuid: d.uuid, device, applied: false, skipped: true };
  const want = normalizeMask(mask);
  if (normalizeMask(device.perm) === want) return { status: 'paired', uuid: d.uuid, device, applied: false, skipped: true };
  let r;
  try { r = await setPerm(d.uuid, want); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  return { status: 'paired', uuid: d.uuid, device, applied: !!(r && r.ok), skipped: false, error: r && !r.ok ? (r.error || 'erro desconhecido') : undefined };
}

/**
 * Pareamento por PIN, do começo ao fim. Tudo que toca o mundo entra por parâmetro (por isso é testável sem rede):
 *   listClients() -> lista de dispositivos | null (falhou)
 *   postPin(pin, name) -> {ok, accepted, offline?, error?}   (accepted = o servidor respondeu status:true)
 *   setPerm(uuid, mask) -> {ok, error?}
 * Resultados (status): 'snapshot_failed' | 'offline' | 'pin_error' | 'rejected' | 'ambiguous' | 'unclear' | 'paired'.
 * 'unclear' = PIN aceito mas nenhum uuid novo no prazo (celular lento OU o mesmo celular já constava na lista): NÃO é erro.
 */
export async function pairByPin({ pin, name = '', mask, listClients, postPin, setPerm, sleep, now = Date.now, timeoutMs = 8000, intervalMs = 500, onStage = () => {} }) {
  onStage('snapshot');
  const first = await listClients();
  if (!Array.isArray(first)) return { status: 'snapshot_failed' };
  const before = uuidsOf(first);

  onStage('sending');
  const sent = await postPin(pin, name);
  if (!sent || !sent.ok) return { status: sent && sent.offline ? 'offline' : 'pin_error', error: (sent && sent.error) || '' };
  if (!sent.accepted) return { status: 'rejected' };

  onStage('waiting');
  const start = now();
  for (;;) {
    const list = await listClients();
    if (Array.isArray(list)) {
      const d = decideNewDevices(before, list);
      if (d.kind !== 'none') {
        onStage('applying');
        return promoteNewDevice({ before, list, mask, setPerm });
      }
    }
    if (now() - start >= timeoutMs) break;
    await sleep(intervalMs);
  }
  return { status: 'unclear' };
}

/* ---------- Frase-senha do OTP ---------- */
/** Inteiro uniforme em [0, max) com o gerador seguro do sistema (amostragem com rejeição: sem viés). */
export function secureRandomInt(max) {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('Este ambiente não tem gerador seguro de números aleatórios.');
  if (!Number.isInteger(max) || max < 1 || max > 256) throw new RangeError('max deve estar entre 1 e 256');
  const limit = 256 - (256 % max);
  const buf = new Uint8Array(1);
  for (;;) {
    c.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/** Frase-senha aleatória [0-9a-zA-Z] (o painel original exige 4 ou mais; usamos 8 porque ninguém precisa digitá-la). */
export function generatePassphrase(length = 8, randomInt = secureRandomInt) {
  if (!Number.isInteger(length) || length < 4 || length > 64) throw new RangeError('A frase-senha precisa ter de 4 a 64 caracteres.');
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
export const isValidPassphrase = (s) => /^[0-9a-zA-Z]{4,}$/.test(String(s ?? ''));

/* ---------- Link de pareamento (OTP) ---------- */
function isValidIpv4(s) {
  const p = s.split('.');
  return p.length === 4 && p.every((x) => /^[0-9]{1,3}$/.test(x) && Number(x) <= 255);
}
/** Endereço aceitável para o link: IPv4, IPv6 (com ou sem colchetes) ou nome de rede. Sem espaços, barras ou texto solto. */
export function isValidHost(host) {
  const s = String(host ?? '').trim();
  if (!s || s.length > 253) return false;
  const bare = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  if (bare.includes(':')) return /^[0-9a-fA-F:.]+$/.test(bare) && (bare.match(/:/g) || []).length >= 2;
  if (s.startsWith('[') || s.endsWith(']')) return false;
  if (/^[0-9.]+$/.test(s)) return isValidIpv4(s);
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(s);
}
export const isValidPort = (p) => /^[0-9]{1,5}$/.test(String(p ?? '').trim()) && Number(p) >= 1 && Number(p) <= 65535;

/**
 * art://HOST:PORTA?pin=OTP&passphrase=FRASE[&name=NOME_DO_PC]. Cada valor é codificado separadamente (o painel original usava
 * encodeURI no texto todo e quebrava com "&" ou "#" no nome do PC). Devolve {ok:true, link} ou {ok:false, error}.
 */
export function buildPairLink({ host, port, otp, passphrase, name = '' }) {
  const h = String(host ?? '').trim();
  if (!isValidHost(h)) return { ok: false, error: 'Endereço do PC inválido. Use algo como 192.168.0.10.' };
  if (!isValidPort(port)) return { ok: false, error: 'Porta inválida (use um número de 1 a 65535).' };
  if (!/^[0-9]{4}$/.test(String(otp ?? ''))) return { ok: false, error: 'O código OTP deve ter 4 números.' };
  if (!isValidPassphrase(passphrase)) return { ok: false, error: 'Frase-senha inválida.' };
  const hostPart = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
  let link = `art://${hostPart}:${Number(port)}?pin=${otp}&passphrase=${passphrase}`;
  const n = String(name ?? '').trim();
  if (n) link += `&name=${encodeURIComponent(n)}`;
  return { ok: true, link };
}

/** Porta do link = porta do painel web menos 1 (https://localhost:47990 -> 47989). Se não der para ler, usa a padrão. */
export function pairPortFromUrl(url) {
  try {
    const p = Number(new URL(String(url)).port);
    if (Number.isInteger(p) && p >= 2 && p <= 65535) return p - 1;
  } catch { /* cai no padrão */ }
  return DEFAULT_PAIR_PORT;
}

const KIND_ORDER = ['wifi', 'lan', 'tailscale', 'vpn'];
const KIND_LABEL = { wifi: 'Wi-Fi', lan: 'Rede local', tailscale: 'Tailscale', vpn: 'VPN' };
/**
 * Endereços do PC que o celular pode usar, do mais provável ao menos. `ips` vem da ponte nativa ({name, ip, kind}); `apiIp` é a sugestão
 * do servidor (pode vir vazia ou ser a placa errada em PCs com VPN, por isso a lista inteira fica disponível).
 */
export function hostCandidates(ips, apiIp = '') {
  const seen = new Set();
  const out = [];
  const add = (ip, kind) => {
    const s = String(ip ?? '').trim();
    if (!s || seen.has(s) || !isValidHost(s) || s.startsWith('169.254.')) return;
    seen.add(s);
    out.push({ ip: s, kind, label: KIND_LABEL[kind] || (kind === 'api' ? 'Sugerido pelo R3D PLAY' : 'Outra rede') });
  };
  const rank = (k) => { const i = KIND_ORDER.indexOf(k); return i < 0 ? KIND_ORDER.length : i; };
  [...(Array.isArray(ips) ? ips : [])].filter((x) => x && typeof x.ip === 'string')
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .forEach((x) => add(x.ip, KIND_ORDER.includes(x.kind) ? x.kind : 'other'));
  add(apiIp, 'api');
  const api = String(apiIp ?? '').trim();
  // A sugestão do servidor só vence se for uma placa que o app nativo também listou (e que não seja VPN/Tailscale); senão vale a melhor da lista.
  const recommended = out.find((c) => c.ip === api && c.kind !== 'api' && c.kind !== 'tailscale' && c.kind !== 'vpn') || out[0] || null;
  return out.map((c) => ({ ...c, recommended: recommended === c }));
}

/* ---------- Validade do OTP ---------- */
/** Segundos que faltam (arredondado para cima, nunca negativo). createdAt/now em milissegundos. */
export function otpSecondsLeft(createdAt, now, ttl = OTP_TTL_SECONDS) {
  const left = Math.ceil((Number(createdAt) + ttl * 1000 - Number(now)) / 1000);
  return Number.isFinite(left) ? Math.max(0, Math.min(ttl, left)) : 0;
}
/** 125 -> "2:05". */
export function formatCountdown(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
