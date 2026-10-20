# Publicar uma versão do R3D PLAY (GitHub Actions)

O instalador `R3DPLAY-Setup.exe` é compilado pelo GitHub quando você cria uma **tag nova**. O arquivo do workflow é
`.github/workflows/release.yml`.

## Publicar

```bash
git tag v1.1.0
git push origin v1.1.0
```

Pode ser `v1.1.0`, `V1.1` ou `v1.2.0-beta.1` (tags com `-` viram "pré-lançamento"). O GitHub compila (veja a aba **Actions**) e, no fim,
cria a release da tag com `R3DPLAY-Setup.exe` e `R3DPLAY-Setup.exe.sha256`. Se a release da tag já existir (criada à mão), o workflow só
anexa os arquivos. A versão que aparece no Windows (Adicionar ou remover programas) é a da tag; `1.0` vira `1.0.0`.

A tag precisa apontar para um commit que já tenha o workflow (as tags antigas, como a `V1.0`, não disparam nada).

## Testar sem publicar

Na aba **Actions**, escolha **Release do instalador (Windows)** e clique em **Run workflow**. Ele compila tudo e guarda o instalador como
**artefato** da execução (aba da execução > Artifacts, por 30 dias), sem criar release nem tag.

## O que o workflow faz

1. Baixa o código com os submódulos e roda os testes do painel (`node --test`).
2. Publica a janela do R3D PLAY (`tools/ApolloConfig`, C#, arquivo único autocontido) em `tools/ApolloConfig/publish`: o CMake empacota essa pasta no instalador.
3. Instala o MSYS2 UCRT64 com as mesmas dependências de `scripts/setup-msys2.sh`.
4. Compila (`cmake` + `ninja`) e empacota (`cpack -G NSIS`) com a versão da tag em `BUILD_VERSION`.
5. Gera o SHA-256, guarda o artefato e, se o gatilho foi uma tag, anexa tudo à release.

A compilação completa leva de uma hora a uma hora e meia num servidor do GitHub (o repositório é público, então não consome minutos pagos).

## Limites

- O instalador **não é assinado**. Para o SmartScreen e os antivírus pararem de avisar é preciso um certificado de assinatura de código (pago).
  Arquivos novos e sem assinatura que instalam drivers, serviço e regras de firewall também costumam ser marcados por scanners automáticos
  (o Google Drive chegou a bloquear o compartilhamento do `.exe`). O SHA-256 da release permite conferir a integridade.
- O APK do R3D LAUNCHER **não** é gerado aqui: ele depende do fork do RetroArch e dos cores, que ficam fora do repositório do launcher.
