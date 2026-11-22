$ErrorActionPreference = 'Stop'
$repo = 'rupakhetibinit/diffloop'
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') { throw "diffloop: unsupported architecture $arch" }

$asset = 'diffloop-windows-x64.exe'
$url = "https://github.com/$repo/releases/latest/download/$asset"
$dir = Join-Path $env:LOCALAPPDATA 'diffloop'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$target = Join-Path $dir 'diffloop.exe'
$staged = Join-Path $dir ("diffloop-{0}.exe" -f [guid]::NewGuid().ToString('N'))

Write-Host "Downloading diffloop ($asset)..."
Invoke-WebRequest -Uri $url -OutFile $staged

$running = Get-Process -Name diffloop -ErrorAction SilentlyContinue
if ($running -and (Test-Path -LiteralPath $target)) {
  $stagedEsc = $staged.Replace("'", "''")
  $targetEsc = $target.Replace("'", "''")
  $script = "Start-Sleep -Milliseconds 800; while (Get-Process -Name diffloop -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }; Move-Item -Force -LiteralPath '$stagedEsc' -Destination '$targetEsc'"
  $argLine = '-NoProfile -WindowStyle Hidden -Command "{0}"' -f $script
  Start-Process powershell -ArgumentList $argLine | Out-Null
  Write-Host "diffloop is running. The update will finish in the background once you close it."
} else {
  Move-Item -Force -LiteralPath $staged -Destination $target
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $dir })
[Environment]::SetEnvironmentVariable('Path', (@($dir) + $parts) -join ';', 'User')
$env:Path = "$dir;$env:Path"

Write-Host "Installed: $target"
if (-not $running) {
  try { & $target --version } catch { Write-Host "Could not start $target yet." }
}
Write-Host "In a new terminal, 'diffloop' should resolve to:"
Write-Host (Join-Path $dir 'diffloop.exe')
