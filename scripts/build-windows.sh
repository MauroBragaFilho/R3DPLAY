#!/usr/bin/env bash
# Compila o Apollo (R3D PLAY) no MSYS2 UCRT64. Uso (PowerShell):
#   $env:MSYSTEM="UCRT64"; C:\msys64\usr\bin\bash.exe -lc "bash /d/Projetos/R3DCORE-Apollo/scripts/build-windows.sh"
# Pré-requisitos: scripts/setup-msys2.sh executado uma vez e o Node.js oficial instalado.
set -e
export PATH="/c/Program Files/nodejs:$PATH"
cd "$(dirname "$0")/.."
cmake -B build -G Ninja -S . > build/cmake.log 2>&1 || { mkdir -p build; cmake -B build -G Ninja -S . > build/cmake.log 2>&1 || { tail -30 build/cmake.log; exit 1; }; }
ninja -C build > build/ninja.log 2>&1 && echo "ninja exit 0" || { echo "ninja exit 1"; tail -30 build/ninja.log; exit 1; }
