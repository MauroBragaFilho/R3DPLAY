#!/usr/bin/env bash
# Gera o instalador completo do R3D PLAY (Apollo + janela nativa + drivers) em build/cpack_artifacts.
# Uso (PowerShell):  $env:MSYSTEM="UCRT64"; C:\msys64\usr\bin\bash.exe -lc "bash /d/Projetos/R3DCORE-Apollo/scripts/gerar-instalador.sh"
# Antes: scripts/build-windows.sh (compila) e tools/ApolloConfig/publicar.ps1 (publica a janela).
set -e
cd "$(dirname "$0")/.."
cmake -B build -G Ninja -S . > build/cmake.log 2>&1
cd build && cpack -G NSIS
ls -la cpack_artifacts/*.exe
