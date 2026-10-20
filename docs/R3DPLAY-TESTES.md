# Estado dos testes — R3D LAUNCHER + R3D PLAY

Atualizado em 2026-10-19 (segunda rodada). Aparelho: Galaxy A51 (SM-A515F, Android 13, `RX8N2025JQX`). PC: `MNBF-NEON` (Windows 11, i5-11300H, Intel Iris Xe + GTX 1650).
Versões testadas: launcher `app-release.apk` (módulos `:moonlight` e `:retroarch`), R3D PLAY instalado em `C:\Program Files\Apollo` (a pasta e o serviço `ApolloService` mantêm o nome antigo para atualizar por cima sem duplicar).

## Verificado (funcionou)

| Área | O que foi visto |
|---|---|
| R3D PLAY no PC | Compila no MSYS2, instala com `scripts/install-r3dplay.ps1`, serviço `ApolloService` sobe. |
| Endpoints do PC | `/r3d/library` (21 jogos), `/r3d/cover` (PNG válido), `/r3d/stats` (CPU, RAM, GPUs, discos, temperaturas). |
| Janela R3D PLAY | Login automático, 19 jogos detectados (Steam e Epic), capas gravadas no R3D PLAY, pareamento por PIN, nova interface (abas no topo). |
| Permissões | Aparelho recém-pareado vinha só com "ver/listar" (erro 403 ao iniciar). Corrigido: a janela libera tudo ao parear. |
| Launcher › Biblioteca | Coleção "PC" com 21 jogos e capas; capas baixadas do PC. |
| Moonlight embutido | Parear (PIN digitado no PC) e transmitir o "Desktop" dentro do launcher, sem o app Moonlight. |
| RetroArch embutido | Aladdin (SNES) abriu pelo motor "RetroArch embutido", com o `retroarch.cfg` migrado do fork. |
| Stream pelo launcher | Biblioteca › PC › Desktop › JOGAR transmitiu o PC; o R3D PLAY mostrou "Desktop" como app em execução e `/r3d/stats` marcou transmissão ao vivo a ~60 FPS. |
| Jogo real do PC | Half-Life 2 pelo launcher (Biblioteca › PC › JOGAR): abriu no PC, transmitiu a ~60 FPS com a GTX 1650 em ~27% de uso, tela e toques funcionando; `/r3d/stats` mostrou "ao vivo". |
| Resolução nativa + argumentos por motor | O celular pede 2400x1080 (nativo) e o Half-Life 2 abre com `-w 2400 -h 1080 -windowed -noborder`; a imagem enche o celular sem barras, a 60 FPS (hevc_nvenc, decodificação HEVC por hardware no A51). Motores reconhecidos: Source, Unity, Unreal e Godot (jogos Steam); os demais abrem pelo `steam://` normal. |
| Vários PCs (launcher) | A tela Config › Computador lista os PCs conhecidos e tem "Procurar PCs na rede e sincronizar", "Adicionar PC por este endereço" e "Esquecer todos os PCs"; o PC atual foi migrado e sincronizou os 21 jogos. |
| Instalador completo | `scripts/gerar-instalador.sh` gerou `R3DPLAY-Setup.exe` (NSIS, 78 MB) com serviço, firewall, driver de tela virtual, controle virtual e a janela R3D PLAY autocontida (testei a janela publicada abrindo sozinha, sem .NET instalado à parte). |
| Fechar jogo ao sair | Sair do stream (Voltar) fez o R3D PLAY encerrar o app e o `--close-dir` fechou o `hl2.exe` em segundos, sem fechar a Steam (testado 2 vezes). |
| Tela cheia sem esticar | O celular pede 2144x964 (proporção 20:9) e o R3D PLAY cria uma tela virtual dessa resolução (log: "Virtual Display created", "Desktop resolution [2144x964]"); a área de trabalho encheu o celular sem barras. O Moonlight ainda preenche sem esticar se sobrar proporção (Config › Computador › Tela do jogo). Ao sair, o jogo fecha, a tela virtual some e a do notebook volta como principal. |
| RetroArch embutido (2º jogo) | Super Metroid (SNES) abriu e rodou (cena de introdução), sem o app RetroArch instalado à parte. |
| PS2 | Sem o pcsx2 embutido nem o NetherSX2 instalado, os jogos de PS2 abrem no app RetroArch do fork (`com.retroarch.r3dcore`), ainda instalado. |
| Sistema › PC | Cartões de CPU, RAM, GPU, armazenamento, térmico e transmissão com dados reais; toque no cartão GPU alterna Intel ⇄ NVIDIA. |

## Ainda não testado

- **Instalar o `R3DPLAY-Setup.exe` em um segundo PC (desktop)**, e ver os jogos dos dois PCs juntos no celular (a junção, o sufixo `· NOME` em jogos repetidos e o botão ⇄ da aba Sistema foram escritos, mas só existe um PC aqui para testar).
- Os argumentos de resolução em jogos Unity, Unreal e Godot (só o Half-Life 2, que é Source, foi testado).
- Jogar de verdade um jogo do PC com controle (só vi abertura e vídeo; o Half-Life 2 começou em 30 FPS na tela de intro e foi a 60).
- O cartão **Transmissão** na tela do celular durante o stream (o FPS ao vivo só foi lido pelo PC; o Moonlight cobre a tela do launcher).
- RetroArch embutido com os outros cores (PS1, GBA, GB/GBC, NES, Mega Drive, N64, PC Engine, Dreamcast, PSP, DS): não há ROMs deles no cartão (só SNES e PS2). Também controle físico, som e salvar/carregar estado.
- Saves e estados antigos (`/storage/emulated/0/R3DCORE/{saves,states,system}`): o `retroarch.cfg` migrado aponta para eles, mas não foi conferido se o jogo os encontrou.
- PS2 pelo NetherSX2 (não está instalado no A51; o PS2 depende do app do fork antigo).
- Clique no ícone da bandeja do Windows abrindo a janela R3D PLAY (só abri o `.exe` direto).
- Primeira execução do R3D PLAY sem usuário/senha (tela "Criar acesso").
- Liberação automática de permissões ao parear **pela janela** (só testei via API).
- Comportamento com o PC desligado/offline e com o Wi-Fi trocado.

## Problemas conhecidos / observações

- **Tela virtual (SudoVDA) funciona depois da correção**: o Windows não ativava sozinho o monitor virtual novo; o R3D PLAY agora roda `DisplaySwitch /extend` na sessão do usuário e a tela é criada na resolução pedida pelo celular (2144x964). Com `dd_configuration_option = ensure_primary` a tela virtual vira a principal durante o jogo e a do notebook volta ao fim. Jogos da Steam de motor conhecido (Source, Unity, Unreal, Godot) já abrem na resolução do celular pelos argumentos de linha de comando; os demais podem mostrar barras até você escolher a resolução nas opções do jogo.
- Jogos abertos por `steam://` só fecham ao sair do stream porque o R3D PLAY roda o comando de "desfazer" (`--close-dir`) com a pasta do jogo; jogos de outros launchers dependem do mesmo mecanismo, ainda não testado com eles.
- Antes o **Steam Big Picture** abriu ao tentar o "Desktop": foi um toque meu na grade do Moonlight, não erro do launcher (na repetição abriu o Desktop).
- Primeira abertura do Moonlight embutido: é preciso parear de novo (os dados do app Moonlight separado não migram).
- O launcher precisa de "Acesso a todos os arquivos" para o RetroArch abrir ROMs (`adb shell appops set com.r3dcore.launcher MANAGE_EXTERNAL_STORAGE allow`).
- O `adb` às vezes mostra o A51 como `offline` com o cabo conectado: `adb reconnect offline` resolve.
- Temperatura da GPU Intel não é exposta pelo Windows (aparece N/D).
- `/r3d/*` ficam abertos à rede local sem senha; desligue com `share_library = disabled` no `sunshine.conf`.
- A janela R3D PLAY publicada é autocontida (não precisa do .NET instalado); o WebView2 do Windows 10/11 é necessário.
- **Rebrand (2026-10-19)**: ícone "R" do fork do RetroArch no launcher (ícone do app, cabeçalho, menu rápido), nome "R3D LAUNCHER" e "R3D PLAY" no PC (bandeja, janela, instalador, atalho do menu Iniciar, serviço). O APK novo foi instalado e o logo conferido no A51; o instalador do PC com os novos ícones ainda não foi instalado/testado.
- Nomes técnicos mantidos de propósito para atualizar por cima: pasta `C:\Program Files\Apollo`, serviço `ApolloService`, regras de firewall, `ApolloConfig.exe` e a pasta `%LOCALAPPDATA%\ApolloConfig`.

## Painel único (janela R3D PLAY) — 2026-10-19

| Área | O que foi visto |
|---|---|
| Telas | Início, Jogos, Dispositivos, Config (as 104 opções, com as avançadas) e Sistema, numa janela só, sem a janela "Opções avançadas". Cada tela foi construída, revisada por 3 revisores independentes (schema/lógica, robustez/segurança, UX) e corrigida. |
| Testes automáticos | 467 testes (`node --test "tools/ApolloConfig/dev/tests/*.test.mjs"`): serialização de todas as chaves de configuração, política dos jogos detectados, permissões e presets, QR code, log, estatísticas. |
| Janela real (WebView2) | Aberta com depuração remota (`dev/cdp-shot.mjs`): as 5 abas carregaram sem erro no console, com capas reais, dados do PC ao vivo, em 1280 e 760 px. |
| Gravação real | A configuração atual foi regravada sem mudanças e o `sunshine.conf` ficou idêntico byte a byte; gravar e remover uma chave simples e uma lista (`global_prep_cmd`) também voltou ao arquivo original. |
| Reinício real | `restartServer()` reiniciou o serviço em 7 s, a sessão foi refeita sozinha e a lista de jogos voltou. |
| Ponte nativa | `whoami` (só o usuário), `info.dataDir`, log em UTF-8 (sem texto quebrado em "™"), `stats`, fechar a janela sem alterações pendentes. |
| Instalador novo | O usuário instalou o `R3DPLAY-Setup.exe`: `ApolloConfig.exe` e `sunshine.exe` com nome "R3D PLAY", serviço "R3D PLAY Service" rodando (processo novo logo após a instalação), atalho "R3D PLAY" no menu Iniciar, entrada "R3D PLAY" no Painel de Controle, pasta `ui` nova sem o `app.js` antigo. |
| Configuração inicial (instalação nova) | Na janela instalada, removi `dd_configuration_option` do `sunshine.conf` e recarreguei o painel: ele recriou `ensure_primary`, reiniciou o serviço sozinho e o arquivo voltou idêntico byte a byte. |
| Layout | Em 1920 px as telas Início, Dispositivos, Config e Sistema ficam centralizadas (coluna de 1180 px) e Jogos usa a largura toda; a barra de salvar vai de ponta a ponta com o conteúdo alinhado à coluna. Arquivo solto fora das áreas que o aceitam não navega mais a página. |
| Adicionar aplicativo | Fluxo simples em dois passos: (1) "Programas instalados" (lista pesquisável com ícones, 133 programas em ~0,5 s neste PC, sem lixo nem duplicados), "Escolher o arquivo do jogo", "Escolher a pasta do jogo" ou arrastar e soltar; (2) programa, nome, capa e botão Adicionar, com as opções técnicas recolhidas em "Opções avançadas". Corpo gravado: `cmd` com o caminho entre aspas, `working-dir`, tela virtual e fechar ao sair ligados. Revisado por 6 revisores e integrado: a janela real (WebView2) foi dirigida por depuração remota, com as caixas nativas do Windows, .lnk, pastas com vários .exe e arquivos soltos; 552 testes. O executável publicado varre os programas em ~0,7 s. |
| Logo | Variação A (refinada) em todos os ícones do PC e no R3D LAUNCHER (ícone adaptativo, temático e cabeçalho), gerada por `branding/gerar_svg.py`. |

Ainda não testado: pareamento real de um celular novo pela tela Dispositivos (PIN e OTP), "Dar acesso total", troca de senha real, a pergunta ao fechar a janela com alterações não salvas (caixa do Windows), o ícone da bandeja (aparência), o arrasto físico de um arquivo do Explorador para a janela, o APK novo do launcher no A51 (celular desconectado), Linux/macOS e a instalação em um segundo PC.
