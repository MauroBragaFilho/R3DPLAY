#!/usr/bin/env bash
# Instala as dependências de compilação do Apollo no MSYS2 UCRT64 (uma vez).
pacman -S --noconfirm --needed git ninja \
  mingw-w64-ucrt-x86_64-{boost,cmake,cppwinrt,curl-winssl,MinHook,miniupnpc,nsis,onevpl,openssl,opus,toolchain,nlohmann_json,ninja,svt-av1}
