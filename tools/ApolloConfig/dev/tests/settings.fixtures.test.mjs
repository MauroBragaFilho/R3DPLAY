// Apoio dos testes de settings*: lê os schemas reais do disco e simula o que o servidor faz com o corpo do POST.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, SCHEMA_FILES } from '../../ui/js/lib/schema.js';
import { sortKeysDeep } from '../../ui/js/lib/serialize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DIR = path.resolve(HERE, '..', '..', 'ui', 'schema');
export const readSchema = (name) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${name}.json`), 'utf8'));

export function loadRaws() {
  return Object.fromEntries(SCHEMA_FILES.map((f) => [f, readSchema(f)]));
}
export const catalog = buildCatalog(loadRaws());

/**
 * Como o servidor grava (saveConfig) e lê de volta (parse_option/to_string em src/config.cpp): descarta ""/null, texto cru, o resto vira
 * JSON compacto com chaves ordenadas; ao LER, tudo a partir de um "#" até o fim da linha é comentário (o valor é cortado ali).
 * Devolve o que o GET devolveria.
 */
export function serverWrite(body) {
  const file = {};
  for (const k of Object.keys(body).sort()) {
    const v = body[k];
    if (v === null || v === '' || v === undefined) continue;
    const text = typeof v === 'string' ? v : JSON.stringify(sortKeysDeep(v));
    const read = text.replace(/#[^\r\n]*/g, '');
    if (read.trim() === '') continue;
    file[k] = read;
  }
  return file;
}
