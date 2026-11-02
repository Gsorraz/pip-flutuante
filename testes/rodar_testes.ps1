# Executor de testes da extensao PiP Flutuante. SEM navegador, SEM janelas, SEM mouse/teclado.
# Uso: powershell -File testes\rodar_testes.ps1 -Motivo "o que mudou em 1 frase"
# Faz: node --check (dentro do teste) + testes de logica com mocks de DOM/chrome.* ; grava testes\logs\execucoes.jsonl
param([string]$Motivo = "")

$ErrorActionPreference = 'Continue'
$testes = $PSScriptRoot
$raiz   = Split-Path -Parent $testes
$logs   = Join-Path $testes 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$inicio = Get-Date
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Output 'node nao encontrado no PATH'; exit 3 }

$saida  = (& node (Join-Path $testes 'teste_logica.js') 2>&1 | Out-String)
$codigo = $LASTEXITCODE
Set-Content -Path (Join-Path $logs 'ultima_saida.txt') -Value $saida -Encoding UTF8
Write-Output $saida

$ok = 0; $falhas = -1; $avisos = 0
if ($saida -match 'RESULTADO ok=(\d+) falhas=(\d+)') { $ok = [int]$Matches[1]; $falhas = [int]$Matches[2] }
if ($saida -match 'avisos=(\d+)') { $avisos = [int]$Matches[1] }

function Sha($nome) {
    $p = Join-Path $raiz $nome
    if (Test-Path $p) { (Get-FileHash -Algorithm SHA1 -Path $p).Hash.Substring(0, 8).ToLower() } else { '' }
}
$versao = ''
try { $versao = (Get-Content (Join-Path $raiz 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}

$status = if ($codigo -eq 0 -and $falhas -eq 0 -and $ok -gt 0) { 'PASSOU' } else { 'FALHOU' }
$reg = [ordered]@{
    ts        = $inicio.ToString('s')
    motivo    = $Motivo
    versao    = $versao
    content   = Sha 'content.js'
    background = Sha 'background.js'
    bridge    = Sha 'yt-bridge.js'
    ok        = $ok
    falhas    = $falhas
    avisos    = $avisos
    segundos  = [math]::Round(((Get-Date) - $inicio).TotalSeconds, 1)
    status    = $status
    executado = $true
}
Add-Content -Path (Join-Path $logs 'execucoes.jsonl') -Value ($reg | ConvertTo-Json -Compress) -Encoding UTF8
Write-Output ("{0}: ok={1} falhas={2} avisos={3}" -f $status, $ok, $falhas, $avisos)
if ($status -eq 'PASSOU') { exit 0 } else { exit 1 }
