$ErrorActionPreference = 'Stop'
$repo = 'rupakhetibinit/diffloop'
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') { throw "diffloop: unsupported architecture $arch" }

$asset = 'diffloop-windows-x64.exe'
$url = "https://github.com/$repo/releases/latest/download/$asset"
$dir = Join-Path $env:LOCALAPPDATA 'diffloop'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$target = Join-Path $dir 'diffloop.exe'
$tmp = Join-Path $dir 'diffloop.download.exe'

Write-Host "Downloading diffloop ($asset)..."
Invoke-WebRequest -Uri $url -OutFile $tmp
Move-Item -Force $tmp $target

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
  Write-Host "Added $dir to your user PATH. Open a new terminal to use 'diffloop'."
}

Write-Host "Installed: $target"
Write-Host 'Run: diffloop --repo C:\path\to\repo'
