// Testes da lógica pura da tela Sistema (helpers exportados por ui/js/views/system.js, sem DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  platformLabel, describeVdisplay, describeOrigin, kindLabel, describeFailure, interpretStatus, interpretQuit,
  validatePasswordForm, explainPasswordError, reloginAfterPasswordChange, buildSupportText, VDISPLAY_HELP,
  castNameOf, describeRestartPrecheck, shouldClearResult, RESULT_TTL_MS,
} from '../../ui/js/views/system.js';

const noWait = async () => {};
// Valores falsos só para os testes (nunca credenciais reais).
const T = { cu: 'usuario-teste', cp: 'senha-atual-teste', np: 'senha-nova-teste-1', nu: 'usuario-novo' };

/* ---------- Informações ---------- */
test('platformLabel traduz as plataformas conhecidas e não quebra com o resto', () => {
  assert.equal(platformLabel('windows'), 'Windows');
  assert.equal(platformLabel('Windows'), 'Windows');
  assert.equal(platformLabel(' macos '), 'macOS');
  assert.equal(platformLabel('linux'), 'Linux');
  assert.equal(platformLabel('freebsd'), 'freebsd');
  assert.equal(platformLabel(''), 'Não informado');
  assert.equal(platformLabel(undefined), 'Não informado');
  assert.equal(platformLabel(null), 'Não informado');
});

test('describeVdisplay: 0 é pronto (número ou texto), o resto é aviso', () => {
  assert.deepEqual(describeVdisplay(0), { text: 'Pronto', level: 'ok', help: '' });
  assert.equal(describeVdisplay('0').level, 'ok');
  for (const [v, text] of [[1, 'Desconhecido'], [-1, 'Não inicializado'], [-2, 'Versão incompatível'], ['-3', 'Falha no monitoramento (watchdog)']]) {
    const d = describeVdisplay(v);
    assert.equal(d.text, text, `valor ${v}`);
    assert.equal(d.level, 'warn');
    assert.equal(d.help, VDISPLAY_HELP);
  }
  assert.equal(describeVdisplay(7).text, 'Estado 7');
  assert.equal(describeVdisplay('abc').text, 'Estado abc');
  assert.equal(describeVdisplay('abc').level, 'warn');
  assert.equal(describeVdisplay(1.5).level, 'warn');
});

test('describeVdisplay: ausente (outras plataformas) não é erro; valores absurdos não viram "pronto"', () => {
  for (const v of [undefined, null, '', '   ']) assert.deepEqual(describeVdisplay(v), { text: 'Não informado', level: 'none', help: '' }, `valor ${JSON.stringify(v)}`);
  assert.equal(describeVdisplay(false).level, 'warn', 'false não pode virar 0 = pronto');
  assert.equal(describeVdisplay(true).level, 'warn');
  assert.equal(describeVdisplay({}).level, 'warn');
  assert.equal(describeVdisplay([]).level, 'none', 'lista vazia vira texto vazio');
});

test('describeOrigin usa "lan" como padrão do servidor', () => {
  assert.equal(describeOrigin('pc').value, 'pc');
  assert.equal(describeOrigin('lan').value, 'lan');
  assert.equal(describeOrigin('wan').risky, true);
  assert.equal(describeOrigin('pc').risky, false);
  assert.equal(describeOrigin(undefined).value, 'lan');
  assert.equal(describeOrigin('xyz').value, 'lan');
  assert.equal(describeOrigin(' WAN ').value, 'wan');
});

test('kindLabel', () => {
  assert.equal(kindLabel('wifi', 'x'), 'Wi-Fi');
  assert.equal(kindLabel('lan'), 'Cabo');
  assert.equal(kindLabel('tailscale'), 'Tailscale (fora de casa)');
  assert.equal(kindLabel('vpn'), 'VPN');
  assert.equal(kindLabel('estranho', 'Ethernet 2'), 'Ethernet 2');
  assert.equal(kindLabel(undefined, undefined), 'Rede');
});

test('buildSupportText: sem senhas, sem endereços, com valores faltando', () => {
  const t = buildSupportText({ version: '1.2.3', platform: 'windows', vdisplay: { text: 'Pronto' }, pcName: 'MEU-PC', castName: 'Sala', logLevel: 'Informação', when: new Date(2026, 9, 19, 14, 5, 0) });
  assert.match(t, /Versão: 1\.2\.3/);
  assert.match(t, /Sistema operacional: Windows/);
  assert.match(t, /Driver de tela virtual: Pronto/);
  assert.match(t, /Nome do PC: MEU-PC/);
  assert.match(t, /Nível do log: Informação/);
  assert.match(t, /2026/);
  assert.ok(!/senha|password|ip/i.test(t.replace('Sistema operacional', '')), 'nada sensível no texto');
  const vazio = buildSupportText({});
  assert.match(vazio, /Versão: não informada/);
  assert.match(vazio, /Driver de tela virtual: não informado/);
  assert.match(vazio, /Nome do PC: não informado/);
});

/* ---------- Falhas de rede ---------- */
test('describeFailure dá uma instrução para cada família de status', () => {
  assert.match(describeFailure(0), /não está respondendo/);
  assert.match(describeFailure(undefined), /não está respondendo/);
  assert.match(describeFailure(null), /não está respondendo/);
  assert.match(describeFailure(401), /Sair da conta/);
  assert.match(describeFailure(403), /permissão/);
  assert.match(describeFailure(307), /ainda não tem usuário/);
  assert.match(describeFailure(302), /ainda não tem usuário/);
  assert.match(describeFailure(400), /não entendeu/);
  assert.match(describeFailure(500), /erro 500/);
  assert.match(describeFailure(503), /erro 503/);
  assert.match(describeFailure(418), /erro 418/);
});

test('interpretStatus: só {"status":true} com HTTP 2xx é sucesso', () => {
  assert.deepEqual(interpretStatus({ ok: true, status: 200, json: { status: true } }), { ok: true });
  const refused = interpretStatus({ ok: true, status: 200, json: { status: false } });
  assert.equal(refused.ok, false); assert.equal(refused.refused, true);
  const html = interpretStatus({ ok: true, status: 200, json: null, text: '<html>' });
  assert.equal(html.ok, false); assert.match(html.message, /inesperado/);
  assert.equal(interpretStatus({ ok: false, status: 0, json: null }).ok, false);
  assert.match(interpretStatus({ ok: false, status: 0, json: null }).message, /não está respondendo/);
  assert.match(interpretStatus({ ok: false, status: 401, json: { status: false, error: 'Unauthorized' } }).message, /sessão expirou/);
  assert.equal(interpretStatus({ ok: true, status: 200, json: { status: 'true' } }).ok, false, 'texto "true" não conta');
  assert.equal(interpretStatus(undefined).ok, false);
  assert.equal(interpretStatus(null).ok, false);
});

test('interpretQuit (R02): status 0 = a conexão caiu = sucesso provável; 200 vazio = falha', () => {
  assert.deepEqual(interpretQuit({ status: 0, ok: false, text: 'erro de rede' }), { outcome: 'dropped' });
  assert.deepEqual(interpretQuit({ ok: false }), { outcome: 'dropped' }, 'status ausente (a ponte devolveu só {error})');
  assert.deepEqual(interpretQuit(undefined), { outcome: 'dropped' });
  const f = interpretQuit({ status: 200, ok: true, text: '' });
  assert.equal(f.outcome, 'failed');
  assert.match(f.message, /não confirmou/);
  assert.equal(interpretQuit({ status: 200, ok: true, text: '{"status":true}', json: { status: true } }).outcome, 'failed');
  assert.equal(interpretQuit({ status: 401 }).outcome, 'failed');
  assert.match(interpretQuit({ status: 401 }).message, /sessão expirou/);
  assert.match(interpretQuit({ status: 403 }).message, /permissão/);
  assert.match(interpretQuit({ status: 307 }).message, /ainda não tem usuário/);
  assert.equal(interpretQuit({ status: 500 }).outcome, 'failed');
});

/* ---------- Troca de senha: validação ---------- */
const form = (o = {}) => ({ currentUsername: T.cu, currentPassword: T.cp, newUsername: '', newPassword: T.np, confirmNewPassword: T.np, ...o });

test('validatePasswordForm: caso feliz mantém o usuário quando o novo fica em branco', () => {
  const r = validatePasswordForm(form());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.warnings, {});
  assert.equal(r.effectiveUser, T.cu);
  assert.equal(r.newUsername, '');
});

test('validatePasswordForm: usuário novo vira o usuário efetivo (aparado)', () => {
  const r = validatePasswordForm(form({ newUsername: `  ${T.nu}  `, currentUsername: `  ${T.cu} ` }));
  assert.equal(r.ok, true);
  assert.equal(r.newUsername, T.nu);
  assert.equal(r.currentUsername, T.cu);
  assert.equal(r.effectiveUser, T.nu);
});

test('validatePasswordForm: campos obrigatórios vazios', () => {
  const r = validatePasswordForm({});
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ['confirmNewPassword', 'currentPassword', 'currentUsername', 'newPassword']);
  assert.equal(validatePasswordForm(form({ currentUsername: '   ' })).errors.currentUsername, 'Informe o usuário atual.');
  assert.equal(validatePasswordForm(form({ currentPassword: '' })).errors.currentPassword, 'Informe a senha atual.');
  assert.equal(validatePasswordForm(undefined).ok, false);
  assert.equal(validatePasswordForm(null).ok, false);
});

test('validatePasswordForm: confirmação diferente ou ausente', () => {
  assert.equal(validatePasswordForm(form({ confirmNewPassword: `${T.np}x` })).errors.confirmNewPassword, 'As senhas não são iguais.');
  assert.equal(validatePasswordForm(form({ confirmNewPassword: '' })).errors.confirmNewPassword, 'Repita a nova senha.');
  assert.equal(validatePasswordForm(form({ newPassword: '', confirmNewPassword: '' })).errors.newPassword, 'Digite a nova senha.');
  // maiúsculas importam
  assert.equal(validatePasswordForm(form({ confirmNewPassword: T.np.toUpperCase() })).ok, false);
});

test('validatePasswordForm: nova senha igual à atual só passa se o usuário também mudar', () => {
  const same = validatePasswordForm(form({ newPassword: T.cp, confirmNewPassword: T.cp }));
  assert.equal(same.ok, false);
  assert.match(same.errors.newPassword, /Nada mudou/);
  assert.equal(validatePasswordForm(form({ newPassword: T.cp, confirmNewPassword: T.cp, newUsername: T.cu })).ok, false, 'mesmo usuário digitado de novo');
  const onlyUser = validatePasswordForm(form({ newPassword: T.cp, confirmNewPassword: T.cp, newUsername: T.nu }));
  assert.equal(onlyUser.ok, true, 'trocar só o usuário é permitido (o servidor exige a senha de novo)');
  assert.equal(onlyUser.effectiveUser, T.nu);
});

test('validatePasswordForm: avisos (não bloqueiam)', () => {
  const curta = validatePasswordForm(form({ newPassword: 'abc', confirmNewPassword: 'abc' }));
  assert.equal(curta.ok, true);
  assert.match(curta.warnings.newPassword, /curta/);
  const espaco = validatePasswordForm(form({ newPassword: ` ${T.np}`, confirmNewPassword: ` ${T.np}` }));
  assert.equal(espaco.ok, true, 'espaços na senha são aceitos (a senha não é aparada)');
  assert.match(espaco.warnings.newPassword, /espaço/);
  assert.deepEqual(validatePasswordForm(form()).warnings, {});
});

test('validatePasswordForm: senha só com espaços é senha (não "vazia"), usuário só com espaços é vazio', () => {
  const r = validatePasswordForm(form({ newPassword: '        ', confirmNewPassword: '        ' }));
  assert.equal(r.ok, true);
  assert.equal(validatePasswordForm(form({ newUsername: '    ' })).effectiveUser, T.cu);
});

/* ---------- Troca de senha: erros do servidor ---------- */
test('explainPasswordError traduz os erros do servidor (R07) e indica o campo', () => {
  assert.deepEqual(explainPasswordError(400, 'Invalid Current Credentials'), { message: 'Usuário ou senha atuais incorretos.', field: 'currentPassword' });
  assert.deepEqual(explainPasswordError(400, 'invalid current credentials'), { message: 'Usuário ou senha atuais incorretos.', field: 'currentPassword' });
  assert.equal(explainPasswordError(400, 'Password Mismatch').message, 'As senhas não são iguais.');
  assert.equal(explainPasswordError(400, 'Password Mismatch').field, 'confirmNewPassword');
  assert.equal(explainPasswordError(400, 'Invalid Username').message, 'Informe o nome de usuário.');
  assert.match(explainPasswordError(400, 'Content type not provided').message, /Erro interno do painel/);
  assert.match(explainPasswordError(400, 'Content type mismatch').message, /Erro interno do painel/);
  assert.match(explainPasswordError(400, 'unexpected character at line 1').message, /não entendeu/);
  assert.match(explainPasswordError(401, 'Unauthorized').message, /sessão expirou/);
  assert.match(explainPasswordError(403, '').message, /permissão/);
  assert.match(explainPasswordError(307, undefined).message, /ainda não tem usuário/);
  assert.match(explainPasswordError(0, undefined).message, /não está respondendo/);
  assert.match(explainPasswordError(500, null).message, /erro 500/);
  assert.equal(explainPasswordError(401, 'Unauthorized').field, '');
});

/* ---------- Troca de senha: entrar de novo (R05/R08) ---------- */
function fakeLogin(rules) {
  const calls = [];
  const fn = async (user, pass) => {
    calls.push([user, pass]);
    const rule = rules.shift();
    return typeof rule === 'function' ? rule(user, pass) : rule;
  };
  fn.calls = calls;
  return fn;
}
const creds = { next: { user: 'novo-u', pass: 'nova-p' }, previous: { user: 'velho-u', pass: 'velha-p' } };

test('reloginAfterPasswordChange: entra com a senha nova', async () => {
  const login = fakeLogin([{ ok: true }]);
  assert.equal(await reloginAfterPasswordChange(login, creds, noWait), 'new');
  assert.deepEqual(login.calls, [['novo-u', 'nova-p']], 'só uma chamada, com as credenciais NOVAS');
});

test('reloginAfterPasswordChange: servidor recusou a nova → tenta a antiga (não gravou) e avisa', async () => {
  const login = fakeLogin([{ ok: false }, { ok: true }]);
  assert.equal(await reloginAfterPasswordChange(login, creds, noWait), 'old');
  assert.deepEqual(login.calls, [['novo-u', 'nova-p'], ['velho-u', 'velha-p']]);
});

test('reloginAfterPasswordChange: nenhuma serve', async () => {
  const login = fakeLogin([{ ok: false }, { ok: false }]);
  assert.equal(await reloginAfterPasswordChange(login, creds, noWait), 'none');
  assert.equal(login.calls.length, 2);
});

test('reloginAfterPasswordChange: sem resposta do servidor → tenta de novo uma vez e desiste sem testar a antiga', async () => {
  const waits = [];
  const login = fakeLogin([{ error: 'conexão recusada' }, { error: 'conexão recusada' }]);
  assert.equal(await reloginAfterPasswordChange(login, creds, async (ms) => { waits.push(ms); }), 'unreachable');
  assert.equal(login.calls.length, 2);
  assert.deepEqual(waits, [1200]);
  assert.ok(login.calls.every(([u]) => u === 'novo-u'), 'nunca tenta a senha antiga quando o servidor nem respondeu');
});

test('reloginAfterPasswordChange: falha de rede na 1ª tentativa e sucesso na 2ª', async () => {
  const login = fakeLogin([{ error: 'tempo esgotado' }, { ok: true }]);
  assert.equal(await reloginAfterPasswordChange(login, creds, noWait), 'new');
  assert.equal(login.calls.length, 2);
});

test('reloginAfterPasswordChange: respostas vazias/estranhas da ponte não quebram', async () => {
  assert.equal(await reloginAfterPasswordChange(fakeLogin([undefined, undefined]), creds, noWait), 'unreachable');
  assert.equal(await reloginAfterPasswordChange(fakeLogin([null, null]), creds, noWait), 'unreachable');
  assert.equal(await reloginAfterPasswordChange(fakeLogin([{}, {}]), creds, noWait), 'none', '{} sem ok e sem error = o servidor recusou');
});

test('reloginAfterPasswordChange: se o login lançar exceção, ela sobe (a tela trata no try/finally)', async () => {
  const login = async () => { throw new Error('boom'); };
  await assert.rejects(() => reloginAfterPasswordChange(login, creds, noWait), /boom/);
});

/* ---------- Revisão: nomes herdados do Object, nome no celular, pré-checagem do reinício, expiração de resultados ---------- */
test('platformLabel e kindLabel não confundem "constructor"/"__proto__" com um valor conhecido', () => {
  for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(platformLabel(k), k, 'valor desconhecido volta como veio, em texto');
    assert.equal(typeof kindLabel(k, 'Ethernet'), 'string', k);
    assert.equal(kindLabel(k, 'Ethernet'), 'Ethernet', k);
  }
  assert.equal(kindLabel('constructor'), 'Rede');
  assert.equal(platformLabel('WINDOWS'), 'Windows', 'o caso normal continua igual');
});

test('castNameOf: host_name do servidor primeiro, depois o nome configurado, por fim o do PC', () => {
  assert.equal(castNameOf({ hostName: 'Sala', configName: 'Outro', pcName: 'PC-LONGO-DEMAIS-1234' }), 'Sala');
  assert.equal(castNameOf({ hostName: '', configName: 'Outro', pcName: 'PC' }), 'Outro');
  assert.equal(castNameOf({ hostName: '   ', configName: undefined, pcName: 'PC' }), 'PC');
  assert.equal(castNameOf({ pcName: ' PC ' }), 'PC', 'apara espaços');
  assert.equal(castNameOf({}), '');
  assert.equal(castNameOf(), '');
  assert.equal(castNameOf({ hostName: 42, pcName: 'PC' }), 'PC', 'só texto vale');
});

test('describeRestartPrecheck: só barra o que também faria o reinício falhar (erro 5xx deixa seguir)', () => {
  assert.equal(describeRestartPrecheck({ ok: true, status: 200 }), '');
  assert.match(describeRestartPrecheck({ ok: false, status: 0 }), /não há o que reiniciar/);
  assert.match(describeRestartPrecheck({ ok: false, status: 0 }), /Menu Iniciar/);
  assert.match(describeRestartPrecheck({ ok: false, status: 401 }), /sessão expirou/);
  assert.match(describeRestartPrecheck({ ok: false, status: 403 }), /permissão/);
  assert.match(describeRestartPrecheck({ ok: false, status: 307 }), /ainda não tem usuário/);
  assert.match(describeRestartPrecheck({ ok: false, status: 400 }), /não entendeu/);
  // 5xx: o servidor está ligado e com problema; é justamente quando reiniciar ajuda
  for (const s of [500, 502, 503]) assert.equal(describeRestartPrecheck({ ok: false, status: s }), '', `status ${s}`);
  assert.match(describeRestartPrecheck(undefined), /não há o que reiniciar/);
  assert.match(describeRestartPrecheck({}), /não há o que reiniciar/);
});

test('shouldClearResult: "encerrado" e "não voltou" só valem com o servidor fora do ar', () => {
  const base = { ageMs: 5000, online: false, hasApp: false, aged: false };
  // servidor voltou: some o "encerrado" (ok e aviso) e o "não voltou"
  assert.equal(shouldClearResult({ ...base, id: 'quit', kind: 'ok', online: true }), true);
  assert.equal(shouldClearResult({ ...base, id: 'quit', kind: 'warn', online: true }), true);
  assert.equal(shouldClearResult({ ...base, id: 'restart', kind: 'bad', online: true }), true);
  // continua fora do ar: ainda é verdade, mesmo muito tempo depois
  assert.equal(shouldClearResult({ ...base, id: 'quit', kind: 'ok', aged: true, ageMs: 10 * 60 * 1000 }), false);
  assert.equal(shouldClearResult({ ...base, id: 'restart', kind: 'bad', aged: true, ageMs: 10 * 60 * 1000 }), false);
  // erro do quit ("não confirmou") não depende do servidor: só expira por idade
  assert.equal(shouldClearResult({ ...base, id: 'quit', kind: 'bad', online: true }), false);
  assert.equal(shouldClearResult({ ...base, id: 'restart', kind: 'ok', online: true }), false);
});

test('shouldClearResult: resultado de "Forçar fechamento" acompanha o aplicativo; o que é velho sai ao voltar à tela', () => {
  const base = { ageMs: 5000, online: true, hasApp: false, aged: false };
  assert.equal(shouldClearResult({ ...base, id: 'close_app', kind: 'ok', hasApp: true }), true, 'outro aplicativo começou');
  assert.equal(shouldClearResult({ ...base, id: 'close_app', kind: 'ok', hasApp: false }), false);
  assert.equal(shouldClearResult({ ...base, id: 'close_app', kind: 'warn', hasApp: false }), true, 'já não há aplicativo: o aviso "ainda aparece" é falso');
  assert.equal(shouldClearResult({ ...base, id: 'close_app', kind: 'warn', hasApp: true }), false);
  // idade só conta quando a pessoa volta à tela (aged)
  assert.equal(shouldClearResult({ ...base, id: 'dd_reset', kind: 'ok', ageMs: RESULT_TTL_MS + 1 }), false, 'enquanto a pessoa olha, não some sozinho');
  assert.equal(shouldClearResult({ ...base, id: 'dd_reset', kind: 'ok', ageMs: RESULT_TTL_MS + 1, aged: true }), true);
  assert.equal(shouldClearResult({ ...base, id: 'dd_reset', kind: 'ok', ageMs: RESULT_TTL_MS - 1, aged: true }), false);
  assert.equal(shouldClearResult({ ...base, id: 'close_app', kind: 'bad', ageMs: RESULT_TTL_MS + 1, aged: true }), true);
  // nunca apaga o que está em andamento nem o que não existe
  assert.equal(shouldClearResult({ ...base, id: 'restart', kind: 'progress', ageMs: 9e9, aged: true, online: false }), false);
  assert.equal(shouldClearResult({ ...base, id: 'restart', kind: '', ageMs: 9e9, aged: true }), false);
  assert.equal(shouldClearResult({ ...base, id: 'restart', kind: null }), false);
  assert.equal(shouldClearResult(), false);
});
