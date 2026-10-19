# Instala o build local do Apollo (R3D PLAY) por cima da instalação em Program Files.
# Faz backup do sunshine.exe antigo e pede permissão de administrador sozinho.
param([string]$Repo = (Split-Path -Parent $PSScriptRoot), [string]$Dest = "C:\Program Files\Apollo")
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argsList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Repo `"$Repo`" -Dest `"$Dest`""
  Start-Process powershell -Verb RunAs -ArgumentList $argsList
  exit
}
$log = Join-Path $env:TEMP "install-r3dplay.log"
Start-Transcript -Path $log -Force | Out-Null
try {
  Get-Process ApolloConfig -ErrorAction SilentlyContinue | Stop-Process -Force
  Stop-Service ApolloService -Force
  Get-Process sunshine -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep 2
  if (-not (Test-Path "$Dest\sunshine.exe.bak")) { Copy-Item "$Dest\sunshine.exe" "$Dest\sunshine.exe.bak" }
  Copy-Item "$Repo\build\sunshine.exe" "$Dest\sunshine.exe" -Force
  Copy-Item "$Repo\build\assets\web" "$Dest\assets\" -Recurse -Force
  Copy-Item "$Repo\build\assets\shaders" "$Dest\assets\" -Recurse -Force
  robocopy "$Repo\tools\ApolloConfig\out" $Dest /E /XF *.xml *.pdb /NFL /NDL /NJH /NJS | Out-Null
  Start-Service ApolloService
  "OK: instalado"
} catch { "ERRO: $_" }
Stop-Transcript | Out-Null
Write-Host (Get-Content $log -Tail 4 | Out-String)
Start-Sleep 8
