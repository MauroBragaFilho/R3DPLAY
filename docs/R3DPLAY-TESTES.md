# Estado dos testes — R3DCORE + R3D PLAY

Atualizado em 2026-10-19. Aparelho: Galaxy A51 (SM-A515F, Android 13, `RX8N2025JQX`). PC: `MNBF-NEON` (Windows 11, i5-11300H, Intel Iris Xe + GTX 1650).
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
| Sistema › PC | Cartões de CPU, RAM, GPU, armazenamento, térmico e transmissão com dados reais; toque no cartão GPU alterna Intel ⇄ NVIDIA. |

## Ainda não testado

- Abrir pelo launcher um jogo real do PC (Half-Life 2, GTA V...) e jogar. Só o "Desktop" foi transmitido.
- Cartão **Transmissão** com stream ao vivo (FPS só foi visto "parada").
- RetroArch embutido com os outros cores: PS1, GBA, GB/GBC, NES, Mega Drive, N64, PC Engine, Dreamcast, PSP, DS. Também controle, som e salvar/carregar estado.
- Saves e estados antigos (`/storage/emulated/0/R3DCORE/{saves,states,system}`): o `retroarch.cfg` migrado aponta para eles, mas não foi conferido se o jogo os encontrou.
- PS2 pelo NetherSX2 (continua app separado).
- Clique no ícone da bandeja do Windows abrindo a janela R3D PLAY (só abri o `.exe` direto).
- Primeira execução do R3D PLAY sem usuário/senha (tela "Criar acesso").
- Liberação automática de permissões ao parear **pela janela** (só testei via API).
- Comportamento com o PC desligado/offline e com o Wi-Fi trocado.

## Problemas conhecidos / observações

- Abrir "Desktop" pelo launcher uma vez iniciou o **Steam Big Picture** no PC (causa não investigada).
- Primeira abertura do Moonlight embutido: é preciso parear de novo (os dados do app Moonlight separado não migram).
- O launcher precisa de "Acesso a todos os arquivos" para o RetroArch abrir ROMs (`adb shell appops set com.r3dcore.launcher MANAGE_EXTERNAL_STORAGE allow`).
- O `adb` às vezes mostra o A51 como `offline` com o cabo conectado: `adb reconnect offline` resolve.
- Temperatura da GPU Intel não é exposta pelo Windows (aparece N/D).
- `/r3d/*` ficam abertos à rede local sem senha; desligue com `share_library = disabled` no `sunshine.conf`.
- O R3D PLAY depende do .NET 8 instalado no PC.
