// Testes da leitura e formatação do uso do PC (ui/js/lib/stats.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  num, clampPct, percentOf, parseStats, parseStatsResult, splitBytes, formatBytes, formatPercent, formatTemp, formatFps,
  shortCpuName, shortGpuName, vendorLabel, formatVersion, levelOf, tempLevel, gpuKeys, defaultGpuIndex, resolveGpuIndex, nextGpuKey, buildUsage,
} from '../../ui/js/lib/stats.js';

const NB = ' ';
// Exemplo do DESENVOLVIMENTO.md (seção 4)
const SAMPLE = {
  cpu: { name: 'Intel(R) Core(TM) i5-11300H @ 3.10GHz', temp_c: null, threads: 8, usage: 12.5 },
  disks: [{ name: 'C:', total: 509874270208, used: 421561851904 }],
  gpus: [{ name: 'NVIDIA GeForce GTX 1650', temp_c: 59, usage: 66, vendor: 'nvidia', vram_total: 4294967296, vram_used: 1262972928 }],
  host: 'MNBF-NEON',
  ram: { total: 25542582272, used: 22984445952 },
  stream: { active: false, fps: 0.0 },
};
// PC real: duas placas (Intel integrada + NVIDIA)
const TWO_GPUS = {
  ...SAMPLE,
  gpus: [
    { name: 'Intel(R) Iris(R) Xe Graphics', temp_c: null, usage: 0.0, vendor: 'intel', vram_total: 134217728, vram_used: null },
    { name: 'NVIDIA GeForce GTX 1650', temp_c: 49, usage: 0, vendor: 'nvidia', vram_total: 4294967296, vram_used: 424493056 },
  ],
};

test('num: aceita número e texto numérico, rejeita o resto', () => {
  assert.equal(num(5), 5);
  assert.equal(num('12.5'), 12.5);
  assert.equal(num(' 7 '), 7);
  for (const bad of [null, undefined, '', '  ', 'abc', NaN, Infinity, -Infinity, true, false, {}, [], [1]]) assert.equal(num(bad), null, String(bad));
});

test('clampPct e percentOf: limites e entradas inválidas', () => {
  assert.equal(clampPct(150), 100);
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct('33'), 33);
  assert.equal(clampPct(null), null);
  assert.equal(percentOf(50, 200), 25);
  assert.equal(percentOf(300, 200), 100);   // usado maior que o total (leitura inconsistente)
  assert.equal(percentOf(1, 0), null);       // divisão por zero
  assert.equal(percentOf(-1, 10), null);
  assert.equal(percentOf(null, 10), null);
  assert.equal(percentOf('x', 10), null);
});

test('parseStats: exemplo do contrato vira o formato normalizado', () => {
  const s = parseStats(JSON.stringify(SAMPLE));
  assert.equal(s.host, 'MNBF-NEON');
  assert.deepEqual(s.cpu, { name: SAMPLE.cpu.name, usage: 12.5, tempC: null, threads: 8 });
  assert.equal(s.ram.total, 25542582272);
  assert.equal(s.ram.free, 25542582272 - 22984445952);
  assert.ok(Math.abs(s.ram.pct - 89.99) < 0.1);
  assert.equal(s.gpus.length, 1);
  assert.equal(s.gpus[0].vendor, 'nvidia');
  assert.equal(s.gpus[0].tempC, 59);
  assert.equal(s.disks[0].name, 'C:');
  assert.ok(Math.abs(s.disks[0].pct - 82.67) < 0.1);
  assert.deepEqual(s.stream, { active: false, fps: 0 });
});

test('parseStats: aceita objeto já convertido e rejeita lixo', () => {
  assert.ok(parseStats(SAMPLE));
  for (const bad of [null, undefined, '', '   ', 'não é json', '{quebrado', '[]', '[1,2]', '"texto"', '42', 'null', {}, [], 7, true, '{}', '{"foo":1}']) {
    assert.equal(parseStats(bad), null, JSON.stringify(bad));
  }
});

test('parseStats: seções com tipo errado não quebram e viram seções vazias', () => {
  const s = parseStats({ cpu: 'oi', ram: [], gpus: 'x', disks: { a: 1 }, stream: 3 });
  // as chaves existem (não são null), então é um objeto de stats, só que vazio
  assert.ok(s);
  assert.equal(s.cpu, null);
  assert.equal(s.ram, null);
  assert.deepEqual(s.gpus, []);
  assert.deepEqual(s.disks, []);
  assert.equal(s.stream, null);
});

test('parseStats: primeira leitura de CPU (usage null) e sensores nulos', () => {
  const s = parseStats({ cpu: { name: 'X', usage: null, temp_c: null, threads: null }, gpus: [{ name: 'G', vendor: 'amd', usage: null, temp_c: null, vram_total: null, vram_used: null }] });
  assert.equal(s.cpu.usage, null);
  assert.equal(s.cpu.threads, 0);
  assert.equal(s.gpus[0].usage, null);
  assert.equal(s.gpus[0].vramTotal, null);
  assert.equal(s.ram, null);
  assert.equal(s.stream, null);
});

test('parseStats: percentuais fora da faixa são limitados; temperatura absurda é descartada', () => {
  const s = parseStats({ cpu: { usage: 250, temp_c: 0 }, gpus: [{ usage: -3, temp_c: 999 }, { usage: '40', temp_c: '61.4' }] });
  assert.equal(s.cpu.usage, 100);
  assert.equal(s.cpu.tempC, null, '0 °C é sensor quebrado');
  assert.equal(s.gpus[0].usage, 0);
  assert.equal(s.gpus[0].tempC, null);
  assert.equal(s.gpus[1].usage, 40);
  assert.equal(s.gpus[1].tempC, 61.4);
  assert.equal(s.gpus[0].name, 'Placa de vídeo', 'nome ausente ganha um nome genérico');
});

test('parseStats: memória com total 0 ou usado maior que o total', () => {
  assert.equal(parseStats({ ram: { total: 0, used: 0 }, cpu: {} }).ram, null);
  const r = parseStats({ ram: { total: 100, used: 500 } }).ram;
  assert.equal(r.used, 100);
  assert.equal(r.free, 0);
  assert.equal(r.pct, 100);
  const sem = parseStats({ ram: { total: 100 } }).ram;
  assert.equal(sem.used, null);
  assert.equal(sem.pct, null);
});

test('parseStats: discos sem tamanho (leitor vazio) são ignorados e itens inválidos também', () => {
  const s = parseStats({ disks: [{ name: 'E:', total: 0, used: 0 }, null, 'x', { name: 'D:', total: 1000, used: 250 }, { total: 100, used: 10 }] });
  assert.deepEqual(s.disks.map((d) => d.name), ['D:', '?']);
  assert.equal(s.disks[0].free, 750);
});

test('parseStats: stream.active só vale com true de verdade', () => {
  assert.equal(parseStats({ stream: { active: 'true', fps: 60 } }).stream.active, false);
  assert.deepEqual(parseStats({ stream: { active: true, fps: 59.94 } }).stream, { active: true, fps: 59.94 });
  assert.equal(parseStats({ stream: { active: true, fps: -1 } }).stream.fps, null);
});

test('parseStatsResult: respostas da ponte nativa', () => {
  const ok = parseStatsResult({ ok: true, body: JSON.stringify(SAMPLE), id: 3 });
  assert.equal(ok.ok, true);
  assert.equal(ok.stats.host, 'MNBF-NEON');
  assert.equal(parseStatsResult({ ok: false, error: 'HTTP 0' }).ok, false);
  assert.equal(parseStatsResult({ ok: false, error: 'HTTP 0' }).error, 'HTTP 0');
  assert.equal(parseStatsResult({ error: 'comando desconhecido' }).ok, false);
  assert.equal(parseStatsResult({ ok: true, body: 'html de erro' }).ok, false);
  assert.equal(parseStatsResult({ ok: true, body: '{}' }).ok, false);
  assert.equal(parseStatsResult({ ok: true }).ok, false);
  for (const bad of [null, undefined, 'x', 5, []]) {
    const r = parseStatsResult(bad);
    assert.equal(r.ok, false);
    assert.equal(r.stats, null);
  }
});

test('splitBytes / formatBytes: PT-BR com vírgula e base 1024', () => {
  assert.deepEqual(splitBytes(0), { value: '0', unit: 'B' });
  assert.deepEqual(splitBytes(512), { value: '512', unit: 'B' });
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1,5 KB');
  assert.equal(formatBytes(25542582272), '23,8 GB');
  assert.equal(formatBytes(509874270208), '475 GB');
  assert.equal(formatBytes(1000203087872), '932 GB');
  assert.equal(formatBytes(4294967296), '4 GB', 'sem ",0" sobrando');
  assert.equal(formatBytes(134217728), '128 MB');
  assert.equal(formatBytes(2 * 1024 ** 4), '2 TB');
  assert.equal(formatBytes(1.8 * 1024 ** 4), '1,8 TB');
  assert.equal(formatBytes(99.96 * 1024 ** 3), '100 GB');
  for (const bad of [null, undefined, -1, NaN, 'x', {}]) assert.equal(formatBytes(bad), '—');
  assert.deepEqual(splitBytes(null), { value: '—', unit: '' });
});

test('formatBytes: valor que arredonda para 1024 sobe de unidade (nunca "1024 GB")', () => {
  assert.equal(formatBytes(1023.6 * 1024 ** 3), '1 TB');
  assert.equal(formatBytes(1023.4 * 1024 ** 3), '1023 GB', 'abaixo do arredondamento: continua em GB');
  assert.equal(formatBytes(1023.5 * 1024 ** 3), '1 TB', 'exatamente no limite do arredondamento');
  assert.equal(formatBytes(1048575), '1 MB');
  assert.equal(formatBytes(1023.96 * 1024 ** 2), '1 GB');
  assert.equal(formatBytes(1023.95 * 1024), '1 MB');
  assert.equal(formatBytes(1023 * 1024), '1023 KB');
  assert.equal(formatBytes(1023.6), '1 KB', 'até bytes quebrados sobem');
  assert.equal(formatBytes(1023), '1023 B');
  assert.match(formatBytes(1024 ** 5 * 1023.9), / PB$/, 'não existe unidade maior que PB: fica em PB, sem quebrar');
  assert.deepEqual(splitBytes(1023.6 * 1024 ** 3), { value: '1', unit: 'TB' });
  assert.deepEqual(splitBytes(1.5 * 1024 ** 4), { value: '1,5', unit: 'TB' });
  // nenhum valor, em nenhuma unidade, pode mostrar 1024 ou mais
  for (let i = 1; i <= 4; i++) for (const k of [1023.4, 1023.5, 1023.6, 1023.95, 1023.999, 1024]) {
    const { value } = splitBytes(k * 1024 ** i);
    assert.ok(Number(value.replace(',', '.')) < 1024, `${k} * 1024^${i} → ${value}`);
  }
});

test('formatPercent / formatTemp / formatFps', () => {
  assert.equal(formatPercent(12.5), '13%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(180), '100%');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatTemp(59), `59${NB}°C`);
  assert.equal(formatTemp(84.85000000000002), `85${NB}°C`);
  assert.equal(formatTemp(null), '—');
  assert.equal(formatTemp(0), '—');
  assert.equal(formatFps(59.94), '60');
  assert.equal(formatFps(0), '0');
  assert.equal(formatFps(null), '—');
  assert.equal(formatFps(-4), '—');
});

test('nomes curtos de CPU e GPU', () => {
  assert.equal(shortCpuName('11th Gen Intel(R) Core(TM) i5-11300H @ 3.10GHz'), '11th Gen Intel Core i5-11300H');
  assert.equal(shortCpuName('AMD Ryzen 7 5800X 8-Core Processor'), 'AMD Ryzen 7 5800X');
  assert.equal(shortCpuName('Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz'), 'Intel Core i7-9700K');
  assert.equal(shortCpuName(null), '');
  assert.equal(shortGpuName('NVIDIA GeForce GTX 1650'), 'GTX 1650');
  assert.equal(shortGpuName('NVIDIA GeForce RTX 3060 Laptop GPU'), 'RTX 3060 Laptop GPU');
  assert.equal(shortGpuName('Intel(R) Iris(R) Xe Graphics'), 'Intel Iris Xe');
  assert.equal(shortGpuName('AMD Radeon(TM) RX 6600'), 'AMD Radeon RX 6600');
  assert.equal(shortGpuName(undefined), '');
  assert.equal(vendorLabel('nvidia'), 'NVIDIA');
  assert.equal(vendorLabel('AMD'), 'AMD');
  assert.equal(vendorLabel('qualcomm'), 'Qualcomm');
  assert.equal(vendorLabel(''), '');
  assert.equal(vendorLabel(null), '');
});

test('formatVersion: marca compilação local', () => {
  assert.equal(formatVersion('0.0.0.98695412.dirty'), '0.0.0.98695412 (versão de teste)');
  assert.equal(formatVersion('v1.2.3'), '1.2.3');
  assert.equal(formatVersion('1.2.3'), '1.2.3');
  assert.equal(formatVersion(''), '');
  assert.equal(formatVersion(undefined), '');
  assert.equal(formatVersion(2), '2');
});

test('levelOf / tempLevel', () => {
  assert.equal(levelOf(10), 'ok');
  assert.equal(levelOf(70), 'warn');
  assert.equal(levelOf(90), 'bad');
  assert.equal(levelOf(null), 'off');
  assert.equal(levelOf(99, { warn: Infinity, bad: Infinity }), 'ok');
  assert.equal(tempLevel(40), 'ok');
  assert.equal(tempLevel(65), 'warn');
  assert.equal(tempLevel(80), 'bad');
  assert.equal(tempLevel(null), 'off');
  assert.equal(tempLevel(0), 'off');
});

test('várias GPUs: começa na NVIDIA, alterna, lembra a escolha', () => {
  const g = parseStats(TWO_GPUS).gpus;
  assert.equal(defaultGpuIndex(g), 1, 'NVIDIA primeiro');
  assert.equal(resolveGpuIndex(g, ''), 1);
  const keys = gpuKeys(g);
  assert.equal(new Set(keys).size, 2);
  assert.equal(resolveGpuIndex(g, keys[0]), 0);
  const next = nextGpuKey(g, '');            // estava na NVIDIA (padrão) → vai para a Intel
  assert.equal(next, keys[0]);
  assert.equal(nextGpuKey(g, next), keys[1], 'dá a volta');
  assert.equal(resolveGpuIndex(g, 'não existe'), 1, 'chave que sumiu volta ao padrão');
  assert.equal(defaultGpuIndex([{ vendor: 'amd' }, { vendor: 'intel' }]), 0, 'sem NVIDIA: a primeira');
});

test('GPUs com nome igual têm chaves diferentes e dá para alternar entre elas', () => {
  const g = parseStats({ gpus: [{ name: 'X', vendor: 'nvidia' }, { name: 'X', vendor: 'nvidia' }] }).gpus;
  const k = gpuKeys(g);
  assert.notEqual(k[0], k[1]);
  assert.equal(nextGpuKey(g, k[0]), k[1]);
  assert.equal(nextGpuKey(g, k[1]), k[0]);
});

test('sem GPU: índice -1 e chave vazia', () => {
  assert.equal(defaultGpuIndex([]), -1);
  assert.equal(resolveGpuIndex([], 'x'), -1);
  assert.equal(nextGpuKey([], 'x'), '');
  assert.equal(defaultGpuIndex(null), -1);
  assert.deepEqual(gpuKeys(null), []);
});

test('buildUsage: exemplo do contrato', () => {
  const vm = buildUsage(parseStats(SAMPLE));
  assert.equal(vm.cpu.valueText, '13');
  assert.equal(vm.cpu.unit, '%');
  assert.equal(vm.cpu.sub, 'Intel Core i5-11300H');
  assert.equal(vm.cpu.measuring, false);
  assert.equal(vm.ram.valueText, '21,4');
  assert.equal(vm.ram.unit, 'GB');
  assert.equal(vm.ram.sub, 'de 23,8 GB · livre 2,4 GB');
  assert.equal(vm.ram.tag, '90%');
  assert.equal(vm.ram.level, 'warn', '90% de memória: amarelo (vermelho só a partir de 95%)');
  assert.equal(vm.gpu.valueText, '66');
  assert.equal(vm.gpu.sub, 'GTX 1650');
  assert.equal(vm.gpu.tag, 'NVIDIA');
  assert.equal(vm.gpu.extra, 'Memória de vídeo: 1,2 GB de 4 GB');
  assert.equal(vm.gpu.count, 1);
  assert.equal(vm.disks.length, 1);
  assert.equal(vm.disks[0].freeText, '82,2 GB livres');
  assert.equal(vm.disks[0].totalText, 'de 475 GB');
  assert.equal(vm.disks[0].level, 'ok');
  assert.deepEqual(vm.temps.map((t) => t.label), ['Processador', 'Placa de vídeo NVIDIA']);
  assert.equal(vm.temps[0].valueText, '—');
  assert.equal(vm.temps[1].valueText, `59${NB}°C`);
  assert.equal(vm.stream.active, false);
  assert.equal(vm.stream.tag, 'Parada');
  assert.equal(vm.stream.valueText, '—');
});

test('buildUsage: medidor de temperatura (0 a 100 °C) e sem leitura', () => {
  const vm = buildUsage(parseStats({ cpu: { usage: 1, temp_c: 72.4 }, gpus: [{ name: 'G', vendor: 'amd', temp_c: 130 }, { name: 'H', vendor: 'amd', temp_c: null }] }));
  assert.equal(vm.temps[0].pct, 72.4);
  assert.equal(vm.temps[1].pct, 100, 'acima de 100 °C o medidor trava no máximo');
  assert.equal(vm.temps[1].level, 'bad');
  assert.equal(vm.temps[2].pct, null, 'sem leitura: sem medidor');
});

test('buildUsage: CPU medindo na primeira leitura', () => {
  const vm = buildUsage(parseStats({ cpu: { name: 'AMD Ryzen 5', usage: null } }));
  assert.equal(vm.cpu.measuring, true);
  assert.equal(vm.cpu.valueText, '—');
  assert.equal(vm.cpu.unit, '');
  assert.equal(vm.cpu.sub, 'Medindo o uso…');
  assert.equal(vm.cpu.level, 'off');
  assert.equal(vm.ram, null);
  assert.equal(vm.stream, null);
  assert.equal(vm.gpu.sub, 'nenhuma placa de vídeo detectada');
});

test('buildUsage: GPU escolhida e temperaturas priorizam quem tem leitura', () => {
  const s = parseStats(TWO_GPUS);
  const auto = buildUsage(s);
  assert.equal(auto.gpu.tag, 'NVIDIA');
  assert.equal(auto.gpu.position, 2);
  assert.equal(auto.gpu.count, 2);
  const keys = gpuKeys(s.gpus);
  const intel = buildUsage(s, { gpuKey: keys[0] });
  assert.equal(intel.gpu.tag, 'Intel');
  assert.equal(intel.gpu.sub, 'Intel Iris Xe');
  assert.equal(intel.gpu.position, 1);
  assert.equal(intel.gpu.extra, 'Memória de vídeo: 128 MB', 'sem uso medido, mostra só o tamanho');
  assert.equal(intel.gpu.valueText, '0');
  assert.equal(auto.temps[1].label, 'Placa de vídeo NVIDIA', 'a placa com temperatura aparece primeiro');
  assert.equal(auto.temps[2].valueText, '—');
});

test('buildUsage: muitas GPUs mostram só duas temperaturas', () => {
  const gpus = [1, 2, 3, 4].map((i) => ({ name: `G${i}`, vendor: 'nvidia', temp_c: 40 + i, usage: 1 }));
  const vm = buildUsage(parseStats({ cpu: { usage: 1, temp_c: 50 }, gpus }));
  assert.equal(vm.temps.length, 3);
  assert.equal(vm.gpu.count, 4);
});

test('buildUsage: transmissão ativa mostra FPS; disco cheio vira alerta', () => {
  const vm = buildUsage(parseStats({ stream: { active: true, fps: 59.9 }, disks: [{ name: 'D:', total: 1000, used: 970 }, { name: 'E:', total: 1000, used: 880 }] }));
  assert.equal(vm.stream.valueText, '60');
  assert.equal(vm.stream.unit, 'FPS');
  assert.equal(vm.stream.tag, 'Ao vivo');
  assert.equal(vm.disks[0].level, 'bad');
  assert.equal(vm.disks[1].level, 'warn');
});

test('buildUsage: memória quase cheia vira alerta vermelho; sem "usado" não inventa número', () => {
  const cheia = buildUsage(parseStats({ ram: { total: 1000, used: 980 } }));
  assert.equal(cheia.ram.level, 'bad');
  assert.equal(cheia.ram.tag, '98%');
  const semUso = buildUsage(parseStats({ ram: { total: 1024 ** 3 } }));
  assert.equal(semUso.ram.valueText, '—');
  assert.equal(semUso.ram.unit, '');
  assert.equal(semUso.ram.level, 'off');
  assert.equal(semUso.ram.sub, 'de 1 GB');
});

test('buildUsage: sem estatísticas devolve null', () => {
  assert.equal(buildUsage(null), null);
  assert.equal(buildUsage(undefined), null);
});
