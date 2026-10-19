# Serialização da configuração do Apollo

Como o painel original (`config.html` + componentes Vue) carrega, transforma, grava e reinicia a configuração. Referência para qualquer UI que substitua o painel (o ApolloConfig).

Fontes lidas por inteiro ou nas funções citadas:

| Arquivo | O que foi lido |
|---|---|
| `src_assets/common/assets/web/config.html` | arquivo inteiro (546 linhas): `data()`, `created()`, `serialize()`, `save()`, `apply()` |
| `src_assets/common/assets/web/Checkbox.vue` | regra que decide o vocabulário de booleanos |
| `src_assets/common/assets/web/configs/tabs/**/*.vue` | todos os campos, tipos de input e condições de exibição |
| `src/confighttp.cpp` | `getConfig` (997-1016), `getLocale` (1025), `saveConfig` (1049-1079), `restart` (1327-1338), `authenticate`, `validateContentType`, `bad_request` |
| `src/config.cpp` | `parse_option`/`parse_config` (654-715), todos os `*_f` (717-1052), `apply_config` (1091-1387), `parse` (1389+) |
| `src/platform/windows/misc.cpp` | `platf::restart()` (1289) |
| `C:\Program Files\Apollo\config\sunshine.conf` e `sunshine.log` | exemplos reais de arquivo e de log |

Tudo abaixo vem da leitura do código. Os pontos que dependem de comportamento em execução (e não foram executados) estão marcados como **[inferido]**.

---

## 0. Resumo em 12 regras

1. `GET /api/config` devolve **o conteúdo do arquivo `sunshine.conf`** (não o estado em memória) + 4 chaves extras: `status`, `platform`, `version`, `vdisplayStatus` (esta só no Windows). Essas 4 **nunca** podem voltar no POST.
2. **Todo valor vem como string**, inclusive números e as listas (que chegam como string contendo JSON). Defaults não vêm: o painel os preenche no navegador.
3. `POST /api/config` **substitui o arquivo inteiro**. Chave ausente no corpo = linha apagada do `sunshine.conf` (volta ao default do C++). Sempre fazer GET, mesclar, POST.
4. O servidor **descarta** valores `null` e string vazia `""`. Não descarta `0`, `false`, `[]`.
5. O servidor grava **string crua** (sem aspas, sem escape) e **qualquer outro tipo via `dump()`**: número vira `48000`/`24.9`; array/objeto vira JSON compacto de uma linha com **chaves em ordem alfabética**; boolean JSON vira `true`/`false`.
6. O painel envia booleanos como a **string** `"enabled"`/`"disabled"` (nunca `true`/`false`). `true`/`false` JSON também funcionam, mas `"disabled"` ≠ `false` para quem compara strings.
7. Listas/objetos (`global_prep_cmd`, `global_state_cmd`, `server_cmd`, `dd_mode_remapping`) são enviados como **array/objeto JSON de verdade** no POST (o servidor serializa). No GET voltam como **string**.
8. Antes de enviar, o painel **remove toda chave cujo valor seja igual ao default** (comparação por `JSON.stringify`, sensível a tipo) e filtra itens vazios das listas.
9. Não existe campo "reinicia" vs "aplica na hora". **Todas as chaves exigem reinício**: `apply_config` só roda uma vez, no boot (`config::parse`, `main.cpp:162`).
10. Fluxo: **Salvar** = `POST /api/config`. **Aplicar** = Salvar + `POST /api/restart`. O restart nunca responde (o processo morre); a UI recarrega a página.
11. As chaves `resolutions` e `fps` **não existem** nesta versão (nem no painel, nem no `apply_config`). Os únicos arrays/objetos são os 4 acima, mais `keybindings` (que é uma string).
12. O parser do `.conf` **não é JSON**: `#` inicia comentário (trunca o valor), quebra de linha termina o valor, inteiros são lidos de forma ingênua (sem decimais). Veja a seção 9.

---

## 1. Visão geral do fluxo

```
 sunshine.conf (texto, "chave = valor", CRLF no Windows)
      │  parse_config()  (config.cpp:692)  -> unordered_map<string,string>
      ▼
 GET /api/config  ──►  { status, platform, version, vdisplayStatus, ...todas as chaves do arquivo como STRING }
      │
      ▼   config.html created()
 this.config (strings do arquivo + defaults tipados + 4 listas parseadas)
      │   usuário edita (v-model)
      ▼   serialize() + remoção de defaults
 POST /api/config  ──►  saveConfig(): para cada (k,v): pula null/""; string crua, resto dump(); reescreve o arquivo
      │
      ▼   (botão Aplicar)
 POST /api/restart ──►  proc::proc.terminate(); platf::restart()  -> processo sai e é recriado
      │
      ▼   no boot
 config::parse() -> parse_config() -> apply_config()  (único ponto onde os valores entram em config::video/input/...)
```

A UI do painel e o C++ nunca conversam por tipos: o arquivo é texto puro e **cada chave é interpretada por uma função `*_f` específica** na hora de ler (seção 3.4).

---

## 2. (a) Como o painel carrega o objeto de configuração

### 2.1 Resposta de `GET /api/config`

`getConfig` (confighttp.cpp:997):

```cpp
output_tree["status"]   = true;
output_tree["platform"] = SUNSHINE_PLATFORM;          // "windows" | "linux" | "macos"
output_tree["version"]  = PROJECT_VERSION;            // ex.: "0.0.0.98695412.dirty"
#ifdef _WIN32
output_tree["vdisplayStatus"] = (int)proc::vDisplayDriverStatus;   // NÚMERO JSON
#endif
auto vars = config::parse_config(file_handler::read_file(config::sunshine.config_file.c_str()));
for (auto &[name, value] : vars) output_tree[name] = value;          // std::string -> sempre string JSON
```

Consequências:

| Fato | Detalhe |
|---|---|
| Autenticação | exige cookie de sessão (`authenticate`); sem Content-Type obrigatório no GET |
| Fonte | o **arquivo** no disco, lido a cada chamada. Logo, depois de salvar (sem reiniciar) o GET já mostra os valores novos, embora o processo em execução ainda use os antigos |
| Só chaves presentes | defaults **não** são devolvidos; chave ausente = "usa o default" |
| Tipos | `status` é boolean; `vdisplayStatus` é número; **todo o resto é string** (`"port":"47989"`, `"upnp":"enabled"`, `"server_cmd":"[{...}]"`) |
| Ordem das chaves | alfabética (`nlohmann::json` usa `std::map`) |
| Colisão | se o `.conf` tiver uma chave chamada `status`/`platform`/`version`/`vdisplayStatus`, o valor do arquivo (string) **sobrescreve** o valor real, porque o laço roda depois. É o que acontece se um cliente reenviar essas chaves no POST |
| `vdisplayStatus` | valores do enum `VDISPLAY::DRIVER_STATUS`: `1`=Desconhecido, `0`=Pronto, `-1`=Não inicializado, `-2`=Versão incompatível, `-3`=Watchdog falhou |

`GET /api/configLocale` (sem autenticação) devolve `{"status":true,"locale":"<config::sunshine.locale>"}`: o idioma **em memória** (vale o do último boot).

### 2.2 O que o `created()` faz com a resposta (config.html:330-412)

Ordem exata:

1. `this.config = r` e `this.platform = r.platform`.
2. **Filtra abas por plataforma** (`this.tabs`):
   - windows remove `vt` e `vaapi` → abas: general, input, av, network, files, advanced, nv, qsv, amd, sw
   - linux remove `amd`, `qsv`, `vt`
   - macos remove `amd`, `nv`, `qsv`, `vaapi`
3. **Apaga do objeto**: `platform`, `status`, `version`. Guarda `vdisplayStatus` em `this.vdisplayStatus` e apaga também. (Por isso essas 4 chaves nunca vão no POST. Em não-Windows `vdisplayStatus` é `undefined`.)
4. `fallbackDisplayModeCache = config.fallback_mode || ""` (usado na validação do `serialize`).
5. **Chaves especiais** `["dd_mode_remapping","global_prep_cmd","global_state_cmd","server_cmd"]`: se o valor é `string` → `JSON.parse` (se o JSON for inválido a exceção aborta o resto do `created()`: defaults não são aplicados e o painel fica meio carregado); se não for string → `null`. Depois `??=`:
   - `dd_mode_remapping` → `{mixed: [], resolution_only: [], refresh_rate_only: []}`
   - as 3 listas → `[]`
6. **Preenche defaults**: para cada `tab.options[key]` (das abas que sobraram), se `config[key] === undefined`, copia por valor (`JSON.parse(JSON.stringify(...))`) o default **tipado** (números como número, `"enabled"` como string). Aqui os defaults de aba servem de única fonte de verdade da UI (tabela do Apêndice A).
7. Cria `global_prep_cmd`, `global_state_cmd`, `server_cmd` como arrays separados no `data()`:
   - **Windows**: `.map(i => { i.elevated = !!i.elevated; return i })` (todo item ganha `elevated` booleano)
   - outras plataformas: usa o array direto (o campo `elevated` não existe/não é exibido)

Estado resultante em memória (misto de tipos): valores que vieram do arquivo continuam **strings**; valores que são default entram **tipados**.

| Origem do valor | Exemplo | Tipo JS na memória |
|---|---|---|
| veio do `.conf` | `port = 48000` | `"48000"` (string) |
| default do painel | porta ausente do `.conf` | `47989` (number) |
| veio do `.conf`, lista | `server_cmd = [...]` | array (após `JSON.parse`) |
| veio do `.conf`, checkbox | `upnp = enabled` | `"enabled"` |

---

## 3. (b) Como cada tipo de valor é transformado ao salvar

### 3.1 No navegador (`serialize()` + `save()`)

`save()` (config.html:432) chama `serialize()` e depois remove defaults.

**`serialize()` (config.html:418):**

1. Validação do `fallback_mode`: se não-vazio e **não** casar `^\d+x\d+x\d+$`, é substituído pelo último valor válido (`fallbackDisplayModeCache`, inicialmente o do arquivo); senão atualiza o cache. Atenção: o input do `AudioVideo.vue` aceita FPS decimal (`^\d+x\d+x\d+(\.\d+)?$`), mas o `serialize` **não**; `1920x1080x59.94` é revertido em silêncio.
2. Cópia profunda: `JSON.parse(JSON.stringify(this.config))` (descarta `undefined`, preserva number/string/boolean/array/objeto).
3. Filtra as listas:
   - `global_prep_cmd` e `global_state_cmd`: mantém o item se `do.trim()` **ou** `undo.trim()` for não vazio
   - `server_cmd`: mantém o item só se `name.trim()` **e** `cmd.trim()` forem não vazios
   - `dd_mode_remapping`: **não é filtrado** (entradas com campos vazios são mantidas)
   - Os valores não são aparados; o `trim` só decide se o item fica.

**Remoção de defaults (config.html:439-453):** para cada chave de `tab.options` (apenas das abas que sobraram para a plataforma), se `JSON.stringify(config[k]) === JSON.stringify(default[k])`, a chave é removida do corpo. A comparação é **sensível a tipo e à ordem das chaves**:

| Situação | Resultado |
|---|---|
| `port` digitado em `<input type=number>` = 47989 (number) | removido |
| `port = 47989` já vindo do arquivo (`"47989"` string) e não editado | **mantido** (`"47989"` ≠ `47989`) e regravado como `port = 47989` |
| `hevc_mode` escolhido no `<select>` = `"0"` (string) | **mantido** (`"0"` ≠ `0`) |
| `upnp` voltou para `"disabled"` | removido (a linha some do arquivo) |
| `dd_mode_remapping` vindo do arquivo, tudo vazio: ordem alfabética (`mixed, refresh_rate_only, resolution_only`) | **mantido** (a ordem difere do default `mixed, resolution_only, refresh_rate_only`) |
| `dd_mode_remapping` criado do default e sem entradas | removido |
| Chave que não está em nenhuma aba (ex.: `flags`, `share_library`, chaves de abas ocultadas pela plataforma como `vt_coder` no Windows) | **passa intacta** |

Efeito prático: a remoção de defaults é uma otimização do painel; não é exigida pelo servidor. Um cliente pode gravar chaves iguais ao default sem problema.

**Tipo do valor que sai de cada widget:**

| Widget (Vue) | Exemplos | Tipo no corpo do POST |
|---|---|---|
| `Checkbox.vue` | `upnp`, `mouse`, `limit_framerate` | **string** `"enabled"`/`"disabled"` (ver 3.2) |
| `<select>` com `<option value="X">` | `locale`, `hevc_mode`, `min_log_level`, `lan_encryption_mode`, `nvenc_preset` | **string** `"X"`, inclusive quando é dígito (`"2"`) |
| `<input type="text">` | `sunshine_name`, `ping_timeout`, `fec_percentage`, `back_button_timeout`, `key_repeat_delay`, `key_repeat_frequency`, `dd_manual_*`, caminhos | **string** como digitada. Campo "numérico" em input de texto continua string |
| `<input type="number">` | `port`, `qp`, `min_threads`, `max_bitrate`, `minimum_fps_target`, `dd_config_revert_delay`, `nvenc_vbv_increase` | **number** (Vue faz `parseFloat` em `type=number`); **`""`** se o campo for limpo (e o servidor descarta `""`) |
| tabela de comandos | `global_prep_cmd`, `global_state_cmd`, `server_cmd` | **array de objetos** JSON |
| tabela de remapeamento | `dd_mode_remapping` | **objeto** com 3 arrays |
| valor não tocado, vindo do arquivo | qualquer | **string** (tudo é string no GET) |
| valor não tocado, ausente do arquivo | qualquer | o default tipado (e quase sempre removido na etapa de defaults) |

### 3.2 Booleanos: `"enabled"`/`"disabled"`, com vocabulário herdado

`Checkbox.vue` calcula **uma vez, na montagem**, o par de valores a partir do valor atual do modelo:

```
true/false | 1/0 | "true"/"false" | "1"/"0" | "enabled"/"disabled" | "enable"/"disable" | "yes"/"no" | "on"/"off"
```

O checkbox continua usando **o mesmo vocabulário do valor que já existia** (comparação em minúsculas; o par devolvido é o literal da lista, então `"Enabled"` volta como `"enabled"`). Se o valor não bate com nenhum par (ex.: `"2"`), loga `console.error` e usa `["true","false"]`. Como todos os defaults do painel são `"enabled"`/`"disabled"`, na prática o que sai é `"enabled"`/`"disabled"`, **a menos que o arquivo já tenha `on`, `yes`, `true` etc.**; nesse caso o painel preserva esse vocabulário.

Observação: o checkbox `nvenc_intra_refresh` não é `Checkbox.vue`; é um `<select>` com `"disabled"` (rótulo "Auto") e `"enabled"`.

### 3.3 No servidor (`saveConfig`, confighttp.cpp:1049)

Requisitos: `Content-Type: application/json` (cabeçalho obrigatório; senão `400 "Content type not provided"` ou `"Content type mismatch"`) e sessão autenticada.

```cpp
for (const auto &[k, v] : input_tree.items()) {          // ordem alfabética (std::map)
  if (v.is_null() || (v.is_string() && v.get<std::string>().empty())) continue;
  config_stream << k << " = " << (v.is_string() ? v.get<std::string>() : v.dump()) << std::endl;
}
file_handler::write_file(config::sunshine.config_file.c_str(), config_stream.str());
output_tree["status"] = true;     // sempre, mesmo se write_file falhar
```

| Valor JSON recebido | Linha gravada no `sunshine.conf` |
|---|---|
| `"abc"` | `chave = abc` (**crua**: sem aspas, sem escape; `"a\\b"` JSON vira `a\b`) |
| `""` ou `null` | **nada** (chave descartada → default do C++) |
| `48000` | `chave = 48000` |
| `24.9` | `chave = 24.9` |
| `0` / `false` | `chave = 0` / `chave = false` |
| `true` | `chave = true` |
| `[]` | `chave = []` |
| array/objeto | JSON compacto numa linha, chaves **ordenadas alfabeticamente**, UTF-8 cru (sem `\uXXXX`), barras `\\` escapadas dentro das strings |

Detalhes que importam:

- **Substituição total.** O arquivo é truncado e reescrito só com as chaves do corpo. Não há merge no servidor.
- **Terminadores**: `std::endl` em modo texto no Windows produz `\r\n` (confirmado no `sunshine.conf` real). O parser lê `\n` e `\r\n`.
- **Sem validação de tipo/faixa** ("TODO: Input Validation" no código). Tudo que for JSON válido é aceito; as faixas são aplicadas só na hora do boot (3.4).
- **`status:true` não prova que gravou**: o retorno de `write_file` (-1 se não abrir o arquivo) é ignorado. Confirmar com um GET.
- **Erros**: JSON inválido ou string UTF-8 inválida → `400 {"status_code":400,"status":false,"error":"<mensagem do nlohmann>"}`. Sem login → `401 {"status_code":401,"status":false,"error":"Unauthorized"}` (ou `307 → /welcome` se não há credenciais cadastradas; `403` sem corpo se a origem do IP não é permitida por `origin_web_ui_allowed`).
- Chaves desconhecidas são gravadas assim mesmo (o C++ só avisa em stdout, `Warning: Unrecognized configurable option`, se `min_log_level <= 3`).

### 3.4 Como o C++ lê cada valor no boot (`apply_config`)

O arquivo é texto; o tipo "existe" só aqui. `parse_option` (config.cpp:654) quebra em `nome = valor`:

- `#` inicia comentário **em qualquer posição** da linha: o valor é cortado ali (e espaços antes do `#` ficam no valor);
- valor vazio (`chave =`) → linha ignorada; o nome é aparado, o valor **não** (espaços à direita permanecem);
- se o valor começa com `[`, ele continua até o `]` correspondente, atravessando quebras de linha (contagem de colchetes **sem** respeitar aspas);
- chave repetida: vale a **primeira** (`emplace`).

Conversores:

| Função | Regra exata | Se o valor for inválido |
|---|---|---|
| `bool_f` | `true` se o texto é `true`, `yes`, `enable`, `enabled`, `on` **ou contém o caractere `1`**. **Diferencia maiúsculas**: o `std::for_each(... tolower ...)` não altera nada, então `Enabled`, `TRUE`, `ON` viram `false`. Vazio → mantém default | qualquer outro texto (`disabled`, `false`, `0`, `no`, `off`...) = `false` |
| `int_f` | remove aspas se começar com `"`; prefixo `0x` → hex; senão `util::from_chars`: conversão decimal **sem validação** (só dígitos, `-` inicial opcional). `"24.9"`, `" 5"`, `"abc"` geram lixo, não erro | sem proteção |
| `int_between_f` | `int_f` + descarta se fora de `[min,max]` (mantém o default) | mantém default |
| `double_f` / `double_between_f` | `strtod`; se nada converteu, ignora | mantém default |
| `string_f` | texto cru | n/a |
| `string_restricted_f` | só aceita valores da lista permitida | mantém default |
| `generic_f` / `int_f(...,f)` (enums) | aplica o conversor da chave (`dd::*_from_view`, `nv::twopass_from_view`, `qsv::*`, `amd::*`, `vt::*`) | cada conversor tem seu fallback (ex.: `dd_*` → `disabled`; `nvenc_twopass` → `quarter_res` com aviso) |
| `path_f` | relativo → `appdata\<valor>`; cria os diretórios pai | n/a |
| `list_prep_cmd_f`, `list_server_cmd_f` | `{"x": <valor>}` → `boost::property_tree::read_json` | **exceção não capturada** (4.6) |
| `mode_remapping_from_view` | idem, exige as 3 chaves `mixed`, `resolution_only`, `refresh_rate_only` | **exceção não capturada** (4.6) |
| `map_int_int_f` | `keybindings = [a,b,c,d]` → pares; hex `0x..` aceito; nº ímpar de elementos é ignorado com aviso | ignora |

Casos especiais de `apply_config`:

| Chave | Tratamento |
|---|---|
| `min_log_level` | aceita nome (`verbose,debug,info,warning,error,fatal,none` = 0-6) **ou** o 1º caractere sendo dígito `0`-`6`. O painel envia `"0"`..`"6"` |
| `ping_timeout` | `[-1, INT_MAX]`; `-1` = não altera (mantém os 10 s) |
| `key_repeat_delay` | só aplica se `>= 0` |
| `key_repeat_frequency` | `double` em `[0, max]`; só aplica se `> 0` |
| `back_button_timeout` | qualquer inteiro; negativo = desativado |
| `dd_config_revert_delay` | `[0, INT_MAX]` ms |
| `dd_wa_hdr_toggle_delay` | `[0, 3000]` ms (sem UI: input comentado no `.vue`) |
| `port` | `[1019, 65514]` no C++ (`1024 + PORT_HTTPS(-5)` .. `65535 - 21`); o `<input>` limita a `1029..65514` |
| `upnp` | `bool_f`; se verdadeiro faz `flags[UPNP].flip()` |
| `key_rightalt_to_key_win` | flag só da UI: se verdadeira, adiciona o mapeamento `0xA5 → 0x5B` em `keybindings` |
| `capture`, `encoder`, `adapter_name`, `output_name` | `string_f` sem validação |

### 3.5 Estado final do arquivo

Depois do POST o arquivo é totalmente determinístico: chaves em ordem alfabética, uma por linha, `chave = valor`, CRLF. Exemplo real (instalado em `C:\Program Files\Apollo\config\sunshine.conf`):

```
dd_configuration_option = ensure_primary
gamepad = auto
locale = pt_BR
origin_web_ui_allowed = pc
server_cmd = [{"cmd":"bubbles.scr","elevated":false,"name":"Bubbles"}]
upnp = enabled
```

---

## 4. (c) Chaves que são arrays/objetos JSON

Só existem **quatro** chaves JSON mais uma string de lista (`keybindings`). Todas passam pelo mesmo caminho: `JSON.parse` no `created()` → edição → `dump()` no servidor → `read_json` no C++.

### 4.1 `global_prep_cmd` e `global_state_cmd`

Array de objetos (aba Geral, componente `General.vue`).

```json
[ { "do": "<comando>", "undo": "<comando>", "elevated": false } ]
```

| Campo | Tipo | Observação |
|---|---|---|
| `do` | string | comando executado (prep: antes do app; state: ao retomar). Padrão do C++: `""` |
| `undo` | string | comando de desfazer (prep: depois do app, em ordem inversa; state: ao pausar). Padrão: `""` |
| `elevated` | boolean | **Só Windows**. O painel força `!!elevated` ao carregar e cria itens novos com `elevated:false`. Fora do Windows o campo não existe. C++ lê como bool, padrão `false` |

- Itens novos: `{do:"", undo:""}` (+ `elevated:false` no Windows). O botão `+` da linha insere **antes** da linha (`splice(i,0,novo)`); o `+ Adicionar` acrescenta no fim.
- Salvo só se `do` ou `undo` tiver texto (após `trim`).
- Lista vazia = default → chave não gravada.
- No arquivo: `global_prep_cmd = [{"do":"cmd /c a.bat","elevated":false,"undo":"cmd /c b.bat"}]` (ordem das chaves `do`, `elevated`, `undo`).

### 4.2 `server_cmd`

```json
[ { "name": "<rótulo>", "cmd": "<comando>", "elevated": false } ]
```

| Campo | Tipo | Observação |
|---|---|---|
| `name` | string | rótulo mostrado ao cliente |
| `cmd` | string | comando |
| `elevated` | boolean | só Windows, mesma regra acima |

- Salvo só se `name` **e** `cmd` tiverem texto.
- No arquivo: `server_cmd = [{"cmd":"bubbles.scr","elevated":false,"name":"Bubbles"}]` (ordem `cmd`, `elevated`, `name`).
- No Windows, se o `sunshine.conf` não existir, o próprio Apollo o cria com `server_cmd = [{"name":"Bubbles","cmd":"bubbles.scr","elevated":false}]` (config.cpp:1456), embora o default do painel continue `[]`.

### 4.3 `dd_mode_remapping`

Objeto com **sempre as 3 listas** (só Windows exibe a UI, mas a chave existe em todas as plataformas):

```json
{
  "mixed":             [ { "requested_resolution": "", "requested_fps": "", "final_resolution": "", "final_refresh_rate": "" } ],
  "resolution_only":   [ { "requested_resolution": "", "final_resolution": "" } ],
  "refresh_rate_only": [ { "requested_fps": "", "final_refresh_rate": "" } ]
}
```

- Todos os campos são **strings** (C++ usa `get_optional<std::string>`, ausente = `""`). Exemplos de placeholder na UI: `1920x1080`, `60`, `2560x1440`, `119.95`.
- **Qual lista é editada** depende de `dd_resolution_option`/`dd_refresh_rate_option` (`getRemappingType()`): se `dd_resolution_option !== "auto"` → `refresh_rate_only`; senão se `dd_refresh_rate_option !== "auto"` → `resolution_only`; senão `mixed`. A seção só aparece se `(resolução==auto || refresh==auto) && dd_configuration_option !== "disabled"`. As outras duas listas continuam no objeto, intactas.
- O C++ **exige as 3 chaves** (`get_child("dd_mode_remapping.mixed")` etc.); um objeto sem alguma delas lança `ptree_bad_path` no boot.
- No arquivo: `dd_mode_remapping = {"mixed":[],"refresh_rate_only":[],"resolution_only":[{"final_resolution":"2560x1440","requested_resolution":"1920x1080"}]}` (chaves de cada nível em ordem alfabética).

### 4.4 `keybindings` (string, não JSON)

Default do painel: a **string** `"[0x10,0xA0,0x11,0xA2,0x12,0xA4]"` (sem UI; comentário `todo: add this to UI`). Lista plana de pares `código_origem, código_destino` (inteiros ou `0x..`). Como é string, o servidor grava crua. Como é igual ao default, normalmente nem é enviada. Observação: `emplace` não sobrescreve os 3 mapeamentos que o C++ já traz por padrão.

### 4.5 Chaves citadas que **não existem** aqui

`resolutions` e `fps` (listas de resoluções/FPS que existiam em versões antigas) não aparecem em `config.html`, nos `.vue` nem em `apply_config`. A única sobra é o comentário sobre "framerate list" em `list_int_f`, hoje usado só por `keybindings`. Não modelar essas chaves.

### 4.6 Armadilha: JSON inválido derruba o boot **[inferido]**

`list_prep_cmd_f`, `list_server_cmd_f` e `mode_remapping_from_view` usam `read_json`/`get_child`, que lançam exceção. `config::parse` só captura `filesystem_error` (std e boost) e `main()` não tem `try/catch`. Portanto, uma lista malformada (por exemplo, truncada por um `#` dentro de um comando, seção 9) deixa a exceção subir e o processo aborta ao iniciar. Isso não foi executado; vale validar o JSON **antes** de gravar.

---

## 5. (d) Fluxo Salvar → Reiniciar

Botões (config.html:97-100):

- **Salvar** (sempre visível) → `save()`
- **Aplicar** (só aparece quando `saved && !restarted`) → `apply()`

**`save()`**

1. `saved = false; restarted = false`
2. `serialize()` + remoção de defaults (seção 3.1)
3. `fetch("./api/config", { method:"POST", credentials:"include", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(config) })`
4. `r.status === 200` → `saved = true` (mostra o alerta verde `config.apply_note`: "Clique em Aplicar para reiniciar o Apollo e aplicar as alterações. Isso encerrará todas as sessões em execução." e libera o botão **Aplicar**). Qualquer outro status → resolve `false` e **não mostra nenhum erro**.

**`apply()`**

1. `saved = restarted = false`, chama `save()` (ou seja, grava de novo)
2. Se deu certo: `restarted = true` (alerta `config.restart_note`: "O Apollo está sendo reiniciado para aplicar as alterações."), e após 5 s zera `saved`/`restarted`
3. `fetch("./api/restart", { method:"POST", headers:{ "Content-Type":"application/json" } })` (sem corpo)
4. Resposta `!== 200` → `location.reload()`; erro de rede (o normal, pois o processo morre) → `console.error` + `location.reload()` após 1 s

**Servidor, `restart` (confighttp.cpp:1327):** exige autenticação e o cabeçalho `Content-Type: application/json` (o corpo pode ser vazio). Faz `proc::proc.terminate()` (encerra o app/sessão em andamento) e `platf::restart()`. No Windows (`misc.cpp:1289`): se há janela de console (execução avulsa), registra `atexit(restart_on_exit)`, que recria o processo com a mesma linha de comando; se roda como serviço, apenas sai e o serviço o relança. A saída usa `lifetime::exit_sunshine(0, true)` assíncrono. **Não há resposta HTTP** ("We may not return from this call").

Quanto tempo leva para voltar: o painel não espera; recarrega a página e o navegador reconecta. O ApolloConfig (`app.js`) faz `setTimeout(boot, 4000)` e tenta de novo enquanto `/api/apps` estiver inacessível. O log do novo boot lista cada chave aplicada (`Info: config: 'chave' = valor`), o que dá para conferir com `GET /api/logs`.

---

## 6. (e) "Reinicia o Apollo" vs "aplica na hora"

**O painel original não marca nenhum campo individualmente.** Não há ícone, badge nem texto por campo (nenhuma descrição em `en.json` menciona reinício). Existe apenas a mensagem global depois de salvar (`config.apply_note`).

O motivo está no C++: `apply_config` é chamado **uma única vez**, em `config::parse` (`main.cpp:162`); nenhum outro lugar (`confighttp`, tray, sessões) relê o arquivo nem reaplica valores em `config::video`, `config::input`, `config::stream`, `config::sunshine` etc. Logo:

| Item | Comportamento |
|---|---|
| **Todas as chaves do `sunshine.conf`** | só passam a valer após reiniciar (Aplicar). Salvar apenas grava o arquivo |
| `locale` | idioma da UI = `config::sunshine.locale` em memória (`/api/configLocale`), muda só após o restart |
| Valores exibidos após Salvar | já refletem o arquivo (GET lê o disco) mesmo que o processo ainda use os valores antigos |
| Fora do `sunshine.conf` | apps (`/api/apps`), pareamentos e a senha (`/api/password`) têm API própria e valem imediatamente; **não** são parte da configuração tratada aqui |

Quando o valor passa a ser consumido depois do restart **[inferido]**: rede (`port`, `address_family`, `upnp`, `origin_web_ui_allowed`, `external_ip`), certificados/arquivos (`pkey`, `cert`, `file_state`, `credentials_file`, `file_apps`, `log_path`), bandeja, idioma e nível de log são lidos na subida do serviço; as chaves de vídeo, áudio, entrada e `dd_*` ficam em memória e entram em ação quando a próxima sessão de streaming/app é iniciada; `global_prep_cmd`/`global_state_cmd`/`server_cmd` quando o app/sessão correspondente roda. Para o usuário a regra é simples: **qualquer mudança só vale depois de Aplicar**, e Aplicar derruba a sessão em curso.

---

## 7. Exemplos de payload reais

### 7.1 `GET /api/config` (base: `sunshine.conf` real acima)

```json
{
  "dd_configuration_option": "ensure_primary",
  "gamepad": "auto",
  "locale": "pt_BR",
  "origin_web_ui_allowed": "pc",
  "platform": "windows",
  "server_cmd": "[{\"cmd\":\"bubbles.scr\",\"elevated\":false,\"name\":\"Bubbles\"}]",
  "status": true,
  "upnp": "enabled",
  "vdisplayStatus": 0,
  "version": "0.0.0.98695412.dirty"
}
```

Note `server_cmd` como **string**, `status` boolean e `vdisplayStatus` número.

### 7.2 O que o painel envia depois de: trocar `port` para 48000 (campo número), escolher HEVC "2", desligar UPnP, definir um nome e adicionar um comando preparativo

```http
POST /api/config
Content-Type: application/json
```
```json
{
  "dd_configuration_option": "ensure_primary",
  "global_prep_cmd": [
    { "do": "cmd /c C:\\tools\\pre.bat", "undo": "cmd /c C:\\tools\\post.bat", "elevated": false }
  ],
  "hevc_mode": "2",
  "locale": "pt_BR",
  "origin_web_ui_allowed": "pc",
  "port": 48000,
  "server_cmd": [
    { "cmd": "bubbles.scr", "elevated": false, "name": "Bubbles" }
  ],
  "sunshine_name": "Sala R3D"
}
```

O que o painel já tirou: `gamepad:"auto"` (igual ao default), `upnp` (voltou a `"disabled"`), `status`, `platform`, `version`, `vdisplayStatus`.

Resultado em `sunshine.conf` (resposta `{"status":true}`; note que `upnp = enabled` **sumiu**, porque a chave não veio no corpo):

```
dd_configuration_option = ensure_primary
global_prep_cmd = [{"do":"cmd /c C:\\tools\\pre.bat","elevated":false,"undo":"cmd /c C:\\tools\\post.bat"}]
hevc_mode = 2
locale = pt_BR
origin_web_ui_allowed = pc
port = 48000
server_cmd = [{"cmd":"bubbles.scr","elevated":false,"name":"Bubbles"}]
sunshine_name = Sala R3D
```

Barras invertidas: dentro de `global_prep_cmd` (JSON) ficam duplicadas `\\`; numa chave de string simples (ex.: `log_path`) o servidor decodifica o JSON e grava `D:\logs\apollo.log` cru.

### 7.3 Descarte de vazios

```json
{ "sunshine_name": "", "capture": null, "encoder": "", "port": 47989, "max_bitrate": 0, "upnp": "disabled" }
```
vira
```
max_bitrate = 0
port = 47989
upnp = disabled
```
(`""` e `null` sumiram; `0` e `"disabled"` ficaram. O painel nem enviaria `port`/`max_bitrate`/`upnp`, por serem defaults.)

### 7.4 Remapeamento de modos (Windows, resolução manual + refresh automático)

```json
{
  "dd_configuration_option": "ensure_primary",
  "dd_resolution_option": "manual",
  "dd_manual_resolution": "2560x1440",
  "dd_mode_remapping": {
    "mixed": [],
    "resolution_only": [],
    "refresh_rate_only": [ { "requested_fps": "60", "final_refresh_rate": "119.95" } ]
  }
}
```
```
dd_configuration_option = ensure_primary
dd_manual_resolution = 2560x1440
dd_mode_remapping = {"mixed":[],"refresh_rate_only":[{"final_refresh_rate":"119.95","requested_fps":"60"}],"resolution_only":[]}
dd_resolution_option = manual
```

### 7.5 Valores booleanos aceitos no arquivo (como o C++ lê)

| Texto no `.conf` | Resultado |
|---|---|
| `enabled`, `enable`, `true`, `yes`, `on`, `1` | `true` |
| `disabled`, `disable`, `false`, `no`, `off`, `0` | `false` |
| `Enabled`, `TRUE`, `ON` | `false` (case-sensitive; o `tolower` do código não tem efeito) |
| `10`, `a1b` | `true` (qualquer texto com o caractere `1`) |

### 7.6 Respostas de erro

```json
{ "status_code": 400, "status": false, "error": "Content type mismatch" }
{ "status_code": 401, "status": false, "error": "Unauthorized" }
```
`400` também traz a mensagem do `nlohmann` para JSON inválido. `403` vem vazio; `307` redireciona para `/welcome`.

---

## 8. Receita para o ApolloConfig (tela única, com as opções avançadas)

Nada na serialização impede reunir todas as abas numa tela só: existe **um único objeto `config`**; a divisão em abas é só de layout, e a única ligação campo↔aba é `tabs[].options` (defaults). O que o painel original faz por aba e que precisa ser reproduzido numa tela única está na tabela de condições do Apêndice B.

Algoritmo recomendado:

**Carregar**
1. `GET /api/config` → `raw`.
2. Separar `meta = {status, platform, version, vdisplayStatus}` e `cfg = raw` sem essas 4 chaves.
3. Para `dd_mode_remapping`, `global_prep_cmd`, `global_state_cmd`, `server_cmd`: `JSON.parse` dentro de `try/catch` (em caso de erro, manter a string original, mostrar aviso e **não** sobrescrever).
4. Para exibição, usar o default do Apêndice A quando a chave estiver ausente (sem gravar esse default).

**Salvar**
1. Fazer `GET` de novo imediatamente antes de gravar e mesclar apenas as chaves que o usuário mexeu, preservando todas as outras (inclusive desconhecidas: `flags`, `share_library`, `keybindings`, `vt_*` no Windows...).
2. Normalizar: checkboxes → `"enabled"`/`"disabled"`; campos inteiros → inteiro decimal puro (sem decimais, sem espaços); `key_repeat_frequency` e `minimum_fps_target` podem ser reais; `fallback_mode` segundo `^\d+x\d+x\d+$`.
3. Listas: aplicar os mesmos filtros do painel (itens vazios fora) e enviar **como array/objeto**; `dd_mode_remapping` sempre com as 3 listas.
4. Remover `""`/`null` e (opcional, recomendado para manter o arquivo enxuto) valores iguais ao default, comparando sem sensibilidade a tipo (`String(a) === String(b)`).
5. Validar antes de enviar: nenhum `\n`/`\r` em strings (injetaria linhas novas no `.conf`), avisar sobre `#` em textos livres e comandos (trunca), JSON das listas válido.
6. `POST /api/config` com `Content-Type: application/json`. Conferir HTTP 200 e `status:true` e, por segurança, um `GET` de verificação.
7. Se o usuário pediu "Aplicar": `POST /api/restart` com o mesmo cabeçalho (`{}` serve), tratar a queda da conexão como sucesso e repetir `GET /api/apps` a cada ~4 s até o Apollo voltar.

---

## 9. Armadilhas e invariantes

| # | Armadilha | Efeito | Como evitar |
|---|---|---|---|
| 1 | Reenviar `status`/`platform`/`version`/`vdisplayStatus` | viram linhas no `.conf` e, no GET seguinte, sobrescrevem os valores reais por strings | remover as 4 chaves sempre |
| 2 | POST parcial | apaga todas as demais chaves | GET → mesclar → POST |
| 3 | `#` dentro de qualquer valor (nome do PC, caminho, comando) | o parser corta o valor no `#`. Em listas, remove de `#` até o fim da linha e o JSON fica inválido **[inferido: aborta o boot]** | bloquear/avisar `#` nos campos de texto e comandos |
| 4 | Quebra de linha em string | a 2ª linha vira outra chave do `.conf` (injeção de chave) | rejeitar `\n`/`\r` |
| 5 | Valor de string começando com `[` | tratado como lista, pode engolir as linhas seguintes | evitar; usar só nas chaves de lista |
| 6 | Inteiro com decimal/lixo (`"24.9"` em `qp`, `ping_timeout`...) | `from_chars` não valida: lê valor errado sem erro | inteiros puros em chaves `int_f`; reais só em `key_repeat_frequency` e `minimum_fps_target` |
| 7 | Booleano com caixa alta | `Enabled`/`TRUE` → `false` | usar sempre `enabled`/`disabled` minúsculos |
| 8 | Valor fora da faixa/lista permitida | ignorado em silêncio (cai no default) | validar na UI com as faixas do Apêndice A |
| 9 | `dd_mode_remapping` incompleto | exceção no boot **[inferido]** | sempre as 3 listas |
| 10 | `status:true` sem gravação | `write_file` falhou (permissão) e a API ainda responde sucesso | GET de verificação |
| 11 | Restart sem `Content-Type` | `400` e nada reinicia | sempre enviar o cabeçalho |
| 12 | Salvar mostra erro? | o painel original não mostra nada em falha do POST | exibir erro próprio |
| 13 | `JSON.stringify` com tipos misturados | valores do arquivo (string) nunca "são default" para o painel | comparar como string no ApolloConfig |
| 14 | `fallback_mode` com FPS decimal | o painel reverte em silêncio ao último valor inteiro | validar com a mesma regex do `serialize` |

---

## Apêndice A. Todas as chaves do painel (defaults do `tabs[].options`)

Legenda de "Envia": `E/D` = string `"enabled"`/`"disabled"` (Checkbox); `str` = string; `num` = number (input numérico); `arr`/`obj` = JSON. "Default" é o do painel (config.html), **não** necessariamente o do C++. "Leitor/faixa" é o que o C++ aceita. Plataforma = onde o campo aparece na UI.

### Geral (`general`)

| Chave | Widget | Default | Envia | Leitor C++ / domínio | Plataforma |
|---|---|---|---|---|---|
| `locale` | select | `"en"` | str | `string_restricted_f`: bg, cs, de, en, en_GB, en_US, es, fr, hu, it, ja, ko, pl, pt, pt_BR, ru, sv, tr, uk, vi, zh, zh_TW | todas |
| `sunshine_name` | texto | `""` | str | `string_f` (vazio = nome do PC) | todas |
| `min_log_level` | select | `2` | str `"0".."6"` | nome (verbose..none) ou dígito 0-6 | todas |
| `global_prep_cmd` | tabela | `[]` | arr | `list_prep_cmd_f` | todas (`elevated`: Windows) |
| `global_state_cmd` | tabela | `[]` | arr | `list_prep_cmd_f` | todas (`elevated`: Windows) |
| `server_cmd` | tabela | `[]` | arr | `list_server_cmd_f` | todas (`elevated`: Windows) |
| `notify_pre_releases` | checkbox | `"disabled"` | E/D | `bool_f` | todas |
| `system_tray` | checkbox | `"enabled"` | E/D | `bool_f` | todas |
| `hide_tray_controls` | checkbox | `"disabled"` | E/D | `bool_f` | todas |
| `enable_pairing` | checkbox | `"enabled"` | E/D | `bool_f` | todas |
| `enable_discovery` | checkbox | `"enabled"` | E/D | `bool_f` | todas |

### Entrada (`input`)

| Chave | Widget | Default | Envia | Leitor C++ / domínio | Plataforma |
|---|---|---|---|---|---|
| `controller` | checkbox | `"enabled"` | E/D | `bool_f` | todas |
| `gamepad` | select | `"auto"` | str | `string_restricted_f` com os nomes da plataforma (Windows: auto, x360, ds4; Linux: auto, ds5, switch, xone...) | oculto no macOS e se `controller` ≠ enabled |
| `ds4_back_as_touchpad_click` | checkbox | `"enabled"` | E/D | `bool_f` | gamepad ds4, ou auto no Windows |
| `motion_as_ds4` | checkbox | `"enabled"` | E/D | `bool_f` | gamepad auto, Windows/Linux |
| `touchpad_as_ds4` | checkbox | `"enabled"` | E/D | `bool_f` | gamepad auto, Windows/Linux |
| `ds5_inputtino_randomize_mac` | checkbox | `"enabled"` | E/D | `bool_f` | gamepad ds5, ou auto no Linux |
| `back_button_timeout` | texto | `-1` | str | `int_f` (ms; < 0 desliga) | `controller` = enabled |
| `keyboard` | checkbox | `"enabled"` | E/D | `bool_f` | todas |
| `key_repeat_delay` | texto | `500` | str | `int_f` (ms; só aplica se ≥ 0) | Windows, teclado ligado |
| `key_repeat_frequency` | texto | `24.9` | str | `double_between_f [0,∞)` (só aplica se > 0) | Windows, teclado ligado |
| `always_send_scancodes` | checkbox | `"enabled"` | E/D | `bool_f` | Windows, teclado ligado |
| `key_rightalt_to_key_win` | checkbox | `"disabled"` | E/D | `bool_f` (só UI; adiciona 0xA5→0x5B) | teclado ligado |
| `mouse` | checkbox | `"enabled"` | E/D | `bool_f` | todas |
| `high_resolution_scrolling` | checkbox | `"enabled"` | E/D | `bool_f` | mouse ligado |
| `native_pen_touch` | checkbox | `"enabled"` | E/D | `bool_f` | mouse ligado |
| `enable_input_only_mode` | checkbox | `"disabled"` | E/D | `bool_f` | todas |
| `forward_rumble` | checkbox | `"enabled"` | E/D | `bool_f` | Windows |
| `keybindings` | sem UI | `"[0x10,0xA0,0x11,0xA2,0x12,0xA4]"` | str | `map_int_int_f` | n/a |

### Áudio/Vídeo (`av`)

| Chave | Widget | Default | Envia | Leitor C++ / domínio | Plataforma |
|---|---|---|---|---|---|
| `audio_sink` | texto | `""` | str | `string_f` | todas |
| `virtual_sink` | texto | `""` | str | `string_f` | Windows |
| `stream_audio` | checkbox | `"enabled"` | E/D | `bool_f` | todas |
| `install_steam_audio_drivers` | checkbox | `"enabled"` | E/D | `bool_f` | Windows |
| `keep_sink_default` | checkbox | `"enabled"` | E/D | `bool_f` | Windows |
| `auto_capture_sink` | checkbox | `"enabled"` | E/D | `bool_f` | Windows |
| `adapter_name` | texto | `""` | str | `string_f` | não macOS |
| `output_name` | texto | `""` | str | `string_f` | todas |
| `dd_configuration_option` | select | `"disabled"` | str | `generic_f`: disabled, verify_only, ensure_active, ensure_primary, ensure_only_display | Windows |
| `dd_resolution_option` | select | `"auto"` | str | disabled, auto, manual | Windows, se config ≠ disabled |
| `dd_manual_resolution` | texto | `""` | str | `string_f` | se resolução = manual |
| `dd_refresh_rate_option` | select | `"auto"` | str | disabled, auto, manual | Windows, se config ≠ disabled |
| `dd_manual_refresh_rate` | texto | `""` | str | `string_f` | se refresh = manual |
| `dd_hdr_option` | select | `"auto"` | str | disabled, auto | Windows |
| `dd_wa_hdr_toggle_delay` | sem UI | `0` | num | `int_between_f [0,3000]` | n/a |
| `dd_config_revert_delay` | número | `3000` | num | `int_between_f [0,INT_MAX]` (ms) | Windows, se config ≠ disabled |
| `dd_config_revert_on_disconnect` | checkbox | `"disabled"` | E/D | `bool_f` | Windows, se config ≠ disabled |
| `dd_mode_remapping` | tabela | `{mixed:[],resolution_only:[],refresh_rate_only:[]}` | obj | `mode_remapping_from_view` | Windows, se `canBeRemapped()` |
| `dd_wa_hdr_toggle` | sem UI | `"disabled"` | E/D | **sem leitor no C++** | n/a |
| `fallback_mode` | texto | `""` | str | `string_f` (default C++ `1920x1080x60`) | todas |
| `headless_mode` | checkbox | `"disabled"` | E/D | `bool_f` | Windows |
| `double_refreshrate` | checkbox | `"disabled"` | E/D | `bool_f` | Windows |
| `isolated_virtual_display_option` | checkbox | `"disabled"` | E/D | `bool_f` | Windows |
| `max_bitrate` | número | `0` | num | `int_f` (Kbps; 0 = o do cliente) | todas |
| `minimum_fps_target` | número | `0` | num | `double_between_f [0,1000]` | todas |

### Rede (`network`)

| Chave | Widget | Default | Envia | Leitor C++ / domínio | Plataforma |
|---|---|---|---|---|---|
| `upnp` | checkbox | `"disabled"` | E/D | `bool_f` | todas |
| `address_family` | select | `"ipv4"` | str | `string_restricted_f`: ipv4, both | todas |
| `port` | número | `47989` | num | `int_between_f [1019,65514]` (input: 1029..65514) | todas |
| `origin_web_ui_allowed` | select | `"lan"` | str | `string_restricted_f`: pc, lan, wan | todas |
| `external_ip` | texto | `""` | str | `string_f` | todas |
| `lan_encryption_mode` | select | `0` | str `"0".."2"` | `int_between_f [0,2]` | todas |
| `wan_encryption_mode` | select | `1` | str `"0".."2"` | `int_between_f [0,2]` | todas |
| `ping_timeout` | texto | `10000` | str | `int_between_f [-1,INT_MAX]` (ms) | todas |

### Arquivos (`files`)

| Chave | Widget | Default | Envia | Leitor C++ | Plataforma |
|---|---|---|---|---|---|
| `file_apps`, `credentials_file`, `log_path`, `pkey`, `cert`, `file_state` | texto | `""` | str | `path_f` (relativo → `appdata\`, cria pastas pai) | todas |

### Avançado (`advanced`)

| Chave | Widget | Default | Envia | Leitor C++ / domínio | Plataforma |
|---|---|---|---|---|---|
| `fec_percentage` | **texto** | `20` | str | `int_between_f [1,255]` | todas |
| `qp` | número | `28` | num | `int_f` | todas |
| `min_threads` | número | `2` | num | `int_f` (input `min=1`) | todas |
| `limit_framerate` | checkbox | `"enabled"` | E/D | `bool_f` | todas |
| `envvar_compatibility_mode` | checkbox | `"disabled"` | E/D | `bool_f` | todas |
| `legacy_ordering` | checkbox | `"disabled"` | E/D | `bool_f` | todas |
| `ignore_encoder_probe_failure` | checkbox | `"disabled"` | E/D | `bool_f` | todas |
| `hevc_mode` | select | `0` | str `"0".."3"` | `int_between_f [0,3]` | todas |
| `av1_mode` | select | `0` | str `"0".."3"` | `int_between_f [0,3]` | todas |
| `capture` | select | `""` | str | `string_f` (Windows: ddx, wgc; Linux: nvfbc, wlr, kms, x11; `""` = autodetectar) | não macOS |
| `encoder` | select | `""` | str | `string_f` (nvenc, quicksync, amdvce, vaapi, videotoolbox, software; `""` = autodetectar) | todas |

### Codificadores

| Chave | Aba | Widget | Default | Envia | Leitor C++ / domínio | Plataforma |
|---|---|---|---|---|---|---|
| `nvenc_preset` | nv | select | `1` | str `"1".."7"` | `int_between_f [1,7]` | Win/Linux |
| `nvenc_twopass` | nv | select | `"quarter_res"` | str | disabled, quarter_res, full_res (outro → quarter_res) | Win/Linux |
| `nvenc_spatial_aq` | nv | checkbox | `"disabled"` | E/D | `bool_f` | Win/Linux |
| `nvenc_vbv_increase` | nv | número | `0` | num | `int_between_f [0,400]` | Win/Linux |
| `nvenc_realtime_hags` | nv | checkbox | `"enabled"` | E/D | `bool_f` | Windows |
| `nvenc_latency_over_power` | nv | checkbox | `"enabled"` | E/D | `bool_f` | Windows |
| `nvenc_opengl_vulkan_on_dxgi` | nv | checkbox | `"enabled"` | E/D | `bool_f` | Windows |
| `nvenc_h264_cavlc` | nv | checkbox | `"disabled"` | E/D | `bool_f` | Win/Linux |
| `nvenc_intra_refresh` | nv | select | `"disabled"` | str `disabled`/`enabled` | `bool_f` | Win/Linux |
| `qsv_preset` | qsv | select | `"medium"` | str | veryslow, slower, slow, medium, fast, faster, veryfast. **A UI oferece `slowest`, que o C++ não reconhece** (zera o preset) | Windows |
| `qsv_coder` | qsv | select | `"auto"` | str | auto, cabac/ac, cavlc/vlc | Windows |
| `qsv_slow_hevc` | qsv | checkbox | `"disabled"` | E/D | `bool_f` | Windows |
| `amd_usage` | amd | select | `"ultralowlatency"` | str | transcoding, webcam, lowlatency_high_quality, lowlatency, ultralowlatency | Windows |
| `amd_rc` | amd | select | `"vbr_latency"` | str | cbr, cqp, vbr_latency, vbr_peak | Windows |
| `amd_enforce_hrd` | amd | checkbox | `"disabled"` | E/D | `bool_f` | Windows |
| `amd_quality` | amd | select | `"balanced"` | str | speed, balanced, quality | Windows |
| `amd_preanalysis` | amd | checkbox | `"disabled"` | E/D | `bool_f` | Windows |
| `amd_vbaq` | amd | checkbox | `"enabled"` | E/D | `bool_f` | Windows |
| `amd_coder` | amd | select | `"auto"` | str | auto, cabac/ac, cavlc/vlc | Windows |
| `vt_coder` | vt | select | `"auto"` | str | auto, cabac, cavlc | macOS |
| `vt_software` | vt | select | `"auto"` | str | auto, disabled, allowed, forced | macOS |
| `vt_realtime` | vt | checkbox | `"enabled"` | E/D | `rt_from_view` (`disabled`/`off`/`0` = desliga) | macOS |
| `vaapi_strict_rc_buffer` | vaapi | checkbox | `"disabled"` | E/D | `bool_f` | Linux |
| `sw_preset` | sw | select | `"superfast"` | str | ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow | todas |
| `sw_tune` | sw | select | `"zerolatency"` | str | film, animation, grain, stillimage, fastdecode, zerolatency | todas |

### Chaves lidas pelo C++ e fora do painel

`flags` (sequência de caracteres `0 1 2 p` que invertem flags), `share_library`, e a própria `keybindings`. Passam intactas pelo painel porque não pertencem a nenhuma aba.

---

## Apêndice B. Condições de exibição (para uma tela única)

| Campo(s) | Aparece quando |
|---|---|
| `gamepad` | `controller === "enabled"` e plataforma ≠ macOS |
| bloco "ajustes do gamepad" | `controller` ligado e (`gamepad` ∈ {ds4, ds5} ou (`auto` e plataforma ≠ macOS)) |
| `motion_as_ds4`, `touchpad_as_ds4` | `gamepad === "auto"` e Windows/Linux |
| `ds4_back_as_touchpad_click` | `gamepad === "ds4"` ou (`auto` e Windows) |
| `ds5_inputtino_randomize_mac` | `gamepad === "ds5"` ou (`auto` e Linux) |
| `back_button_timeout` | `controller === "enabled"` |
| `key_repeat_delay`, `key_repeat_frequency`, `always_send_scancodes` | `keyboard === "enabled"` e Windows |
| `key_rightalt_to_key_win` | `keyboard === "enabled"` |
| `high_resolution_scrolling`, `native_pen_touch` | `mouse === "enabled"` |
| `forward_rumble` | Windows |
| `virtual_sink`, `install_steam_audio_drivers`, `keep_sink_default`, `auto_capture_sink` | Windows |
| `adapter_name`, `capture` | plataforma ≠ macOS |
| bloco `dd_*` inteiro (`dd_configuration_option`, `dd_hdr_option`...) | Windows |
| `dd_resolution_option`, `dd_refresh_rate_option`, `dd_config_revert_delay`, `dd_config_revert_on_disconnect` | `dd_configuration_option !== "disabled"` |
| `dd_manual_resolution` | `dd_resolution_option === "manual"` |
| `dd_manual_refresh_rate` | `dd_refresh_rate_option === "manual"` |
| `dd_mode_remapping` | `(dd_resolution_option === "auto" \|\| dd_refresh_rate_option === "auto") && dd_configuration_option !== "disabled"` |
| `headless_mode`, `double_refreshrate`, `isolated_virtual_display_option` | Windows |
| `nvenc_realtime_hags`, `nvenc_latency_over_power`, `nvenc_opengl_vulkan_on_dxgi` | Windows |
| aviso "SudoVDA Driver status" | Windows (`vdisplayStatus`: 0 = verde, outro = amarelo) |
| alerta de porta | `port - 5 < 1024` ou `port + 21 > 65535`; alerta de segurança se `origin_web_ui_allowed === "wan"` |
| abas de codificador | `nv`: Win/Linux; `qsv`, `amd`: Windows; `vaapi`: Linux; `vt`: macOS; `sw`: todas |

Esconder um campo não deve apagar seu valor do objeto: o painel original mantém a chave no `config` e só deixa de renderizar o input.

---

## Apêndice C. Divergências painel × C++ encontradas

| Item | Observação |
|---|---|
| `dd_wa_hdr_toggle` | existe nos defaults do painel, sem UI e sem leitor no C++ (seria "chave desconhecida" se aparecesse no `.conf`) |
| `qsv_preset = slowest` | oferecido na UI; `preset_from_view` só conhece `veryslow`. Recomenda-se mapear para `veryslow` ao gravar |
| `port` | `<input min=1029>`; C++ aceita desde 1019 |
| `fec_percentage`, `ping_timeout`, `back_button_timeout`, `key_repeat_*` | são `<input type=text>` no painel, mas numéricos no C++ |
| `fallback_mode` | UI valida FPS decimal; `serialize` rejeita |
| `sunshine_name`, `fallback_mode` | default do painel `""`; default do C++ é o nome do PC e `1920x1080x60` |
| `min_log_level` | C++ também aceita nomes; o painel só envia `"0".."6"` |
| `keybindings` | default do painel é string, sem UI |
