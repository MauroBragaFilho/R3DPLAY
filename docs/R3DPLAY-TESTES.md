# Estado dos testes — R3DCORE + R3D PLAY

Atualizado em 2026-10-19 (segunda rodada). Aparelho: Galaxy A51 (SM-A515F, Android 13, `RX8N2025JQX`). PC: `MNBF-NEON` (Windows 11, i5-11300H, Intel Iris Xe + GTX 1650).
Versões testadas: launcher `app-release.apk` (módulos `:moonlight` e `:retroarch`), Apollo/R3D PLAY instalado em `C:\Program Files\Apollo`.

## Verificado (funcionou)

| Área | O que foi visto |
|---|---|
| Apollo no PC | Compila no MSYS2, instala com `scripts/install-r3dplay.ps1`, serviço `ApolloService` sobe. |
| Endpoints do PC | `/r3d/library` (21 jogos), `/r3d/cover` (PNG válido), `/r3d/stats` (CPU, RAM, GPUs, discos, temperaturas). |
| Janela R3D PLAY | Login automático, 19 jogos detectados (Steam e Epic), capas gravadas no Apollo, pareamento por PIN, nova interface (abas no topo). |
| Permissões | Aparelho recém-pareado vinha só com "ver/listar" (erro 403 ao iniciar). Corrigido: a janela libera tudo ao parear. |
| Launcher › Biblioteca | Coleção "PC" com 21 jogos e capas; capas baixadas do PC. |
| Moonlight embutido | Parear (PIN digitado no PC) e transmitir o "Desktop" dentro do launcher, sem o app Moonlight. |
| RetroArch embutido | Aladdin (SNES) abriu pelo motor "RetroArch embutido", com o `retroarch.cfg` migrado do fork. |
| Stream pelo launcher | Biblioteca › PC › Desktop › JOGAR transmitiu o PC; o Apollo mostrou "Desktop" como app em execução e `/r3d/stats` marcou transmissão ao vivo a ~60 FPS. |
| Jogo real do PC | Half-Life 2 pelo launcher (Biblioteca › PC › JOGAR): abriu no PC, transmitiu a ~60 FPS com a GTX 1650 em ~27% de uso, tela e toques funcionando; `/r3d/stats` mostrou "ao vivo". |
| Fechar jogo ao sair | Sair do stream (Voltar) fez o Apollo encerrar o app e o `--close-dir` fechou o `hl2.exe` em segundos, sem fechar a Steam (testado 2 vezes). |
| Tela cheia sem esticar | O celular pede 2144x964 (proporção 20:9) e o Apollo cria uma tela virtual dessa resolução (log: "Virtual Display created", "Desktop resolution [2144x964]"); a área de trabalho encheu o celular sem barras. O Moonlight ainda preenche sem esticar se sobrar proporção (Config › Computador › Tela do jogo). Ao sair, o jogo fecha, a tela virtual some e a do notebook volta como principal. |
| RetroArch embutido (2º jogo) | Super Metroid (SNES) abriu e rodou (cena de introdução), sem o app RetroArch instalado à parte. |
| PS2 | Sem o pcsx2 embutido nem o NetherSX2 instalado, os jogos de PS2 abrem no app RetroArch do fork (`com.retroarch.r3dcore`), ainda instalado. |
| Sistema › PC | Cartões de CPU, RAM, GPU, armazenamento, térmico e transmissão com dados reais; toque no cartão GPU alterna Intel ⇄ NVIDIA. |

## Ainda não testado

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

- **Tela virtual (SudoVDA) funciona depois da correção**: o Windows não ativava sozinho o monitor virtual novo; o Apollo agora roda `DisplaySwitch /extend` na sessão do usuário e a tela é criada na resolução pedida pelo celular (2144x964). Com `dd_configuration_option = ensure_primary` a tela virtual vira a principal durante o jogo e a do notebook volta ao fim. Jogos que fixam a própria resolução (ex.: Half-Life 2 em 1920x1080) ainda mostram barras: é preciso escolher a resolução do celular nas opções do jogo.
- Fechar a sessão pelo Apollo **não fecha o jogo da Steam** no PC (ele abre por `steam://` separado): o `hl2.exe` ficou aberto até eu encerrá-lo à mão.
- Antes o **Steam Big Picture** abriu ao tentar o "Desktop": foi um toque meu na grade do Moonlight, não erro do launcher (na repetição abriu o Desktop).
- Primeira abertura do Moonlight embutido: é preciso parear de novo (os dados do app Moonlight separado não migram).
- O launcher precisa de "Acesso a todos os arquivos" para o RetroArch abrir ROMs (`adb shell appops set com.r3dcore.launcher MANAGE_EXTERNAL_STORAGE allow`).
- O `adb` às vezes mostra o A51 como `offline` com o cabo conectado: `adb reconnect offline` resolve.
- Temperatura da GPU Intel não é exposta pelo Windows (aparece N/D).
- `/r3d/*` ficam abertos à rede local sem senha; desligue com `share_library = disabled` no `sunshine.conf`.
- O R3D PLAY depende do .NET 8 instalado no PC.
