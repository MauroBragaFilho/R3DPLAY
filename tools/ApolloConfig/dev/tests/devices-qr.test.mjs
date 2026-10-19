// Testes de ui/js/lib/qr.js (gerador de QR code próprio).
// 1) Estrutura da norma, conferida de forma independente (buscadores, sincronismo, formato/versão por BCH, módulos de dados = códigos + resto).
// 2) Releitura da matriz com um leitor próprio, escrito aqui com tabelas de Galois próprias: desmascara, desintercala, confere as
//    síndromes de Reed-Solomon (todas zero) e o texto, em todas as 40 versões e 4 níveis de correção.
// 3) Se houver Python com OpenCV, decodifica as matrizes com cv2.QRCodeDetector (decodificador de terceiros).
// Rodar: node --test tools/ApolloConfig/dev/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { encodeQr, byteCapacity, qrBlockInfo, qrPath, qrViewSize, qrToText } from '../../ui/js/lib/qr.js';

const LEVELS = ['L', 'M', 'Q', 'H'];
const FMT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const utf8 = (s) => [...new TextEncoder().encode(s)];

/* ---------- Gerador de textos reproduzível ---------- */
let seed = 20240607;
const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#[]@!$&()*+,;=% áéíóúçãõ—✓';
const randomText = (bytes, alphabet = ALPHA) => {
  let s = '';
  const chars = [...alphabet];
  while (utf8(s).length < bytes) {
    const c = chars[rnd(chars.length)];
    if (utf8(s + c).length > bytes) s += 'x'; else s += c;
  }
  return s;
};

const ASCII = ALPHA.slice(0, ALPHA.indexOf(' á'));   // o link do app é sempre ASCII (o nome do PC vai com %XX), então o decodificador de terceiros recebe ASCII
/* ---------- Leitor independente ---------- */
const EXP = new Array(512);
const LOG = new Array(256);
{ let v = 1; for (let i = 0; i < 255; i++) { EXP[i] = v; LOG[v] = i; v <<= 1; if (v & 0x100) v ^= 0x11D; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function bchFormat(ecc, mask) {
  const d = (FMT_BITS[ecc] << 3) | mask;
  let r = d << 10;
  for (let i = 14; i >= 10; i--) if (r & (1 << i)) r ^= 0x537 << (i - 10);
  return ((d << 10) | r) ^ 0x5412;
}
function bchVersion(ver) {
  let r = ver << 12;
  for (let i = 17; i >= 12; i--) if (r & (1 << i)) r ^= 0x1F25 << (i - 12);
  return (ver << 12) | r;
}
const alignCenters = (ver) => {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let p = size - 7; out.length < n; p -= step) out.splice(1, 0, p);
  return out;
};
const REMAINDER_BITS = (ver) => (ver === 1 ? 0 : ver <= 6 ? 7 : ver <= 13 ? 0 : ver <= 20 ? 3 : ver <= 27 ? 4 : ver <= 34 ? 3 : 0);

function functionMap(ver) {
  const size = ver * 4 + 17;
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = true; };
  mark(0, 0, 8, 8); mark(size - 8, 0, size - 1, 8); mark(0, size - 8, 8, size - 1);   // buscadores + separadores + formato
  mark(6, 0, 6, size - 1); mark(0, 6, size - 1, 6);                                   // sincronismo
  const c = alignCenters(ver);
  for (let i = 0; i < c.length; i++) for (let j = 0; j < c.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === c.length - 1) || (i === c.length - 1 && j === 0)) continue;
    mark(c[i] - 2, c[j] - 2, c[i] + 2, c[j] + 2);
  }
  if (ver >= 7) { mark(size - 11, 0, size - 9, 5); mark(0, size - 11, 5, size - 9); }   // informação de versão
  return fn;
}
const MASKFN = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
];

/** Lê a matriz: confere formato/versão e devolve {bytes, mask, ecc} ou lança. */
function readQr(qr) {
  const m = qr.modules;
  const size = qr.size;
  const ver = (size - 17) / 4;
  assert.ok(Number.isInteger(ver) && ver >= 1 && ver <= 40, 'tamanho de versão válida');
  assert.equal(ver, qr.version);
  // formato: duas cópias
  const fmt1 = [];
  for (let i = 0; i <= 5; i++) fmt1[i] = m[i][8];
  fmt1[6] = m[7][8]; fmt1[7] = m[8][8]; fmt1[8] = m[8][7];
  for (let i = 9; i < 15; i++) fmt1[i] = m[8][14 - i];
  const fmt2 = [];
  for (let i = 0; i < 8; i++) fmt2[i] = m[8][size - 1 - i];
  for (let i = 8; i < 15; i++) fmt2[i] = m[size - 15 + i][8];
  const word = (bits) => bits.reduce((a, b, i) => a | (b << i), 0);
  assert.equal(word(fmt1), word(fmt2), 'as duas cópias da informação de formato são iguais');
  assert.equal(word(fmt1), bchFormat(qr.ecc, qr.mask), 'formato = BCH(nível, máscara)');
  assert.equal(m[size - 8][8], 1, 'módulo escuro fixo');
  // versão
  if (ver >= 7) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 18; i++) {
      a |= m[Math.floor(i / 3)][size - 11 + (i % 3)] << i;
      b |= m[size - 11 + (i % 3)][Math.floor(i / 3)] << i;
    }
    assert.equal(a, bchVersion(ver), 'informação de versão (canto superior direito)');
    assert.equal(b, bchVersion(ver), 'informação de versão (canto inferior esquerdo)');
  }
  // dados em zigue-zague
  const fn = functionMap(ver);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
        if (fn[y][x]) continue;
        bits.push(m[y][x] ^ (MASKFN[qr.mask](x, y) ? 1 : 0));
      }
    }
  }
  const info = qrBlockInfo(ver, qr.ecc);
  assert.equal(bits.length, info.totalCodewords * 8 + REMAINDER_BITS(ver), `v${ver}: módulos de dados = palavras-código*8 + bits restantes`);
  const cw = [];
  for (let i = 0; i < info.totalCodewords; i++) cw.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  // desintercala
  const B = info.numBlocks;
  const E = info.eccPerBlock;
  const shortLen = Math.floor(info.totalCodewords / B);
  const nShort = B - (info.totalCodewords % B);
  const blocks = Array.from({ length: B }, () => []);
  const dataLen = (j) => shortLen - E + (j < nShort ? 0 : 1);
  let k = 0;
  for (let i = 0; i < shortLen - E + 1; i++) for (let j = 0; j < B; j++) if (i < dataLen(j)) blocks[j].push(cw[k++]);
  for (let i = 0; i < E; i++) for (let j = 0; j < B; j++) blocks[j].push(cw[k++]);
  assert.equal(k, info.totalCodewords);
  // síndromes de Reed-Solomon zeradas em cada bloco
  for (const [j, blk] of blocks.entries()) {
    for (let s = 0; s < E; s++) {
      let acc = 0;
      for (const c of blk) acc = gmul(acc, EXP[s]) ^ c;
      assert.equal(acc, 0, `v${ver} ${qr.ecc}: síndrome ${s} do bloco ${j} deveria ser 0`);
    }
  }
  const data = blocks.flatMap((blk, j) => blk.slice(0, dataLen(j)));
  assert.equal(data.length, info.dataCodewords);
  // fluxo de bits: modo 0100, quantidade, bytes, terminador e preenchimento
  const stream = data.flatMap((c) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (c >> i) & 1));
  const take = (n) => stream.splice(0, n).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(take(4), 4, 'modo bytes (0100)');
  const count = take(ver <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < count; i++) bytes.push(take(8));
  const term = stream.splice(0, Math.min(4, stream.length));
  assert.ok(term.every((b) => b === 0), 'terminador de zeros');
  while (stream.length % 8) assert.equal(stream.shift(), 0, 'zeros até fechar o byte');
  for (let pad = 0xEC; stream.length; pad ^= 0xEC ^ 0x11) assert.equal(take(8), pad, 'bytes de preenchimento alternados 0xEC/0x11');
  return { bytes, ver };
}

/* ---------- Testes ---------- */
test('capacidade em bytes: valores conhecidos da norma', () => {
  const known = {
    1: [17, 14, 11, 7], 2: [32, 26, 20, 14], 3: [53, 42, 32, 24], 4: [78, 62, 46, 34], 5: [106, 84, 60, 44],
    7: [154, 122, 86, 64], 10: [271, 213, 151, 119], 20: [858, 666, 482, 382], 30: [1732, 1370, 982, 742], 40: [2953, 2331, 1663, 1273],
  };
  for (const [v, caps] of Object.entries(known)) LEVELS.forEach((l, i) => assert.equal(byteCapacity(Number(v), l), caps[i], `v${v}-${l}`));
  assert.throws(() => byteCapacity(0, 'M'), RangeError);
  assert.throws(() => byteCapacity(41, 'M'), RangeError);
  assert.throws(() => byteCapacity(1, 'X'), RangeError);
});

test('escolhe a menor versão que cabe e respeita min/max', () => {
  for (const l of LEVELS) {
    for (let v = 1; v <= 40; v++) {
      const cap = byteCapacity(v, l);
      assert.equal(encodeQr('a'.repeat(cap), { ecc: l }).version, v, `${cap} bytes em ${l}`);
      if (v < 40) assert.equal(encodeQr('a'.repeat(cap + 1), { ecc: l }).version, v + 1, `${cap + 1} bytes em ${l}`);
      if (v >= 5) break;   // o resto da varredura é coberto pelo teste de releitura
    }
  }
  assert.equal(encodeQr('oi', { minVersion: 7 }).version, 7);
  assert.throws(() => encodeQr('a'.repeat(byteCapacity(5, 'M') + 1), { ecc: 'M', maxVersion: 5 }), RangeError);
});

test('erros: texto grande demais, nível e máscara inválidos', () => {
  assert.throws(() => encodeQr('a'.repeat(2954), { ecc: 'L' }), /grande demais/);
  assert.throws(() => encodeQr('a'.repeat(2332), { ecc: 'M' }), /grande demais/);
  assert.throws(() => encodeQr('x', { ecc: 'Z' }), /Nível/);
  assert.throws(() => encodeQr('x', { ecc: 'm' }), /Nível/, 'só maiúsculas');
  assert.throws(() => encodeQr('x', { mask: 8 }), /Máscara/);
  assert.throws(() => encodeQr('x', { mask: -2 }), /Máscara/);
  assert.throws(() => encodeQr('x', { mask: 1.5 }), /Máscara/);
  assert.throws(() => encodeQr('x', { minVersion: 41 }), RangeError);
});

test('texto vazio, null e undefined geram um QR válido (versão 1)', () => {
  for (const t of ['', null, undefined]) {
    const q = encodeQr(t);
    assert.equal(q.version, 1);
    assert.equal(q.size, 21);
    assert.equal(readQr(q).bytes.length, 0);
  }
});

test('estrutura: buscadores, separadores, sincronismo e tamanho', () => {
  for (const text of ['a', 'art://192.168.0.10:47989?pin=4821&passphrase=aB3dE9xZ&name=MNBF-NEON', 'x'.repeat(300)]) {
    const q = encodeQr(text);
    const n = q.size;
    assert.equal(n, q.version * 4 + 17);
    assert.equal(q.modules.length, n);
    assert.ok(q.modules.every((r) => r.length === n && r.every((v) => v === 0 || v === 1)));
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {   // buscador 7x7: borda escura, anel claro, centro 3x3 escuro
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.equal(q.modules[oy + y][ox + x], d === 2 ? 0 : 1, `buscador em (${ox},${oy}) módulo (${x},${y})`);
      }
    }
    for (let i = 8; i < n - 8; i++) {
      assert.equal(q.modules[6][i], i % 2 === 0 ? 1 : 0, 'sincronismo horizontal');
      assert.equal(q.modules[i][6], i % 2 === 0 ? 1 : 0, 'sincronismo vertical');
    }
    for (let i = 0; i < 8; i++) {   // separadores claros ao redor dos buscadores
      assert.equal(q.modules[7][i], 0); assert.equal(q.modules[i][7], 0);
      assert.equal(q.modules[7][n - 1 - i], 0); assert.equal(q.modules[i][n - 8], 0);
      assert.equal(q.modules[n - 8][i], 0); assert.equal(q.modules[n - 1 - i][7], 0);
    }
  }
});

test('determinismo e máscara forçada', () => {
  const t = 'art://192.168.0.10:47989?pin=4821&passphrase=aB3dE9xZ';
  assert.deepEqual(encodeQr(t), encodeQr(t));
  const seen = new Set();
  for (let mk = 0; mk < 8; mk++) {
    const q = encodeQr(t, { mask: mk });
    assert.equal(q.mask, mk);
    seen.add(JSON.stringify(q.modules));
    readQr(q);
  }
  assert.equal(seen.size, 8, 'cada máscara produz uma matriz diferente');
  const auto = encodeQr(t);
  assert.ok(auto.mask >= 0 && auto.mask <= 7);
});

test('UTF-8: acentos, símbolos e emoji viram os bytes certos', () => {
  for (const t of ['Olá, çãõ', 'PC da Sala — Ç ✓', '日本語のテキスト', '📱🎮', 'art://x?name=' + encodeURIComponent('Sala & Quarto #1')]) {
    const q = encodeQr(t, { ecc: 'Q' });
    assert.deepEqual(readQr(q).bytes, utf8(t));
  }
});

test('releitura independente: 40 versões x 4 níveis, lotado e meio cheio — formato, versão, síndromes e texto conferem', () => {
  for (let v = 1; v <= 40; v++) {
    for (const l of LEVELS) {
      const cap = byteCapacity(v, l);
      for (const len of v <= 12 ? [cap, Math.max(1, Math.floor(cap / 2))] : [cap]) {
        const text = randomText(len);
        const q = encodeQr(text, { ecc: l, minVersion: v, maxVersion: v });
        assert.equal(q.version, v);
        const r = readQr(q);
        assert.deepEqual(r.bytes, utf8(text), `v${v}-${l}, ${len} bytes`);
      }
    }
  }
});

test('qrPath: cobre exatamente os módulos escuros, com margem', () => {
  const q = encodeQr('art://192.168.0.10:47989?pin=1234&passphrase=abcd1234');
  for (const margin of [0, 4]) {
    const d = qrPath(q, margin);
    const grid = new Set();
    const re = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
    let m;
    let count = 0;
    while ((m = re.exec(d))) {
      assert.equal(m[3], m[4]);
      for (let i = 0; i < Number(m[3]); i++) { const key = `${Number(m[1]) + i},${m[2]}`; assert.ok(!grid.has(key), 'sem sobreposição'); grid.add(key); count++; }
    }
    assert.equal(d.replace(re, ''), '', 'o caminho só tem comandos conhecidos');
    let dark = 0;
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) {
      if (q.modules[y][x]) { dark++; assert.ok(grid.has(`${x + margin},${y + margin}`), `módulo escuro (${x},${y})`); }
    }
    assert.equal(count, dark, 'nenhum módulo claro foi desenhado');
  }
  assert.equal(qrViewSize(q, 4), q.size + 8);
  assert.equal(qrViewSize(q, 0), q.size);
  assert.equal(qrToText(q).split('\n').length, q.size);
});

/* ---------- Decodificador de terceiros (opcional) ---------- */
const PY = `
import sys, json
try:
    import numpy as np, cv2
except Exception:
    print("NOCV2"); sys.exit(0)
cases = json.load(sys.stdin)
dets = [cv2.QRCodeDetector()]
try: dets.append(cv2.QRCodeDetectorAruco())
except Exception: pass
def render(mods, scale, margin=4):
    n = len(mods)
    img = np.full(((n + 2*margin) * scale, (n + 2*margin) * scale), 255, np.uint8)
    for y, row in enumerate(mods):
        for x, v in enumerate(row):
            if v: img[(y+margin)*scale:(y+margin+1)*scale, (x+margin)*scale:(x+margin+1)*scale] = 0
    return img
out = []
for c in cases:
    ok = False
    # O detector do OpenCV é caprichoso com imagens sintéticas: tenta alguns tamanhos e os dois detectores; basta um acertar o texto exato.
    for scale in (8, 6, 10, 5, 12, 4, 7):
        img = render(c['modules'], scale)
        for d in dets:
            try: val = d.detectAndDecode(img)[0]
            except Exception: val = ''
            if val == c['text']: ok = True; break
        if ok: break
    out.append(ok)
print(json.dumps(out))
`;

test('decodificador de terceiros (OpenCV), se disponível: decodifica o texto exato', (t) => {
  const texts = [
    'art://192.168.0.10:47989?pin=4821&passphrase=aB3dE9xZ&name=MNBF-NEON',
    'art://192.168.100.100:47989?pin=0123&passphrase=Zz9Yy8Xx&name=' + encodeURIComponent('PC da Sala & Quarto #1 — ção'),
    'art://[fe80::1]:47989?pin=9999&passphrase=abcd1234',
  ];
  const cases = [];
  for (const text of texts) for (const l of LEVELS) cases.push({ text, modules: encodeQr(text, { ecc: l }).modules });
  // todas as versões 1..20 e algumas maiores, lotadas, nos 4 níveis (a versão 21-L é omitida: o OpenCV não a decodifica nem a gerada por ele mesmo)
  for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 25, 30, 35, 40]) {
    for (const l of LEVELS) {
      const text = randomText(byteCapacity(v, l), ASCII);
      cases.push({ text, modules: encodeQr(text, { ecc: l, minVersion: v, maxVersion: v }).modules });
    }
  }
  const why = [];
  for (const py of ['python', 'py']) {
    const run = spawnSync(py, ['-c', PY], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 28, timeout: 240000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    if (run.error || run.status !== 0) { why.push(`${py}: ${run.error ? run.error.message : `código ${run.status} ${String(run.stderr).slice(-300)}`}`); continue; }
    if (run.stdout.trim() === 'NOCV2') { why.push(`${py}: sem cv2`); continue; }
    const got = JSON.parse(run.stdout);
    assert.equal(got.length, cases.length);
    const bad = cases.map((c, i) => (got[i] === true ? null : i)).filter((i) => i !== null);
    assert.deepEqual(bad, [], `casos que o OpenCV não decodificou igual: ${bad.map((i) => `#${i} (${cases[i].text.length} caracteres)`).join(', ')}`);
    return;
  }
  t.skip(`Python com OpenCV (cv2) não disponível, pulando a verificação com decodificador de terceiros (${why.join(' | ')})`);
});
