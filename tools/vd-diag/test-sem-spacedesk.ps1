# Teste reversível: desliga por alguns segundos o adaptador do spacedesk, roda o diagnóstico da tela virtual e religa.
param([string]$Out = "$env:TEMP\vd-diag-spacedesk.txt")
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Out `"$Out`""
  exit
}
$exe = Join-Path $PSScriptRoot 'vd_diag.exe'
$dev = Get-PnpDevice -Class Display | Where-Object FriendlyName -like 'spacedesk*' | Select-Object -First 1
$log = @()
try {
  if ($dev) { $log += "Desligando: $($dev.FriendlyName)"; Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false; Start-Sleep 4 }
  $env:PATH = "C:\msys64\ucrt64\bin;$env:PATH"
  $log += (& $exe 2>&1 | Select-String 'Tela adicionada|TESTE|nome da tela|ativos' | Select-Object -First 12 | ForEach-Object { $_.Line })
} finally {
  if ($dev) { Enable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false; $log += "Religado: $($dev.FriendlyName)" }
  $log | Set-Content $Out -Encoding UTF8
}
