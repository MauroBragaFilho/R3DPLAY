// Testes da lógica pura do Registro (ui/js/lib/logs.js). Rode com: node --test tools/ApolloConfig/dev/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVELS, FILTERS, filterById, parseTime, parseLog, entryMessage, entryLines, entryClock, normalizeQuery, filterEntries,
  countByLevel, countAtLeast, summarizeIssues, describeIssues, formatAge, plural, clipText, limitLines, highlightParts,
  entriesToText, describeMinLogLevel, describeLogLevelHint, NOISE_REPEATS, RECENT_MS,
} from '../../ui/js/lib/logs.js';

const L = (time, level, msg) => `[2026-10-19 ${time}]: ${level}: ${msg}`;
const SAMPLE = [
  L('14:00:01.100', 'Info', 'Sunshine version: v1'),
  L('14:00:02.200', 'Debug', 'Monitor 0: {'),
  '  "name": "DELL",',
  '  "id": 7',
  '}',
  L('14:00:03.300', 'Warning', 'Sem controle conectado'),
  L('14:00:04.400', 'Error', 'Falha ao abrir o codificador'),
  L('14:00:05.500', 'Fatal', 'Não foi possível iniciar o vídeo'),
  L('14:00:06.600', 'Verbose', 'detalhe'),
].join('\r\n') + '\r\n';

/* ---------- parseTime ---------- */
test('parseTime lê a hora local e rejeita datas impossíveis', () => {
  const t = parseTime('2026-10-19 14:00:01.100');
  const d = new Date(t);
  assert.equal(d.getFullYear(), 2026); assert.equal(d.getMonth(), 9); assert.equal(d.getDate(), 19);
  assert.equal(d.getHours(), 14); assert.equal(d.getSeconds(), 1); assert.equal(d.getMilliseconds(), 100);
  assert.equal(parseTime('2026-02-31 10:00:00.000'), null);   // 31 de fevereiro
  assert.equal(parseTime('2026-13-01 10:00:00.000'), null);
  assert.equal(parseTime('2026-10-19 24:00:00.000'), null);
  assert.equal(parseTime('2026-10-19 10:60:00.000'), null);
  assert.equal(parseTime('lixo'), null);
  assert.equal(parseTime(''), null);
  assert.equal(parseTime(undefined), null);
  assert.notEqual(parseTime('2028-02-29 00:00:00.000'), null);  // ano bissexto existe
  assert.equal(parseTime('2027-02-29 00:00:00.000'), null);
});

/* ---------- parseLog ---------- */
test('parseLog separa registros e agrupa linhas de continuação', () => {
  const { entries, lineCount } = parseLog(SAMPLE);
  assert.equal(entries.length, 6);
  assert.equal(lineCount, 9);
  assert.deepEqual(entries.map((e) => e.level), ['Info', 'Debug', 'Warning', 'Error', 'Fatal', 'Verbose']);
  assert.deepEqual(entries.map((e) => e.rank), [2, 1, 3, 4, 5, 0]);
  assert.equal(entries[1].cont.length, 3);
  assert.equal(entries[1].cont[0], '  "name": "DELL",');
  assert.equal(entryMessage(entries[0]), 'Sunshine version: v1');
  assert.equal(entryMessage(entries[1]), 'Monitor 0: {');
  assert.equal(entries[0].time, '2026-10-19 14:00:01.100');
  assert.equal(entryClock(entries[0]), '14:00:01');
  assert.equal(entryLines(entries[1]), 4);
  assert.equal(entries[0].id, 0); assert.equal(entries[5].id, 5);
  assert.ok(entries.every((e) => !/\r/.test(e.head) && e.cont.every((l) => !/\r/.test(l))), 'não sobra \\r das quebras CRLF');
});

test('parseLog: LF puro, sem quebra final, BOM e linhas em branco no meio', () => {
  const a = parseLog(`${L('10:00:00.000', 'Info', 'a')}\n${L('10:00:01.000', 'Info', 'b')}`);
  assert.equal(a.entries.length, 2);
  const b = parseLog(`\uFEFF${L('10:00:00.000', 'Info', 'a')}\n\n\ncontinua\n\n`);
  assert.equal(b.entries.length, 1);
  assert.deepEqual(b.entries[0].cont, ['', '', 'continua']);   // brancos do meio ficam; os do fim são descartados
  assert.equal(b.entries[0].level, 'Info');
});

test('parseLog: entrada vazia, nula ou que não é texto', () => {
  for (const v of ['', null, undefined, 42, {}, [], '\n', '\r\n\r\n']) {
    const r = parseLog(v);
    assert.deepEqual(r.entries, [], `valor ${JSON.stringify(v)}`);
    assert.equal(r.lineCount, 0);
  }
});

test('parseLog: linhas antes do primeiro cabeçalho viram um registro sem nível', () => {
  const { entries } = parseLog(`parte de cima cortada\noutra linha\n${L('10:00:00.000', 'Error', 'x')}`);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].level, null);
  assert.equal(entries[0].rank, -1);
  assert.equal(entries[0].head, 'parte de cima cortada');
  assert.deepEqual(entries[0].cont, ['outra linha']);
  assert.equal(entryMessage(entries[0]), 'parte de cima cortada');
  assert.equal(entryClock(entries[0]), '');
  assert.equal(entries[1].level, 'Error');
});

test('parseLog: texto que não é log vira um registro sem nível (não quebra)', () => {
  const { entries } = parseLog('<html>erro 502</html>');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, null);
});

test('parseLog: cabeçalho exige o formato exato (nível desconhecido ou data torta é continuação)', () => {
  const txt = [L('10:00:00.000', 'Info', 'ok'), '[2026-10-19 10:00:01.000]: Trace: x', '[2026-10-19 10:00:02]: Info: sem milissegundos', 'Info: sem data'].join('\n');
  const { entries } = parseLog(txt);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cont.length, 3);
});

test('parseLog: data impossível no cabeçalho mantém o registro, mas sem hora numérica', () => {
  const { entries } = parseLog(L('10:00:00.000', 'Info', 'a').replace('2026-10-19', '2026-02-31'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ts, null);
  assert.equal(entries[0].level, 'Info');
});

test('parseLog: acentos e símbolos passam intactos', () => {
  const { entries } = parseLog(L('10:00:00.000', 'Info', 'DARK SOULS™ — configuração ok'));
  assert.equal(entryMessage(entries[0]), 'DARK SOULS™ — configuração ok');
});

test('parseLog aguenta um arquivo grande sem estourar (200 mil linhas)', () => {
  const big = Array.from({ length: 200000 }, (_, i) => (i % 5 === 0 ? L('10:00:00.000', 'Info', `m${i}`) : `  linha ${i}`)).join('\n');
  const t0 = Date.now();
  const { entries, lineCount } = parseLog(big);
  assert.equal(lineCount, 200000);
  assert.equal(entries.length, 40000);
  assert.ok(Date.now() - t0 < 3000, 'deve levar bem menos de 3 s');
});

/* ---------- filtros ---------- */
test('filterById aceita id e apelidos, e cai em "Tudo" quando não conhece', () => {
  assert.equal(filterById('fatal').id, 'fatal');
  assert.equal(filterById('Fatal').id, 'fatal');
  assert.equal(filterById(' GRAVES ').id, 'fatal');
  assert.equal(filterById('Erro').id, 'error');
  assert.equal(filterById('warning').id, 'warn');
  assert.equal(filterById('Advertência').id, 'warn');
  assert.equal(filterById('todos').id, 'all');
  assert.equal(filterById('xyz').id, 'all');
  assert.equal(filterById(undefined).id, 'all');
  assert.equal(filterById(null).id, 'all');
  assert.equal(FILTERS.length, 4);
});

test('filterById não tropeça em nomes que todo objeto herda (constructor, __proto__...)', () => {
  for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
    assert.equal(filterById(k).id, 'all', k);
  }
  assert.equal(filterById({}).id, 'all');
});

test('filterEntries por nível mínimo', () => {
  const { entries } = parseLog(SAMPLE);
  assert.equal(filterEntries(entries, {}).length, 6);
  assert.equal(filterEntries(entries, { minRank: -1 }), entries, 'sem filtro devolve o mesmo array');
  assert.deepEqual(filterEntries(entries, { minRank: 3 }).map((e) => e.level), ['Warning', 'Error', 'Fatal']);
  assert.deepEqual(filterEntries(entries, { minRank: 4 }).map((e) => e.level), ['Error', 'Fatal']);
  assert.deepEqual(filterEntries(entries, { minRank: 5 }).map((e) => e.level), ['Fatal']);
  assert.deepEqual(filterEntries(entries, { minRank: NaN }).length, 6, 'NaN = sem filtro');
  assert.deepEqual(filterEntries(entries, { minRank: 99 }), []);
});

test('filterEntries por texto: sem diferenciar maiúsculas, casa com a continuação e devolve o registro inteiro', () => {
  const { entries } = parseLog(SAMPLE);
  const r = filterEntries(entries, { query: 'dell' });
  assert.equal(r.length, 1);
  assert.equal(r[0].level, 'Debug');
  assert.equal(r[0].cont.length, 3);
  assert.equal(filterEntries(entries, { query: 'CODIFICADOR' }).length, 1);
  assert.equal(filterEntries(entries, { query: '  codificador  ' }).length, 1, 'espaços das pontas não contam');
  assert.equal(filterEntries(entries, { query: 'nao existe' }).length, 0);
  assert.equal(filterEntries(entries, { query: '   ' }), entries, 'só espaços = sem busca');
  assert.equal(filterEntries(entries, { query: 'error' }).length, 1, 'a palavra do nível também casa com o cabeçalho');
});

test('filterEntries combina nível e texto, e trata caracteres especiais como texto', () => {
  const { entries } = parseLog(`${SAMPLE}${L('14:00:07.000', 'Error', 'caminho C:\\jogos\\(x86)[1] a+b*c?')}\n`);
  assert.equal(filterEntries(entries, { minRank: 4, query: 'falha' }).length, 1);
  assert.equal(filterEntries(entries, { minRank: 5, query: 'falha' }).length, 0);
  assert.equal(filterEntries(entries, { query: 'C:\\jogos\\(x86)[1]' }).length, 1);
  assert.equal(filterEntries(entries, { query: 'a+b*c?' }).length, 1);
  assert.equal(filterEntries(entries, { query: '.*' }).length, 0, 'não é regex');
});

test('filterEntries: registros sem nível só aparecem em "Tudo"', () => {
  const { entries } = parseLog(`solto\n${L('10:00:00.000', 'Warning', 'w')}`);
  assert.equal(filterEntries(entries, { minRank: 3 }).length, 1);
  assert.equal(filterEntries(entries, {}).length, 2);
  assert.equal(normalizeQuery(null), '');
  assert.equal(normalizeQuery('  a '), 'a');
});

/* ---------- contagens e resumo ---------- */
test('countByLevel e countAtLeast', () => {
  const { entries } = parseLog(`solto\n${SAMPLE}`);
  const c = countByLevel(entries);
  assert.deepEqual(c, { Verbose: 1, Debug: 1, Info: 1, Warning: 1, Error: 1, Fatal: 1, none: 1, total: 7 });
  assert.equal(countAtLeast(entries, -1), 7);
  assert.equal(countAtLeast(entries, 3), 3);
  assert.equal(countAtLeast(entries, 5), 1);
  assert.equal(countAtLeast([], 4), 0);
  assert.deepEqual(countByLevel([]), { Verbose: 0, Debug: 0, Info: 0, Warning: 0, Error: 0, Fatal: 0, none: 0, total: 0 });
});

test('summarizeIssues: recente, antigo, sem hora e sem problemas', () => {
  const { entries } = parseLog(SAMPLE);
  const t = parseTime('2026-10-19 14:00:05.500');
  const near = summarizeIssues(entries, t + 5 * 60 * 1000);
  assert.deepEqual([near.fatal, near.error, near.warning], [1, 1, 1]);
  assert.equal(near.last.level, 'Fatal');
  assert.equal(near.recent, true);
  assert.equal(near.ageMs, 5 * 60 * 1000);
  const old = summarizeIssues(entries, t + 3 * 3600 * 1000);
  assert.equal(old.recent, false);
  const future = summarizeIssues(entries, t - 60000);   // relógio voltou: não fica negativo
  assert.equal(future.ageMs, 0);
  assert.equal(future.recent, true);
  const none = summarizeIssues(parseLog(L('10:00:00.000', 'Info', 'tudo bem')).entries);
  assert.deepEqual([none.fatal, none.error, none.warning, none.last, none.recent], [0, 0, 0, null, false]);
  const onlyWarn = summarizeIssues(parseLog(L('10:00:00.000', 'Warning', 'w')).entries);
  assert.equal(onlyWarn.warning, 1); assert.equal(onlyWarn.last, null);
  const noTime = summarizeIssues(parseLog(L('10:00:00.000', 'Error', 'x').replace('2026-10-19', '2026-02-31')).entries);
  assert.equal(noTime.recent, true);
  assert.equal(noTime.ageMs, null);
  assert.deepEqual(summarizeIssues([]).fatal, 0);
});

test('describeIssues: textos e gravidade', () => {
  const { entries } = parseLog(SAMPLE);
  const t = parseTime('2026-10-19 14:00:05.500');
  const bad = describeIssues(summarizeIssues(entries, t + 120000));
  assert.equal(bad.kind, 'bad'); assert.equal(bad.preset, 'fatal');
  assert.match(bad.text, /1 erro grave e 1 erro/);
  assert.match(bad.text, /há 2 min \(14:00:05\)/);
  const errOnly = parseLog([L('14:00:00.000', 'Error', 'a'), L('14:00:01.000', 'Error', 'b')].join('\n')).entries;
  const t2 = parseTime('2026-10-19 14:00:01.000');
  const warn = describeIssues(summarizeIssues(errOnly, t2 + 60000));
  assert.equal(warn.kind, 'warn'); assert.equal(warn.preset, 'error');
  assert.match(warn.text, /2 erros/);
  const oldInfo = describeIssues(summarizeIssues(errOnly, t2 + 5 * 3600 * 1000));
  assert.equal(oldInfo.kind, '');
  assert.match(oldInfo.text, /há 5 h/);
  assert.match(oldInfo.text, /Pode não ter relação/);
  assert.equal(describeIssues(summarizeIssues([])), null);
  assert.equal(describeIssues(null), null);
  assert.equal(describeIssues(summarizeIssues(parseLog(L('10:00:00.000', 'Warning', 'w')).entries)), null, 'só aviso não gera alerta');
});

test('formatAge e plural', () => {
  assert.equal(formatAge(0), 'há poucos segundos');
  assert.equal(formatAge(44000), 'há poucos segundos');
  assert.equal(formatAge(60 * 1000), 'há 1 min');
  assert.equal(formatAge(59 * 60 * 1000), 'há 59 min');
  assert.equal(formatAge(2 * 3600 * 1000), 'há 2 h');
  assert.equal(formatAge(24 * 3600 * 1000), 'há 1 dia');
  assert.equal(formatAge(3 * 24 * 3600 * 1000), 'há 3 dias');
  assert.equal(formatAge(-5), 'há poucos segundos');
  assert.equal(formatAge(NaN), 'há poucos segundos');
  assert.equal(formatAge(undefined), 'há poucos segundos');
  assert.equal(plural(1, 'erro', 'erros'), '1 erro');
  assert.equal(plural(0, 'erro', 'erros'), '0 erros');
  assert.equal(plural(2, 'erro', 'erros'), '2 erros');
});

/* ---------- limites de exibição ---------- */
test('clipText corta linhas enormes sem partir emoji', () => {
  assert.equal(clipText('abc', 10), 'abc');
  assert.equal(clipText(null), '');
  assert.equal(clipText('abcdef', 3), 'abc … (+3 caracteres)');
  const s = `aa${'\u{1F600}'}bb`;   // 'aa' + par substituto + 'bb'
  const out = clipText(s, 3);          // o corte cairia no meio do par
  assert.ok(!/[\uD800-\uDBFF]$/.test(out.split(' … ')[0]), 'não termina com metade de um emoji');
  assert.equal(clipText('x'.repeat(3000)).length < 2100, true);
});

test('limitLines: abaixo do limite não mexe; acima, fica com o fim', () => {
  const { entries } = parseLog(SAMPLE);          // 9 linhas
  const same = limitLines(entries, 100);
  assert.equal(same.truncated, false); assert.equal(same.entries, entries); assert.equal(same.totalLines, 9);
  assert.equal(limitLines(entries, 9).truncated, false, 'exatamente no limite');
  const cut = limitLines(entries, 5);            // do fim: Verbose(1)+Fatal(1)+Error(1)+Warning(1) = 4; Debug(4) não cabe
  assert.deepEqual(cut.entries.map((e) => e.level), ['Warning', 'Error', 'Fatal', 'Verbose']);
  assert.equal(cut.shownLines, 4); assert.equal(cut.hiddenLines, 5); assert.equal(cut.hiddenEntries, 2); assert.equal(cut.truncated, true);
  assert.equal(entries.length, 6, 'a entrada não é alterada');
});

test('limitLines: lista vazia, limite inválido e último registro gigante', () => {
  assert.deepEqual(limitLines([], 10), { entries: [], shownLines: 0, totalLines: 0, hiddenLines: 0, hiddenEntries: 0, truncated: false });
  const { entries } = parseLog(SAMPLE);
  assert.equal(limitLines(entries, 0).entries.length, 1, 'limite 0 vira 1');
  assert.equal(limitLines(entries, NaN).entries.length, 1);
  const giant = parseLog([L('10:00:00.000', 'Info', 'a'), L('10:00:01.000', 'Info', 'b'), ...Array.from({ length: 50 }, (_, i) => `  l${i}`)].join('\n')).entries;
  const g = limitLines(giant, 10);
  assert.equal(g.entries.length, 1);
  assert.equal(g.entries[0].cont.length, 9);
  assert.equal(g.entries[0].clipped, 41);
  assert.equal(entryLines(g.entries[0]), 51, 'clipped continua contando as linhas escondidas');
  assert.equal(g.hiddenEntries, 1);
  assert.equal(giant[1].cont.length, 50, 'o original não é cortado');
});

/* ---------- destaque e cópia ---------- */
test('highlightParts destaca sem diferenciar maiúsculas e escapa caracteres de regex', () => {
  assert.deepEqual(highlightParts('Falha ao abrir', 'falha'), [{ text: 'Falha', match: true }, { text: ' ao abrir', match: false }]);
  assert.deepEqual(highlightParts('a.b.c', '.'), [{ text: 'a', match: false }, { text: '.', match: true }, { text: 'b', match: false }, { text: '.', match: true }, { text: 'c', match: false }]);
  assert.deepEqual(highlightParts('abc', ''), [{ text: 'abc', match: false }]);
  assert.deepEqual(highlightParts('abc', '   '), [{ text: 'abc', match: false }]);
  assert.deepEqual(highlightParts('', 'a'), [{ text: '', match: false }]);
  assert.deepEqual(highlightParts('abc', 'x'), [{ text: 'abc', match: false }]);
  assert.deepEqual(highlightParts(null, 'x'), [{ text: '', match: false }]);
  assert.deepEqual(highlightParts('xx', 'x'), [{ text: 'x', match: true }, { text: 'x', match: true }]);
  assert.deepEqual(highlightParts('(a)', '(a)'), [{ text: '(a)', match: true }]);
  assert.equal(highlightParts('<b>x</b>', 'x').map((p) => p.text).join(''), '<b>x</b>', 'o texto original é preservado, sem HTML');
});

test('entriesToText devolve as linhas originais', () => {
  const { entries } = parseLog(SAMPLE);
  assert.equal(entriesToText(entries), SAMPLE.replace(/\r\n/g, '\n').replace(/\n$/, ''));
  assert.equal(entriesToText([]), '');
  assert.equal(entriesToText(filterEntries(entries, { minRank: 5 })), L('14:00:05.500', 'Fatal', 'Não foi possível iniciar o vídeo'));
});

/* ---------- nível mínimo configurado ---------- */
test('describeMinLogLevel entende dígito, nome e ausência', () => {
  assert.deepEqual(describeMinLogLevel(undefined), { rank: 2, label: 'Informação', lineLabel: 'Info', known: true, isDefault: true });
  assert.deepEqual(describeMinLogLevel(''), { rank: 2, label: 'Informação', lineLabel: 'Info', known: true, isDefault: true });
  assert.deepEqual(describeMinLogLevel('1'), { rank: 1, label: 'Depuração', lineLabel: 'Depuração', known: true, isDefault: false });
  assert.equal(describeMinLogLevel('0').label, 'Verboso');
  assert.equal(describeMinLogLevel('0').lineLabel, 'Detalhe');
  assert.equal(describeMinLogLevel('3').label, 'Advertência');
  assert.equal(describeMinLogLevel('3').lineLabel, 'Aviso');
  assert.equal(describeMinLogLevel('5').lineLabel, 'Erro grave');
  assert.equal(describeMinLogLevel('6').label, 'Nenhum');
  assert.equal(describeMinLogLevel('6').lineLabel, '', 'Nenhum não tem linhas');
  assert.equal(describeMinLogLevel('warning').rank, 3);
  assert.equal(describeMinLogLevel(' debug ').rank, 1, 'o arquivo pode ter espaços nas pontas');
  assert.equal(describeMinLogLevel(4).rank, 4, 'número também');
  const odd = describeMinLogLevel('7');
  assert.equal(odd.known, false); assert.equal(odd.rank, 2);
  assert.equal(describeMinLogLevel('abc').known, false);
  assert.equal(describeMinLogLevel('-1').known, false);
});

test('describeMinLogLevel segue o servidor (config.cpp): nomes só em minúsculas; senão vale o 1º caractere, se for dígito de 0 a 6', () => {
  // O servidor ignora maiúsculas nos nomes ("DEBUG", "Warning") e usa o padrão 2.
  for (const v of ['DEBUG', 'Warning', 'INFO', 'Verbose', 'None']) {
    const r = describeMinLogLevel(v);
    assert.equal(r.known, false, v); assert.equal(r.rank, 2, v);
  }
  // Texto que COMEÇA com dígito vale pelo dígito.
  assert.equal(describeMinLogLevel('10').rank, 1);
  assert.equal(describeMinLogLevel('10').known, true);
  assert.equal(describeMinLogLevel('3abc').rank, 3);
  assert.equal(describeMinLogLevel('6x').rank, 6);
  assert.equal(describeMinLogLevel('0debug').rank, 0);
  assert.equal(describeMinLogLevel('7abc').known, false);
  assert.equal(describeMinLogLevel('8').known, false);
  assert.equal(describeMinLogLevel('x3').known, false, 'dígito só vale na primeira posição');
  assert.equal(describeMinLogLevel('verboso').known, false, 'o nome em português não é um nome do servidor');
});

test('describeLogLevelHint explica os nomes diferentes e os casos de aviso', () => {
  const info = describeLogLevelHint(describeMinLogLevel('2'));
  assert.equal(info.kind, '');
  assert.match(info.text, /Nível do log: Informação \(nas linhas do registro aparece como Info\)/);
  assert.match(info.text, /Depuração/);
  const warning = describeLogLevelHint(describeMinLogLevel('3'));
  assert.match(warning.text, /Advertência \(nas linhas do registro aparece como Aviso\)/);
  const debug = describeLogLevelHint(describeMinLogLevel('1'));
  assert.doesNotMatch(debug.text, /aparece como/, 'Depuração tem o mesmo nome nos dois lugares');
  assert.match(debug.text, /pode ficar grande/);
  assert.equal(describeLogLevelHint(describeMinLogLevel('6')).kind, 'warn');
  assert.match(describeLogLevelHint(describeMinLogLevel('6')).text, /desligado/);
  const bad = describeLogLevelHint(describeMinLogLevel('XYZ'));
  assert.equal(bad.kind, 'warn');
  assert.match(bad.text, /não reconhece/);
  assert.equal(describeLogLevelHint(null), null);
});

test('LEVELS cobre os seis níveis do servidor, em ordem', () => {
  assert.deepEqual(LEVELS.map((l) => l.value), ['Verbose', 'Debug', 'Info', 'Warning', 'Error', 'Fatal']);
  assert.deepEqual(LEVELS.map((l) => l.rank), [0, 1, 2, 3, 4, 5]);
  assert.ok(Object.isFrozen(LEVELS));
});

/* ---------- avisos de erro: hora desconhecida e erro repetido ---------- */
test('describeIssues não afirma "há poucos segundos" quando a hora do último erro é ilegível', () => {
  const bad = parseLog(L('10:00:00.000', 'Error', 'x').replace('2026-10-19', '2026-02-31')).entries;   // 31 de fevereiro
  const sum = summarizeIssues(bad, Date.now());
  assert.equal(sum.ageMs, null);
  const d = describeIssues(sum);
  assert.doesNotMatch(d.text, /há poucos segundos|há \d/);
  assert.match(d.text, /O último foi às 10:00:00\./);
  assert.equal(d.kind, 'warn', 'sem hora legível continua valendo avisar');
  // sem nenhuma hora (registro solto, sem cabeçalho): omite a frase inteira
  const sem = describeIssues({ fatal: 0, error: 1, warning: 0, last: { time: null }, ageMs: null, recent: true, kinds: 1, top: { message: 'x', count: 1 }, fresh: true });
  assert.doesNotMatch(sem.text, /último/);
  // com hora legível o texto continua igual
  const ok = describeIssues(summarizeIssues(parseLog(L('10:00:00.000', 'Error', 'x')).entries, parseTime('2026-10-19 10:02:00.000')));
  assert.match(ok.text, /O último foi há 2 min \(10:00:00\)\./);
});

const repeated = (n, msg = 'Unknown status', extra = []) => parseLog([
  ...Array.from({ length: n }, (_, i) => L(`10:${String(i).padStart(2, '0')}:00.000`, 'Error', msg)),
  ...extra,
].join('\n')).entries;

test('summarizeIssues: kinds, top e fresh (o mesmo erro repetido é ruído, não fato novo)', () => {
  const now = parseTime('2026-10-19 10:30:00.000');
  const noisy = summarizeIssues(repeated(NOISE_REPEATS + 50), now);
  assert.equal(noisy.error, NOISE_REPEATS + 50);
  assert.equal(noisy.kinds, 1);
  assert.deepEqual(noisy.top, { message: 'Unknown status', count: NOISE_REPEATS + 50 });
  assert.equal(noisy.fresh, false, 'só ruído = nada novo');
  // abaixo do limite de repetições, cada erro conta como fato novo
  const few = summarizeIssues(repeated(NOISE_REPEATS - 1, 'Falhou'), parseTime('2026-10-19 10:05:00.000'));
  assert.equal(few.fresh, true);
  // ruído + um erro diferente e recente = fresh
  const mixed = summarizeIssues(repeated(NOISE_REPEATS + 5, 'Unknown status', [L('10:29:00.000', 'Error', 'Codificador falhou')]), now);
  assert.equal(mixed.kinds, 2);
  assert.equal(mixed.fresh, true);
  assert.equal(mixed.top.message, 'Unknown status');
  // o mesmo erro novo mas ANTIGO (fora da janela) não é fresh
  const oldOne = summarizeIssues(repeated(NOISE_REPEATS + 5, 'Unknown status', [L('10:29:00.000', 'Error', 'Codificador falhou')]), now + RECENT_MS + 60000);
  assert.equal(oldOne.fresh, false);
  // sem erros
  const none = summarizeIssues(parseLog(L('10:00:00.000', 'Info', 'ok')).entries);
  assert.equal(none.kinds, 0); assert.equal(none.top, null); assert.equal(none.fresh, false);
  // a janela padrão é de 15 minutos
  assert.equal(RECENT_MS, 15 * 60 * 1000);
  const e1 = parseLog(L('10:00:00.000', 'Error', 'a')).entries;
  assert.equal(summarizeIssues(e1, parseTime('2026-10-19 10:14:00.000')).recent, true);
  assert.equal(summarizeIssues(e1, parseTime('2026-10-19 10:16:00.000')).recent, false);
});

test('describeIssues: o mesmo erro repetido avisa sem alarme (kind vazio), e um erro novo ainda acende', () => {
  const now = parseTime('2026-10-19 10:30:00.000');
  const calm = describeIssues(summarizeIssues(repeated(55), now));
  assert.equal(calm.kind, '', 'sem cor de alerta');
  assert.equal(calm.preset, 'error');
  assert.match(calm.text, /repete 55 vezes o mesmo erro: "Unknown status"/);
  assert.match(calm.text, /pode ignorar/);
  // erro novo no meio do ruído: alerta e cita o mais repetido
  const mixed = describeIssues(summarizeIssues(repeated(55, 'Unknown status', [L('10:29:00.000', 'Error', 'Codificador falhou')]), now));
  assert.equal(mixed.kind, 'warn');
  assert.match(mixed.text, /56 erros/);
  assert.match(mixed.text, /O mais repetido \("Unknown status"\) aparece 55 vezes/);
  assert.doesNotMatch(mixed.text, /Pode não ter relação/);
  // poucos erros diferentes e antigos: informativo
  const old = describeIssues(summarizeIssues(repeated(2, 'Falhou'), parseTime('2026-10-19 15:00:00.000')));
  assert.equal(old.kind, '');
  assert.match(old.text, /Pode não ter relação/);
  assert.doesNotMatch(old.text, /mais repetido/);
  // erro grave sempre é alerta, mesmo no meio de ruído
  const fatal = describeIssues(summarizeIssues(repeated(55, 'Unknown status', [L('10:29:00.000', 'Fatal', 'Sem vídeo')]), now));
  assert.equal(fatal.kind, 'bad');
  assert.match(fatal.text, /1 erro grave e 55 erros/);
  // mensagem enorme é cortada no aviso; mensagem vazia vira "(sem texto)"
  const big = describeIssues(summarizeIssues(repeated(6, 'x'.repeat(500)), now));
  assert.ok(big.text.length < 400);
  const empty = describeIssues(summarizeIssues(repeated(6, ''), now));
  assert.match(empty.text, /\(sem texto\)/);
});
