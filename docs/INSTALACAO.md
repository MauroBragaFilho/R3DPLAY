# Instalação do R3D PLAY (notebook e desktop)

O mesmo instalador serve para qualquer PC com Windows 10/11 e uma GPU com codificador de vídeo (NVIDIA, AMD ou Intel).

## 1. Gerar o instalador (na máquina de desenvolvimento)

1. Compilar: `scripts/setup-msys2.sh` (uma vez) e `scripts/build-windows.sh` (MSYS2 UCRT64).
2. Publicar a janela autocontida (não exige .NET no PC de destino): `tools/ApolloConfig/publicar.ps1`.
3. Gerar o instalador: `scripts/gerar-instalador.sh` → `build/cpack_artifacts/R3DPLAY-Setup.exe` (~78 MB).

## 2. Instalar no PC de jogos

1. Copie `R3DPLAY-Setup.exe` para o PC e execute (pede permissão de administrador). Ele instala:
   o serviço, as regras de firewall, o driver de tela virtual (SudoVDA), o driver de controle virtual (ViGEm) e a janela **R3D PLAY**.
2. Abra o **R3D PLAY** pelo ícone da bandeja ou pelo menu Iniciar. Na primeira vez ele pede para **criar usuário e senha**.
   Ele aplica sozinho a configuração inicial (tela virtual como principal durante o jogo) e detecta os jogos da Steam, Epic, GOG e Ubisoft.
3. No celular, abra o R3D LAUNCHER › **Config › Computador › Procurar PCs na rede e sincronizar**. Os jogos do PC aparecem na coleção **PC**.
4. Primeiro jogo: R3D LAUNCHER › Config › **Parear / gerenciar PCs (Moonlight)** › toque no PC › digite o PIN de 4 números no R3D PLAY (aba Início).

## 3. Vários PCs (notebook + desktop)

- Instale o R3D PLAY em cada PC e repita o passo 3 no celular: o launcher junta os jogos de todos os PCs.
  Se o mesmo jogo existir em dois PCs, o título mostra `Jogo · NOME-DO-PC`.
- O pareamento do Moonlight é feito uma vez por PC.
- Em **Sistema › PC** do celular, toque de novo no botão do PC para alternar entre eles.
- Para um PC fora da rede local (ex.: pela Tailscale), use **Adicionar PC por este endereço**.

## 4. Diferenças entre notebook e desktop

| | Notebook (GPU híbrida) | Desktop |
|---|---|---|
| Codificador | Escolhido sozinho (NVENC se houver NVIDIA) | Escolhido sozinho |
| Tela virtual | Funciona; o R3D PLAY ativa o monitor novo com `DisplaySwitch /extend` na sessão do usuário | Igual |
| Monitor físico | Fica como secundário durante o jogo e volta como principal ao sair | Igual |
| Temperatura da GPU | NVIDIA (sim); Intel/AMD (não aparece) | NVIDIA (sim); AMD/Intel (não aparece) |
| Rede | Prefira Wi-Fi 5 GHz ou cabo no PC | Cabo no PC |

Se a tela virtual não for criada (log: `Virtual Display creation failed`), rode `tools/vd-diag` (diagnóstico) e confira se o driver SudoVDA está instalado.

## 5. Atualizar e desinstalar

- Atualizar: execute o novo `R3DPLAY-Setup.exe` por cima (configuração, capas e pareamentos são mantidos).
- Desinstalar: Configurações do Windows › Aplicativos › R3D PLAY.
