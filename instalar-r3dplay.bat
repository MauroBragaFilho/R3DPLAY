@echo off
rem Instala o build local do R3D PLAY (Apollo) em C:\Program Files\Apollo.
rem De dois cliques neste arquivo: o Windows vai pedir permissao de administrador.
echo Instalando o R3D PLAY... (aceite a janela de permissao do Windows)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-r3dplay.ps1"
echo.
echo Quando a janela de administrador fechar, esta instalacao terminou.
pause
