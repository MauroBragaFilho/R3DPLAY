# Painel R3D PLAY — guia de desenvolvimento (contrato das telas)

A janela **R3D PLAY** (`tools/ApolloConfig`) é um app WinForms que hospeda uma interface web (pasta `ui/`) num WebView2.
A interface fala com o servidor (Apollo, `https://localhost:47990`) **só pela ponte nativa** (`native('api', …)`, ver `ui/js/core.js`).
Meta desta interface: **tudo numa janela só, sem abrir navegador e sem janela de "opções avançadas"** — as configurações avançadas
ficam dentro da tela Configurações. Texto sempre em **português do Brasil**, para gente que não é técnica; o termo técnico vem na ajuda, não no rótulo.

## 1. Abas e responsabilidades

| Aba | id | Arquivo | O que faz |
|---|---|---|---|
| Início | `home` | `js/views/home.js` | Estado do servidor, "Conectar um celular" (passos + endereços IP), resumo, uso do PC ao vivo, atalhos (procurar jogos, encerrar transmissão, ir a Dispositivos) |
| Jogos | `games` | `js/views/games.js` | Grade de jogos/apps com capas, detectar jogos, adicionar/editar/remover/reordenar app, iniciar/encerrar |
| Dispositivos | `devices` | `js/views/devices.js` | Parear (PIN e OTP/QR), lista de celulares, permissões, opções por dispositivo, desconectar/desparear |
| Configurações | `settings` | `js/views/settings.js` | TODAS as chaves do `sunshine.conf` (schemas), com busca, Essenciais/Todas, barra de alterações, salvar/reiniciar |
| Sistema | `system` | `js/views/system.js` | Informações, ações (forçar fechar app, reiniciar, encerrar, redefinir monitor), segurança (senha, sair), registro (log) |

O shell (`index.html`, `js/main.js`, `js/core.js`, `js/lib/config.js`, `css/components.css`, `style.css`) é **compartilhado e congelado**:
quem precisar de uma mudança neles **não edita**: descreve no campo `coreRequests` do relatório. Cada tela é dona só dos seus arquivos (seção 2).

## 2. Propriedade de arquivos (ninguém edita arquivo de outro dono)

| Dono | Pode criar/editar |
|---|---|
| settings | `js/views/settings.js`, `js/lib/schema.js`, `js/lib/serialize.js`, `js/lib/widgets/*.js`, `css/settings.css`, `dev/tests/settings*.test.mjs` |
| games | `js/views/games.js`, `js/lib/library.js`, `js/lib/appmodel.js`, `js/lib/appeditor.js`, `js/lib/addwizard.js`, `js/lib/programs.js`, `css/games.css`, `dev/tests/games*.test.mjs` |
| devices | `js/views/devices.js`, `js/lib/perms.js`, `js/lib/pairing.js`, `js/lib/qr.js`, `css/devices.css`, `dev/tests/devices*.test.mjs` |
| home | `js/views/home.js`, `js/lib/stats.js`, `css/home.css`, `dev/tests/home*.test.mjs` |
| system | `js/views/system.js`, `js/lib/logs.js`, `css/system.css`, `dev/tests/system*.test.mjs` |

Interfaces entre telas (o que cada dono PRECISA exportar, porque outras telas dependem):

- `js/lib/library.js` (games): `export async function detectGames({ manual = false } = {})` → `{ found:number, added:number }` (escaneia com `native('scan')`, adiciona jogos novos, aplica a política dos detectados e baixa capas; `manual=true` mostra toast); `export async function autoSync()` (= `detectGames({manual:false})`, silencioso; o `main.js` a chama depois do login).
- Navegação entre telas: `go('devices', { focus: 'pair' })` (de `core.js`). Cada tela lê `params` em `show(params)`. Parâmetros aceitos: `settings` → `{ key: 'min_log_level' }` (troca de categoria, mostra avançadas se preciso e destaca o campo), `{ category: 'network' }`, `{ q: 'porta' }`; `games` → `{ detect: true }` (busca manual), `{ add: true }` (editor de novo app), `{ focus: 'search' }`; `devices` → `{ focus: 'pair' }`; `system` → `{ section: 'logs', level: 'fatal' }`.
- Eventos do `bus` (core): `apps` (lista/estado de transmissão mudou), `online`, `restarting`, `restarted`, `devices` (a lista de dispositivos mudou: quem altera dispositivos emite).

## 3. Contrato de uma tela

```js
import { h, icon, api, state, bus, toast, confirmDlg, modal, busy, restartServer, go } from '../core.js';
export default {
  id: 'games', tab: 'Jogos', title: 'Jogos',          // tab = rótulo curto da aba; title = título da página
  mount(root) { /* 1ª exibição: construa o DOM dentro de root (<section class="screen">). Só uma vez. */ },
  async show(params) { /* toda vez que a aba abre: recarregue dados, inicie polling */ },
  hide() { /* ao sair: pare timers/polling */ },
  async canLeave() { return true; },                   // opcional: false cancela a troca de aba (ex.: configurações não salvas; pergunte ao usuário antes)
};
```

- Construa o DOM com `h()` e `icon()` (core.js). **Nunca** monte HTML com texto vindo do servidor/arquivos sem `esc()`; prefira `h(tag, {text})`.
- Escute `bus` e **cancele** (`const off = bus.on(...)`; chame `off()` em `hide()`) para não acumular ouvintes.
- Polling só enquanto a tela está visível (`show` liga, `hide` desliga) e nunca com intervalo menor que 3 s.
- Toda ação assíncrona de botão usa `busy(btn, fn)` (regra R03: botão nunca fica travado) e mostra toast de sucesso/erro **em português**.
- Estados obrigatórios: carregando (use `.skeleton` ou `.spinner`), vazio (`.empty` com ícone e o próximo passo), erro (`.banner.bad` com o que fazer), servidor fora do ar (`!state.online`: mostre aviso, não quebre).
- Ações destrutivas ou que derrubam a transmissão: `confirmDlg(...)` com texto claro ("Isso encerra a transmissão em andamento").

## 4. API do `core.js` (leia o arquivo; resumo)

`h, icon, $, $$, esc, sleep` · `bus.on/emit`, `go(tab, params)` · `native(cmd, data)` · `api(method, path, obj)` → `{status, ok, json, text}`
(POST sem corpo envia `{}`; `status 0` = servidor fora do ar/reiniciando; 307/302 = ainda sem usuário) · `state` (`apps`, `currentApp`, `online`, `meta`) ·
`loadApps()`, `setOnline()` · `toast(msg, 'ok'|'err'|'')` · `confirmDlg(msg, yes, {danger,title,no})` · `modal({title, body, actions, wide, onOpen})` ·
`busy(btn, fn)` · `waitForServer()`, `restartServer()` · `fmt.bytes/pct` · `log(text)` (vai para `%LOCALAPPDATA%\ApolloConfig\ui.log`).

Comandos nativos (`native(cmd, data)`): `api`, `login{user,pass}`, `logout`, `hasCreds`, `scan` (`{games:[{source,id,name,uuid,app}]}`), `cover{source,gameId,name}` (`{data: base64 PNG|null}`),
`readCover{path}` (`{data}`), `info` (`{host, ips:[{name,ip,kind: wifi|lan|tailscale|vpn}], url}`), `stats{port?}` (`{ok, body}` com o JSON abaixo, porta HTTP 47989), `log{text}`.

Comandos de "Adicionar aplicativo" (`ProgramScanner.cs`, `FilePicker.cs`; falha SEMPRE como `{ error: "mensagem em português" }`, nunca lança para a interface):

| Comando | Resposta |
|---|---|
| `installedPrograms {}` | `{ programs: [{ name, exe, args, dir, source: startmenu\|registry\|apppaths, icon }], scannedMs }`. Já sem lixo (desinstaladores, instaladores, redistribuíveis, atualizadores, ajuda…), ordenado em pt-BR, no máximo 800. `icon` = PNG 32×32 em base64 sem `data:` (ou `null`). `args` vem do atalho (ex.: `--cd-to-home`, `/memoryWindow start`). **O mesmo `exe` pode aparecer várias vezes com `args` diferentes**: a chave de um programa é exe + argumentos (`programKey` em `programs.js`). `dir` nunca é pasta de versão (`app-X.Y.Z`), do Menu Iniciar ou da Área de Trabalho. Jogos da Steam ficam de fora de propósito (já entram por "Detectar jogos"). |
| `pickFile { title? }` | `{ cancelled: true }` ou `{ path }`. Caixa nativa do Windows (`.exe`, `.lnk`, `.bat`, `.cmd`; um `.lnk` escolhido volta como `.lnk`, para o `inspectProgram` resolver o destino). |
| `pickFolder { title? }` | `{ cancelled: true }` ou `{ folder, candidates: [{ path, name, size }] }`. `name` = nome do arquivo com extensão; `size` em bytes. **`candidates` já vem do mais para o menos provável** (a interface mantém essa ordem: `rankCandidates(..., { trustOrder: true })`). |
| `findExe { folder }` | O mesmo `{ folder, candidates }` do `pickFolder`, sem abrir caixa (pasta arrastada para a janela). `folder` vazio devolve `candidates: []` (a interface usa isso para descobrir se o app nativo sabe ler pastas soltas). |
| `inspectProgram { path }` | `{ ok: true, kind: exe\|lnk\|bat\|other, path (para .lnk: o .exe de destino), args, dir, name, product, description, company, version, icon, shortcutName (só em lnk) }` ou `{ ok: false, error, isFolder? }`. Nunca executa o arquivo. `name` já é o nome sugerido pelo app nativo (o que mais lembra o arquivo entre produto e descrição; em atalho, o nome do atalho). `isFolder: true` quando o caminho é uma pasta. |
| `droppedFiles` | Só via `nativeFiles(cmd, FileList)` do `core.js` (`postMessageWithAdditionalObjects` do WebView2): `{ paths: [caminho completo, …] }` dos arquivos/pastas soltos na janela. |

Fluxo na interface: `js/lib/addwizard.js` (passo 1: programas instalados, arquivo, pasta, arrastar e soltar) → `js/lib/appeditor.js` (passo 2, o mesmo para criar e editar; tudo o que é técnico fica em "Opções avançadas"). A lógica pura (busca, nome sugerido, comando, ranking) está em `js/lib/programs.js` e é testada com respostas reais do C# em `dev/tests/games-programs-bridge.test.mjs`. O aplicativo salvo para um programa é `{ name, cmd: "caminho do exe" + " " + args, working-dir: dir, virtual-display: true, terminate-on-pause: true, …padrões do schema }`.

Testar a ponte nativa SEM abrir janela (grava em UTF-8 sem BOM o mesmo JSON que a ponte devolveria): `ApolloConfig.exe --programs saida.json`, `--inspect <arquivo> saida.json`, `--find-exe <pasta> saida.json` (compile em pasta temporária: `dotnet build -c Release -o "%TEMP%\r3d-cs-build"`). `node tools/ApolloConfig/dev/check-programs.mjs [ApolloConfig.exe] [--json saida.json] [--no-deep] [--wide]` roda todas as conferências do C#. Variáveis só de teste: `R3D_PROGRAMS_EXTRA_LNK_DIR` (pasta extra de atalhos varrida pelo `--programs`) e `R3D_PROGRAMS_TRACE` (arquivo com os tempos de cada etapa da varredura).

`GET http://localhost:47989/r3d/stats` (sem senha) devolve, por exemplo:
```json
{"cpu":{"name":"…","temp_c":null,"threads":8,"usage":12.5},"disks":[{"name":"C:","total":509874270208,"used":421561851904}],
 "gpus":[{"name":"NVIDIA GeForce GTX 1650","temp_c":59,"usage":66,"vendor":"nvidia","vram_total":4294967296,"vram_used":1262972928}],
 "host":"MNBF-NEON","ram":{"total":25542582272,"used":22984445952},"stream":{"active":false,"fps":0.0}}
```
(`usage`/`temp_c`/`vram_used` podem ser `null`; a primeira leitura de CPU costuma vir `null`; há várias GPUs.)

`js/lib/config.js` (compartilhado): `readConfig()`, `writeConfig(valuesCompletos)`, `patchConfig({chave: valor|null})`, `splitConfig`, `sameValue`, `checkValue`, `META_KEYS`.

## 5. Regras do servidor (obrigatórias)

Fonte de verdade: `ui/schema/_serializacao.md` (configuração) e os schemas JSON (`general, audiovideo, encoders, inputs, network, advanced, outros` = opções;
`apps` = editor de apps; `clients` = dispositivos e permissões; `system` = manutenção/segurança). Os schemas têm `label`, `help`, `default`, `showIf`, `advanced`, `platform`, `serialize`, `notes`.
Resumo das armadilhas que já derrubaram a interface antiga:

1. `GET /api/config` devolve strings + 4 chaves de metadados (`status, platform, version, vdisplayStatus`) que **nunca** voltam no POST. `POST /api/config` **substitui o arquivo inteiro**: sempre GET → mesclar → POST (use `patchConfig`/`writeConfig`).
2. Booleanos do `.conf` = `"enabled"`/`"disabled"` (minúsculas); inteiros puros; listas (`global_prep_cmd`, `global_state_cmd`, `server_cmd`, `dd_mode_remapping`) vão como JSON real (array/objeto), `dd_mode_remapping` sempre com as 3 listas. Sem `\n`/`\r` em strings; `#` em texto livre é **bloqueado** (o servidor corta o valor no `#` e a conferência por GET reprova). O servidor descarta `""`/`null`. Toda chave de configuração só vale após **reiniciar**.
3. POST sempre com corpo JSON (o `api()` já manda `{}`). `restart`: a conexão cai (status 0 = reiniciando, **não é erro**); `quit`: status 0 = sucesso.
4. `POST /api/clients/update` **substitui o dispositivo inteiro**: GET lista → copiar o objeto → trocar o campo → remover `connected` → enviar tudo. `perm` é número.
5. `POST /api/apps` com `uuid` existente edita; sem uuid cria (o servidor responde só `{status:true}`: reler `GET /api/apps`). `GET /api/apps` traz `current_app`.
6. Uma única sessão global no servidor: trocar a senha ou entrar de outro lugar derruba a sessão (a ponte nativa refaz o login com a senha guardada; depois de trocar a senha chame `native('login', {user, pass})` com as novas credenciais).
7. `/api/logs` é texto UTF-8 (o app nativo já decodifica certo); o arquivo inteiro vem a cada chamada.

## 6. Componentes de CSS prontos (`css/components.css`, variáveis em `style.css`)

`.field` (+`.f-label`, `.f-help`, `.f-error`, `.field.row`), `.switch` (use `<label class="switch">`: com `<span>` o clique não alterna), `.seg`, `.badge(.ok/.warn/.bad/.live)`, `.banner(.warn/.bad/.ok)`, `.subtabs`, `.split` + `.sidenav`, `.savebar`, `.table`, `.kv`, `details.fold`, `dialog.modal`, `.meter`, `.spinner`, `.skeleton`, `.cards`, `.card` / `.card-head`, `.btn(.primary/.danger/.ghost)`, `.icon-btn`, `.chip`, `.toolbar`, `.search`, `.empty`, `.row-actions`.
Estilo da casa: cantos chanfrados (`clip-path: var(--clip)`), vermelho `--accent` para ação principal, ciano `--cyan` só em detalhes, rótulos de seção `h3` "// TÍTULO" em mono, ícones Material Symbols (`icon('settings')`; use nomes comuns). Estilos próprios de uma tela vão **só no CSS dela** (`css/<tela>.css`), com prefixo da tela nas classes (ex.: `.gm-`, `.dv-`, `.st-`, `.hm-`, `.sy-`).
Largura: funciona de 1280×820 até ~720 px de largura (a janela tem mínimo 900×600). Respeite `prefers-reduced-motion`. Foco visível e navegação por teclado; `aria-label` em botões só de ícone.

## 7. Como testar

**Lógica pura** (sem DOM, sem `window`): coloque em `js/lib/*.js` e teste com o Node (v24): `node --test "tools/ApolloConfig/dev/tests/*.test.mjs"` (com aspas: no Windows o Node não aceita a pasta sozinha). Módulos de lib que importam `../core.js` continuam importáveis no Node (o core protege `window`). Teste serialização, validação, presets de permissão, política dos jogos, parsing de log etc. com casos bons, ruins e de borda.

**Interface no navegador** (sem WebView2): `dev/devserver.mjs` serve `ui/` e imita a ponte nativa falando com o servidor real **em modo seco**:
leituras (GET) são reais; gravações (POST) **não são enviadas**: ficam numa sobreposição em memória (a tela "salva" e relê) e são registradas em `GET /__mutations` (corpo exato que a tela mandou). `GET /__reset` limpa.

```bash
# cada agente usa a SUA porta para não misturar o registro de gravações (5181 settings, 5182 games, 5183 devices, 5184 home, 5185 system, 5200+ revisores)
export PATH="/c/Program Files/nodejs:$PATH"
node tools/ApolloConfig/dev/devserver.mjs --port=5181 > /tmp/dev5181.log 2>&1 &     # em segundo plano
# parar SÓ a sua instância (PowerShell; o Git Bash não tem pkill):
#   Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -like '*devserver.mjs*--port=5181*' } | % { Stop-Process -Id $_.ProcessId -Force }
curl -s http://127.0.0.1:5181/__mutations
```
**"Adicionar aplicativo" no navegador**: por padrão o devserver INVENTA as respostas de `installedPrograms`, `pickFile`, `pickFolder`, `inspectProgram`, `findExe` e `droppedFiles` (nada toca o disco). Modos: `GET /__sim?programs=ok|many|empty|error|slow|old&pickFile=ok|cancel|error&pickFolder=one|many|none|cancel|error&findExe=on|off&saveFail=on|off`.
Com **dados reais** do C# (só lê o disco; não executa programa nenhum): `$env:R3D_NATIVE_EXE="$env:TEMP\r3d-cs-build\ApolloConfig.exe"` antes de iniciar o devserver faz `installedPrograms`, `inspectProgram` e `findExe` rodarem o app nativo de verdade pelas flags `--programs`/`--inspect`/`--find-exe`. As caixas do Windows continuam simuladas, mas podem devolver um caminho real: `GET /__sim?pickFilePath=<arquivo>&pickFolderPath=<pasta>&dropPaths=<caminho1>|<caminho2>` (com `pickFolderPath`, os candidatos vêm do C# real; valor vazio desliga).
Abra `http://127.0.0.1:<porta>/index.html#settings` no navegador embutido (ferramentas `mcp__Claude_Browser__*`, carregue com ToolSearch). **Use uma aba sua** (`tabs_create`, passe sempre o `tabId`) e feche-a ao terminar; não mexa nas abas dos outros. Meça com `resize_window` (1280×820 e 760×800) e confira o console (`read_console_messages`).
Só dá para validar a interface pelo navegador; o WebView2 real é testado depois, pelo integrador.

**Regras de segurança dos testes** (o dono do PC está renderizando vídeo e usando a GPU): nunca use `R3D_DRY=0`; nunca inicie jogo/transmissão; não rode builds pesados (nada de `ninja`, `cmake`, `dotnet publish`, gradle). Não crie arquivos fora da sua propriedade. Não use dados reais do usuário (senhas etc.) em arquivos ou mensagens.

## 8. Critérios de qualidade (revisores usam esta lista)

1. Fidelidade ao schema: cada opção/campo do schema da tela está acessível (a menos que `nao_portado`), com rótulo, ajuda, default, faixa, unidade e `showIf`/`platform` respeitados.
2. Serialização correta e testada (seção 5), inclusive o que **não** deve ser enviado.
3. Nenhum botão fica travado (R03); toda falha de rede vira mensagem clara; `status 0` tratado.
4. Sem XSS: nada de `innerHTML`/`html:` com texto externo sem `esc()`.
5. Sem vazamento: ouvintes `bus` e timers cancelados em `hide()`; sem polling com a aba fechada.
6. Acessibilidade e teclado: rótulos associados (`for`/`id` ou `label` envolvendo), foco visível, `Esc` fecha janelas, ordem de tabulação lógica.
7. Visual coerente com o resto (chanfro, tokens de cor), sem rolagem horizontal, bom em 1280×820 e ~760 px.
8. Textos em português correto (acentos), sem jargão desnecessário, sem "Apollo"/"Sunshine"/"Moonlight" visíveis (a marca é **R3D PLAY**; o app do celular é o **R3D LAUNCHER**; o termo "Moonlight" só como nome do protocolo quando indispensável). Exceção: nomes técnicos literais que o usuário precisa digitar ou reconhecer (variáveis `APOLLO_*`, nomes de arquivos, caminhos, comandos).
9. Sem mudanças fora dos seus arquivos; sem dependências externas (nenhum CDN, nenhuma biblioteca: JavaScript simples em módulos ES).

## 9. Estado e ferramentas de integração

- `state` (core.js): `online` (false só sem resposta HTTP), `lastStatus` (0 = sem resposta, 5xx = respondeu com erro), `hostName`, `sessionBusy` (true durante a troca de senha: o polling do `main.js` pula esse intervalo), `meta`.
- `restartServer()` lê a chave `port` antes de reiniciar e avisa a ponte (`native('rebase', {port})`): o painel web fica em porta + 1 e o app nativo passa a falar com a porta nova. Recusa imediata do servidor (400/401/403/5xx) devolve `false` sem esperar.
- Telas com alterações não salvas exportam `isDirty()`; o `main.js` expõe `window.__r3dDirty()` e o app nativo pergunta ao fechar a janela.
- Testar a janela REAL (WebView2): `dev/cdp-shot.mjs` (ver o cabeçalho do arquivo). Variáveis só de teste: `R3D_ALLOW_MULTI=1` (segunda janela), `R3D_WEBVIEW_DIR` (pasta própria do WebView2) e `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`.
