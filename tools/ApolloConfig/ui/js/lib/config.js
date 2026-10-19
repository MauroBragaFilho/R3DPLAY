// Leitura e gravação de sunshine.conf pela API (/api/config), seguindo as regras de ui/schema/_serializacao.md:
// - GET devolve o conteúdo do arquivo (strings; booleanos "enabled"/"disabled"; listas como texto JSON) + 4 chaves de METADADOS
//   (status, platform, version, vdisplayStatus) que NUNCA podem voltar no POST;
// - POST SUBSTITUI o arquivo inteiro: sempre GET → mesclar → POST, e o servidor descarta "" e null;
// - nenhuma string pode ter \n ou \r (injetaria chaves no .conf); todas as chaves só valem após reiniciar.
import { api, state } from '../core.js';

export const META_KEYS = ['status', 'platform', 'version', 'vdisplayStatus'];

/** Separa o objeto de GET /api/config em valores (arquivo) e metadados. Puro. */
export function splitConfig(raw) {
  const values = {};
  const meta = {};
  for (const [k, v] of Object.entries(raw || {})) (META_KEYS.includes(k) ? meta : values)[k] = v;
  return { values, meta };
}

/** Compara um valor que queremos gravar com o que o servidor devolveu (strings no arquivo; listas como JSON em texto). Puro. */
export function sameValue(want, got) {
  if (want !== null && typeof want === 'object') {
    try { return JSON.stringify(want) === JSON.stringify(typeof got === 'string' ? JSON.parse(got) : got); } catch { return false; }
  }
  return String(want) === String(got);
}

/** Valida um valor antes de gravar. Devolve null se estiver ok ou o motivo (PT-BR). Puro. */
export function checkValue(key, v) {
  if (typeof v === 'string' && /[\r\n]/.test(v)) return `"${key}": o valor não pode ter quebra de linha.`;
  return null;
}

/** GET /api/config → {ok, status, values, meta}. Atualiza state.meta. */
export async function readConfig() {
  const r = await api('GET', '/api/config');
  if (!r.ok || !r.json) return { ok: false, status: r.status, values: {}, meta: {} };
  const { values, meta } = splitConfig(r.json);
  state.meta = { ...state.meta, ...meta };
  return { ok: true, status: r.status, values, meta };
}

/**
 * Grava o arquivo inteiro (values = TODAS as chaves, sem metadados) e confere com um GET (armadilha nº 10: status:true sem gravar).
 * Valores ''/null/undefined são removidos. Devolve {ok, error?, values?}.
 */
export async function writeConfig(values) {
  const body = {};
  for (const [k, v] of Object.entries(values)) {
    if (META_KEYS.includes(k) || v === '' || v === null || v === undefined) continue;
    const bad = checkValue(k, v);
    if (bad) return { ok: false, error: bad };
    body[k] = v;
  }
  const r = await api('POST', '/api/config', body);
  if (!r.ok || !r.json?.status) return { ok: false, error: r.status === 0 ? 'O servidor não respondeu.' : `O servidor recusou a configuração (HTTP ${r.status}).` };
  const chk = await readConfig();
  if (!chk.ok) return { ok: false, error: 'Salvou, mas não consegui reler a configuração para conferir.' };
  const lost = Object.entries(body).filter(([k, v]) => !sameValue(v, chk.values[k])).map(([k]) => k);
  if (lost.length) return { ok: false, error: `O servidor não gravou: ${lost.join(', ')}.` };
  return { ok: true, values: chk.values };
}

/** Altera só as chaves indicadas (valor null/'' remove a chave), preservando todas as outras. Sempre relê antes de gravar. */
export async function patchConfig(changes) {
  const cur = await readConfig();
  if (!cur.ok) return { ok: false, error: 'Não consegui ler a configuração atual.' };
  const next = { ...cur.values };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined || v === '') delete next[k];
    else next[k] = v;
  }
  return writeConfig(next);
}
