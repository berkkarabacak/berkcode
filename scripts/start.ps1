# Claude Agent Runner - start script.
# Installs everything the app needs on first start (Node.js, Git, app components),
# starts the app in the background and opens it in the browser.
# Run through start.bat; "-Background" is used by "Start with Windows" (no window, no browser).
param([switch]$Background)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Root = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root 'runtime'
$Data = Join-Path $Root 'data'
$LogDir = Join-Path $Data 'logs'
$NodeDir = Join-Path $Runtime 'node'
$NodeExe = Join-Path $NodeDir 'node.exe'
$NodeMajor = 24
$NodeFallbackVersion = 'v24.22.3'
$GitDir = Join-Path $Runtime 'git'
$GitFallbackVersion = '2.56.1'
$GitFallbackTag = 'v2.56.1.windows.1'
$RuntimeInfo = Join-Path $Data 'runtime.json'
$SetupLog = Join-Path $LogDir 'setup.log'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Claude Agent Runner'

New-Item -ItemType Directory -Force -Path $Runtime, $Data, $LogDir | Out-Null

function Write-SetupLog([string]$Text) {
  try { Add-Content -Path $SetupLog -Value ('{0} {1}' -f (Get-Date -Format s), $Text) -Encoding UTF8 } catch {}
}

function Say([string]$Text, [string]$Color = 'Gray') {
  if (-not $Background) { Write-Host "  $Text" -ForegroundColor $Color }
  Write-SetupLog $Text
}

function Stop-WithError([string]$Text) {
  Write-SetupLog "ERROR: $Text"
  if ($Background) { exit 1 }
  Write-Host ''
  Write-Host '  Sorry, something went wrong:' -ForegroundColor Red
  Write-Host "  $Text" -ForegroundColor Red
  Write-Host ''
  Write-Host '  Please check the internet connection and double-click start.bat again.' -ForegroundColor Yellow
  Write-Host '  If it keeps happening, send this file to the person who gave you the app:' -ForegroundColor Yellow
  Write-Host "  $SetupLog" -ForegroundColor Yellow
  Write-Host ''
  Read-Host '  Press Enter to close this window' | Out-Null
  exit 1
}

function Open-Browser([string]$Url) {
  # Start the browser from the user's folder, so it does not keep the app folder in use.
  try {
    Set-Location -LiteralPath $env:USERPROFILE
    [Environment]::CurrentDirectory = $env:USERPROFILE
  } catch {}
  Start-Process $Url
}

# True when both paths are the same app folder, also when one of them is written differently
# (short 8.3 names such as C:\Users\ODINLO~1, links or mapped drives): a probe file made in one must appear in the other.
function Test-SamePath([string]$A, [string]$B) {
  if (-not $A -or -not $B) { return $false }
  try {
    $first = [IO.Path]::GetFullPath($A).TrimEnd('\')
    $second = [IO.Path]::GetFullPath($B).TrimEnd('\')
    if ($first.Equals($second, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    $firstData = Join-Path $first 'data'
    $secondData = Join-Path $second 'data'
    if (-not (Test-Path -LiteralPath $firstData -PathType Container) -or -not (Test-Path -LiteralPath $secondData -PathType Container)) { return $false }
    $probe = '.same-folder-check-' + [Guid]::NewGuid().ToString('N')
    $probeFile = Join-Path $firstData $probe
    New-Item -ItemType File -Path $probeFile -Force | Out-Null
    try { return (Test-Path -LiteralPath (Join-Path $secondData $probe)) }
    finally { Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue }
  } catch { return $false }
}

# The app is running from THIS folder if the server recorded in data\runtime.json answers and reports this folder.
# (A runtime.json copied along from another folder or computer is ignored.)
function Get-RunningAppUrl {
  if (-not (Test-Path $RuntimeInfo)) { return $null }
  try {
    # The app writes UTF-8; Windows PowerShell would otherwise read it in the old ANSI code page and garble
    # folder names with letters such as c-cedilla or dotless i.
    $info = Get-Content -Path $RuntimeInfo -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($info.root -and -not (Test-SamePath $info.root $Root)) { return $null }
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$($info.port)/api/ping")
    $request.Proxy = $null
    $request.Timeout = 2000
    $response = $request.GetResponse()
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $body = $reader.ReadToEnd()
    $response.Close()
    $ping = $body | ConvertFrom-Json
    $sameFolder = (-not $ping.root) -or (Test-SamePath $ping.root $Root)
    if ($ping.app -eq 'claude-agent-runner' -and $ping.pid -eq $info.pid -and $sameFolder) { return "http://127.0.0.1:$($info.port)" }
  } catch {}
  return $null
}

function Get-Arch {
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { return 'arm64' }
  return 'x64'
}

function Get-File([string]$Url, [string]$Destination) {
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      if (Test-Path $Destination) { Remove-Item $Destination -Force }
      Write-SetupLog "Downloading $Url"
      if (Test-Path $curl) {
        $curlArgs = @('-L', '--fail', '--show-error', '--retry', '2', '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '90', '-o', $Destination, $Url)
        if ($Background) { $curlArgs = @('--silent') + $curlArgs } else { $curlArgs = @('--progress-bar') + $curlArgs }
        & $curl @curlArgs
        if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit code $LASTEXITCODE)" }
      } else {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
      }
      if ((Test-Path $Destination) -and ((Get-Item $Destination).Length -gt 0)) { return }
      throw 'the downloaded file is empty'
    } catch {
      Write-SetupLog "Download attempt $attempt failed: $_"
      if ($attempt -eq 3) { throw "Could not download $Url ($_)" }
      Say "Download problem, trying again (attempt $($attempt + 1) of 3)..." 'Yellow'
      Start-Sleep -Seconds (5 * $attempt)
    }
  }
}

function Expand-ZipFile([string]$Zip, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
}

function Install-Node {
  if (Test-Path $NodeExe) {
    try {
      $current = (& $NodeExe --version).Trim()
      if ($current -like "v$NodeMajor.*") { return }
    } catch {}
  }
  Say 'Downloading Node.js (only the first time, about 35 MB)...' 'Cyan'
  $arch = Get-Arch
  $version = $NodeFallbackVersion
  try {
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 30
    foreach ($release in $index) {
      if ($release.version -like "v$NodeMajor.*" -and ($release.files -contains "win-$arch-zip")) { $version = $release.version; break }
    }
  } catch { Write-SetupLog "Could not read the Node.js version list, using $version. $_" }
  $name = "node-$version-win-$arch"
  $zip = Join-Path $Runtime "$name.zip"
  Get-File "https://nodejs.org/dist/$version/$name.zip" $zip

  $expected = $null
  try {
    $sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 30).Content
    foreach ($line in ($sums -split "`n")) {
      if ($line -match ('^([0-9a-f]{64})\s+' + [regex]::Escape("$name.zip") + '\s*$')) { $expected = $Matches[1] }
    }
  } catch { Write-SetupLog "Could not download the Node.js checksums: $_" }
  if ($expected) {
    $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
      Remove-Item $zip -Force
      throw 'The Node.js download was damaged. Please try again.'
    }
  }

  Say 'Unpacking Node.js...'
  $unpack = Join-Path $Runtime 'node-unpack'
  if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }
  Expand-ZipFile $zip $unpack
  if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
  Move-Item -Path (Join-Path $unpack $name) -Destination $NodeDir
  Remove-Item $unpack -Recurse -Force
  Remove-Item $zip -Force
  if (-not (Test-Path $NodeExe)) { throw 'Node.js could not be installed.' }
  Say "Node.js $version is ready." 'Green'
}

function Test-GitAvailable {
  if (Test-Path (Join-Path $GitDir 'bin\bash.exe')) { return $true }
  # Test switch: behave as if Git were not installed on this computer.
  if ($env:RUNNER_TEST_IGNORE_SYSTEM_GIT -eq '1') { return $false }
  if (Get-Command git.exe -ErrorAction SilentlyContinue) { return $true }
  foreach ($candidate in @("$env:ProgramFiles\Git\bin\bash.exe", "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe")) {
    if (Test-Path $candidate) { return $true }
  }
  return $false
}

function Install-Git {
  if (Test-GitAvailable) { return }
  Say 'Downloading Git for Windows (only the first time, about 60 MB)...' 'Cyan'
  try {
    $suffix = if ((Get-Arch) -eq 'arm64') { 'arm64' } else { '64-bit' }
    $url = "https://github.com/git-for-windows/git/releases/download/$GitFallbackTag/PortableGit-$GitFallbackVersion-$suffix.7z.exe"
    try {
      $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing -TimeoutSec 30 -Headers @{ 'User-Agent' = 'claude-agent-runner' }
      foreach ($asset in $release.assets) {
        if ($asset.name -like "PortableGit-*-$suffix.7z.exe") { $url = $asset.browser_download_url; break }
      }
    } catch { Write-SetupLog "Could not read the latest Git version, using $GitFallbackVersion. $_" }
    $installer = Join-Path $Runtime 'PortableGit.7z.exe'
    Get-File $url $installer
    Say 'Unpacking Git...'
    if (Test-Path $GitDir) { Remove-Item $GitDir -Recurse -Force }
    $process = Start-Process -FilePath $installer -ArgumentList @('-y', "-o`"$GitDir`"") -Wait -PassThru -WindowStyle Hidden
    Remove-Item $installer -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path (Join-Path $GitDir 'bin\bash.exe'))) { throw "unpacking failed (exit code $($process.ExitCode))" }
    Say 'Git is ready.' 'Green'
  } catch {
    Write-SetupLog "Git could not be installed: $_"
    Say 'Git could not be installed. That is OK: the app still works (the agent uses PowerShell instead).' 'Yellow'
  }
}

function Install-Dependencies {
  $lock = Join-Path $Root 'package-lock.json'
  $marker = Join-Path $Root 'node_modules\.install-ok'
  $engine = Join-Path $Root 'node_modules\@anthropic-ai\claude-agent-sdk\package.json'
  $wanted = (Get-FileHash -Path $lock -Algorithm SHA256).Hash
  if ((Test-Path $marker) -and (Test-Path $engine) -and ((Get-Content -Path $marker -Raw).Trim() -eq $wanted)) { return }

  Say 'Installing the app components (only the first time, this can take a few minutes)...' 'Cyan'
  $npm = Join-Path $NodeDir 'npm.cmd'
  $env:Path = "$NodeDir;$env:Path"
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      & $npm ci --no-audit --no-fund --loglevel=error 2>&1 | ForEach-Object { Write-SetupLog "npm: $_" }
      if ($LASTEXITCODE -eq 0 -and (Test-Path $engine)) {
        Set-Content -Path $marker -Value $wanted -Encoding ASCII
        Say 'App components are ready.' 'Green'
        return
      }
      if ($attempt -lt 3) {
        Say "Installing did not work (attempt $attempt of 3), trying again..." 'Yellow'
        Start-Sleep -Seconds (10 * $attempt)
      }
    }
  } finally {
    $ErrorActionPreference = $previous
  }
  throw 'The app components could not be installed.'
}

function Test-InOneDrive {
  foreach ($folder in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
    if ($folder -and ($Root + '\').StartsWith($folder.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function New-DesktopShortcut([string]$AppFolder) {
  # The marker remembers the computer, user and folder the icon was made for, so a copy of the app
  # on another computer (or in another folder) gets its own icon.
  $marker = Join-Path $AppFolder 'data\shortcut-created'
  $identity = "$env:COMPUTERNAME|$env:USERNAME|$AppFolder"
  if ((Test-Path $marker) -and ((Get-Content -Path $marker -Raw -Encoding UTF8).Trim() -eq $identity)) { return }
  try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $link = Join-Path $desktop 'Claude Agent Runner.lnk'
    $target = Join-Path $AppFolder 'start.bat'
    $shell = New-Object -ComObject WScript.Shell
    if (Test-Path $link) {
      $existing = $shell.CreateShortcut($link).TargetPath
      $ours = $existing -and $existing.Equals($target, [StringComparison]::OrdinalIgnoreCase)
      if ($ours -or ($existing -and (Test-Path $existing))) {
        # The icon already opens this folder, or another working copy of the app: leave it alone.
        New-Item -ItemType Directory -Force -Path (Join-Path $AppFolder 'data') | Out-Null
        Set-Content -Path $marker -Value $identity -Encoding UTF8
        return
      }
    }
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $AppFolder
    $icon = Join-Path $AppFolder 'public\icon.ico'
    if (Test-Path $icon) { $shortcut.IconLocation = $icon }
    $shortcut.Description = 'Start Claude Agent Runner'
    $shortcut.Save()
    New-Item -ItemType Directory -Force -Path (Join-Path $AppFolder 'data') | Out-Null
    Set-Content -Path $marker -Value $identity -Encoding UTF8
    Say 'A "Claude Agent Runner" icon was added to your desktop. Use it to open the app next time.' 'Green'
  } catch { Write-SetupLog "Could not create the desktop icon: $_" }
}

# ---------------------------------------------------------------------------

if (-not $Background) {
  Write-Host ''
  Write-Host '  Claude Agent Runner' -ForegroundColor White
  Write-Host '  -------------------' -ForegroundColor DarkGray
}
Write-SetupLog "Start script running from $Root"

# Already running? Then just open it.
$url = Get-RunningAppUrl
if ($url) {
  Say 'The app is already running. Opening it in your browser...' 'Green'
  if (-not $Background) { Open-Browser $url; Start-Sleep -Seconds 2 }
  exit 0
}

# A folder synced by OneDrive is not a safe place for the app's database: install a local copy instead.
if ((Test-InOneDrive) -and -not $Root.Equals($InstallDir, [StringComparison]::OrdinalIgnoreCase)) {
  Say 'This folder is synced by OneDrive. The app will be installed in a local folder so it works reliably...' 'Cyan'
  try {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    # The app's own files are refreshed on every start. The data and the project folders are copied only the
    # first time: from then on the local copy is the one in use, and copying them again would overwrite newer work.
    & robocopy.exe $Root $InstallDir /E /XD node_modules runtime data projects .git scratch /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copying failed (robocopy code $LASTEXITCODE)" }
    $sourceData = Join-Path $Root 'data\app.db'
    $targetData = Join-Path $InstallDir 'data'
    if ((Test-Path $sourceData) -and -not (Test-Path (Join-Path $targetData 'app.db'))) {
      & robocopy.exe (Join-Path $Root 'data') $targetData /E /XD logs tmp /XF runtime.json /NFL /NDL /NJH /NJS /NP | Out-Null
      if ($LASTEXITCODE -ge 8) { throw "copying the data failed (robocopy code $LASTEXITCODE)" }
      # Also take along what an app folder copied from another computer already has, so nothing is downloaded again.
      foreach ($part in @('projects', 'runtime', 'node_modules')) {
        $from = Join-Path $Root $part
        $to = Join-Path $InstallDir $part
        if ((Test-Path $from) -and -not (Test-Path $to)) {
          & robocopy.exe $from $to /E /NFL /NDL /NJH /NJS /NP | Out-Null
          if ($LASTEXITCODE -ge 8) { throw "copying $part failed (robocopy code $LASTEXITCODE)" }
        }
      }
    }
  } catch { Stop-WithError "The app could not be copied to $InstallDir. $_" }
  Say "Installed in $InstallDir" 'Green'
  # Run the local copy's start script right here. (Start-Process -Wait would also wait for the app it starts,
  # which keeps running, so this window would never close.)
  $installScript = Join-Path $InstallDir 'scripts\start.ps1'
  if ($Background) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript -Background }
  else { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript }
  exit $LASTEXITCODE
}

# Files downloaded from the internet are marked as unsafe by Windows; the app's own files are fine.
try {
  foreach ($folder in @($Root, (Join-Path $Root 'scripts'), (Join-Path $Root 'src'), (Join-Path $Root 'public'))) {
    Get-ChildItem -Path $folder -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
  }
  # An app folder that arrived as a download (for example a ZIP from e-mail or cloud storage) also carries the
  # mark on its own Node.js and components, which can make Windows ask before starting them. Remove it once.
  if (Get-Item -LiteralPath $NodeExe -Stream Zone.Identifier -ErrorAction SilentlyContinue) {
    Say 'Preparing the copied app files (only once)...'
    Get-ChildItem -LiteralPath $Runtime, (Join-Path $Root 'node_modules') -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
  }
} catch {}

try { Install-Node } catch { Stop-WithError "Node.js could not be installed. $_" }
Install-Git
try { Install-Dependencies } catch { Stop-WithError "$_" }

Say 'Starting the app...' 'Cyan'
$launcher = Join-Path $Root 'src\launcher.js'
try {
  Start-Process -FilePath $NodeExe -ArgumentList @("`"$launcher`"") -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
} catch { Stop-WithError "The app could not be started. $_" }

$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  $url = Get-RunningAppUrl
  if ($url) {
    if ($Background) { exit 0 }
    New-DesktopShortcut $Root
    Say "The app is running at $url" 'Green'
    Say 'Opening it in your browser. You can close this window; the app keeps running in the background.' 'Green'
    Open-Browser $url
    Start-Sleep -Seconds 6
    exit 0
  }
}

$appLog = Get-ChildItem -Path $LogDir -Filter 'app-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
if ($appLog) {
  Write-SetupLog '--- last lines of the app log ---'
  Get-Content -Path $appLog.FullName -Tail 30 -Encoding UTF8 | ForEach-Object { Write-SetupLog $_ }
}
Stop-WithError 'The app did not start within 90 seconds.'
