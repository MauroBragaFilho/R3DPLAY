// Gerador de QR code próprio (sem biblioteca): modo "bytes" (UTF-8), níveis de correção L/M/Q/H, versões 1 a 40, máscara escolhida
// pela menor penalidade. Lógica PURA: devolve a matriz de módulos; quem desenha (SVG) é a tela. Segue a norma ISO/IEC 18004.
// Verificação: dev/tests/devices-qr.test.mjs confere a estrutura (padrões de busca, sincronismo, informação de formato/versão por BCH,
// síndromes de Reed-Solomon zeradas) e, quando o Python com OpenCV está instalado, decodifica as matrizes com um decodificador de
// terceiros (cv2.QRCodeDetector) em todas as versões e níveis.
'use strict';

const LEVEL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };   // 2 bits do nível dentro da informação de formato

// Palavras-código de correção por bloco e número de blocos, por nível (L, M, Q, H) e versão (índice 0 não é usado).
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/* ---------- Capacidade ---------- */
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const a = Math.floor(ver / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
function dataCodewords(ver, lvl) {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[lvl][ver] * NUM_BLOCKS[lvl][ver];
}
const countBits = (ver) => (ver <= 9 ? 8 : 16);   // tamanho do campo "quantos bytes" no modo bytes

/** Quantos bytes UTF-8 cabem numa versão e num nível (L/M/Q/H). */
export function byteCapacity(version, ecc = 'M') {
  const lvl = LEVEL_INDEX[ecc];
  if (lvl === undefined || !Number.isInteger(version) || version < 1 || version > 40) throw new RangeError('versão ou nível inválido');
  return Math.floor((dataCodewords(version, lvl) * 8 - 4 - countBits(version)) / 8);
}

/** Estrutura de blocos de uma versão/nível (usada pelos testes para reler a matriz de forma independente). */
export function qrBlockInfo(version, ecc = 'M') {
  const lvl = LEVEL_INDEX[ecc];
  if (lvl === undefined || !Number.isInteger(version) || version < 1 || version > 40) throw new RangeError('versão ou nível inválido');
  return { totalCodewords: Math.floor(rawModules(version) / 8), dataCodewords: dataCodewords(version, lvl), numBlocks: NUM_BLOCKS[lvl][version], eccPerBlock: ECC_PER_BLOCK[lvl][version] };
}

/* ---------- Reed-Solomon sobre GF(256), polinômio 0x11D ---------- */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < degree) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, divisor) {
  const r = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ r.shift();
    r.push(0);
    divisor.forEach((coef, i) => { r[i] ^= gfMul(coef, factor); });
  }
  return r;
}

/** Divide os dados em blocos, calcula a correção de cada um e intercala (ordem da norma). */
function addEccAndInterleave(data, ver, lvl) {
  const nBlocks = NUM_BLOCKS[lvl][ver];
  const eccLen = ECC_PER_BLOCK[lvl][ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);   // posição vazia dos blocos curtos (pulada na intercalação)
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(b[i]); });
  }
  return out;
}

/* ---------- Desenho da matriz ---------- */
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const pos = [6];
  for (let p = ver * 4 + 10; pos.length < n; p -= step) pos.splice(1, 0, p);
  return pos;
}
const bit = (v, i) => ((v >>> i) & 1) !== 0;

/** Masks da norma: devolve true quando o módulo (x, y) deve ser invertido. */
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
];

/** Penalidade da norma (regras 1 a 4); a máscara com menor soma é a escolhida. */
function penalty(m, size) {
  let score = 0;
  for (const get of [(a, b) => m[a][b], (a, b) => m[b][a]]) {   // linhas e depois colunas
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b <= size; b++) {
        if (b < size && get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      for (let b = 0; b + 11 <= size; b++) {   // regra 3: 1:1:3:1:1 com 4 módulos claros de um lado
        let p1 = true;
        let p2 = true;
        const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
        for (let k = 0; k < 11 && (p1 || p2); k++) {
          const v = get(a, b + k) ? 1 : 0;
          if (v !== A[k]) p1 = false;
          if (v !== A[10 - k]) p2 = false;
        }
        if (p1) score += 40;
        if (p2) score += 40;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * Gera o QR code de um texto. Devolve {version, size, ecc, mask, modules} onde modules[y][x] é 1 (escuro) ou 0 (claro).
 * opts: ecc 'L'|'M'|'Q'|'H' (padrão 'M'), minVersion/maxVersion (1..40), mask 0..7 (padrão: automática).
 * Lança RangeError se o texto não couber.
 */
export function encodeQr(text, { ecc = 'M', minVersion = 1, maxVersion = 40, mask = -1 } = {}) {
  const lvl = LEVEL_INDEX[ecc];
  if (lvl === undefined) throw new RangeError('Nível de correção inválido (use L, M, Q ou H).');
  if (!Number.isInteger(mask) || mask < -1 || mask > 7) throw new RangeError('Máscara inválida (0 a 7).');
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let ver = Math.max(1, minVersion);
  for (;; ver++) {
    if (ver > Math.min(40, maxVersion)) throw new RangeError('O texto é grande demais para um QR code.');
    if (4 + countBits(ver) + bytes.length * 8 <= dataCodewords(ver, lvl) * 8) break;
  }

  // Fluxo de bits: modo (0100 = bytes), quantidade, dados, terminador, preenchimento (0xEC, 0x11 alternados).
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4);
  put(bytes.length, countBits(ver));
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver, lvl) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const codewords = addEccAndInterleave(data, ver, lvl);

  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));   // módulos de função (não recebem dados nem máscara)
  const setFn = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }   // sincronismo
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const ap = alignmentPositions(ver);
  for (let i = 0; i < ap.length; i++) {
    for (let j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;   // cantos dos buscadores
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (msk) => {
    const d = (FORMAT_BITS[ecc] << 3) | msk;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(b, i));
    setFn(8, 7, bit(b, 6)); setFn(8, 8, bit(b, 7)); setFn(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(b, i));
    setFn(8, size - 8, true);   // módulo escuro fixo
  };
  drawFormat(0);   // reserva a área (o valor real vem depois da escolha da máscara)
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      setFn(a, c, bit(b, i)); setFn(c, a, bit(b, i));
    }
  }

  // Dados em zigue-zague, de baixo para cima e vice-versa, de dois em dois módulos, pulando a coluna de sincronismo.
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
        if (!fn[y][x] && k < codewords.length * 8) { m[y][x] = bit(codewords[k >>> 3], 7 - (k & 7)); k++; }
      }
    }
  }

  const apply = (msk) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[msk](x, y)) m[y][x] = !m[y][x];
  };
  let best = mask;
  if (best === -1) {
    let min = Infinity;
    for (let i = 0; i < 8; i++) {
      apply(i); drawFormat(i);
      const p = penalty(m, size);
      if (p < min) { min = p; best = i; }
      apply(i);   // desfaz
    }
  }
  apply(best);
  drawFormat(best);
  return { version: ver, size, ecc, mask: best, modules: m.map((row) => row.map((v) => (v ? 1 : 0))) };
}

/** Caminho SVG (atributo d) com os módulos escuros, em unidades de módulo, deslocado pela margem. Agrupa sequências horizontais. */
export function qrPath(qr, margin = 4) {
  const parts = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y][x]) { x++; continue; }
      let run = 1;
      while (x + run < qr.size && qr.modules[y][x + run]) run++;
      parts.push(`M${x + margin} ${y + margin}h${run}v1h-${run}z`);
      x += run;
    }
  }
  return parts.join('');
}

/** Lado total (em módulos) do desenho com a margem silenciosa de cada lado (a norma pede 4). */
export const qrViewSize = (qr, margin = 4) => qr.size + margin * 2;

/** Versão em texto (para depurar): "##" escuro, "  " claro. */
export function qrToText(qr) {
  return qr.modules.map((row) => row.map((v) => (v ? '##' : '  ')).join('')).join('\n');
}
