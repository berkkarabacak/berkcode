# Claude Agent Runner - the icon next to the clock (Windows notification area).
# Started by the app (src/tray.js). The icon shows whether the app is idle, working or needs attention; its menu
# opens the app, switches "Start with Windows" on or off and quits the app. It closes itself when the app stops.
# -SelfTest builds the icon and its menu without showing them, to check that this computer can run it.
param(
  [int]$Port = 0,
  [int]$ParentPid = 0,
  [string]$DataDir = '',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$AppName = 'Claude Agent Runner'
$AppRoot = Split-Path -Parent $PSScriptRoot
$IconPath = Join-Path $AppRoot 'public\icon.ico'
$BaseUrl = "http://127.0.0.1:$Port"
$LogFile = $null
if ($DataDir) { $LogFile = Join-Path $DataDir 'logs\tray.log' }

function Write-TrayLog([string]$Text) {
  if (-not $LogFile) { return }
  try { Add-Content -Path $LogFile -Value ('{0} {1}' -f (Get-Date -Format s), $Text) -Encoding UTF8 } catch {}
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  # Nothing to retry: this computer cannot show the icon. The app itself works without it.
  Write-TrayLog "The icon cannot be shown on this computer: $_"
  exit 0
}
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
[System.Windows.Forms.Application]::add_ThreadException({ param($sender, $e) Write-TrayLog "Error: $($e.Exception.Message)" })
[System.Windows.Forms.Application]::EnableVisualStyles()

# ---------------------------------------------------------------------------
# Talking to the app

function Invoke-App([string]$Method, [string]$Path, [string]$Body) {
  $request = [System.Net.HttpWebRequest]::Create($BaseUrl + $Path)
  $request.Method = $Method
  $request.Proxy = $null
  $request.Timeout = 3000
  $request.ReadWriteTimeout = 3000
  if ($Method -ne 'GET') {
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$Body)
    $request.ContentType = 'application/json'
    $request.ContentLength = $bytes.Length
    if ($bytes.Length -gt 0) {
      $stream = $request.GetRequestStream()
      try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Close() }
    }
  }
  $response = $request.GetResponse()
  try {
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
    $text = $reader.ReadToEnd()
  } finally { $response.Close() }
  if ($text) { return ($text | ConvertFrom-Json) }
  return $null
}

function Test-ParentAlive {
  if ($ParentPid -le 0) { return $true }
  $process = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  return [bool]($process -and $process.ProcessName -eq 'node')
}

# ---------------------------------------------------------------------------
# Icons: the app icon, with a blue dot while working, a red dot when something needs attention,
# and faded while the app does not answer.

function Get-IconImage([int]$Size) {
  # The app icon holds one image per size, stored as PNG; the old .NET icon reader turns those into noise,
  # so the image of the best size (the smallest one at least $Size wide) is decoded directly.
  $bytes = [IO.File]::ReadAllBytes($IconPath)
  $entries = @()
  for ($i = 0; $i -lt [BitConverter]::ToUInt16($bytes, 4); $i++) {
    $at = 6 + 16 * $i
    $width = [int]$bytes[$at]
    if ($width -eq 0) { $width = 256 }
    $entries += [pscustomobject]@{ Width = $width; Length = [BitConverter]::ToInt32($bytes, $at + 8); Offset = [BitConverter]::ToInt32($bytes, $at + 12) }
  }
  $sorted = @($entries | Sort-Object Width)
  $best = @($sorted | Where-Object { $_.Width -ge $Size } | Select-Object -First 1)
  if (-not $best) { $best = @($sorted | Select-Object -Last 1) }
  $data = New-Object byte[] $best[0].Length
  [Array]::Copy($bytes, $best[0].Offset, $data, 0, $best[0].Length)
  if ($data[0] -eq 0x89 -and $data[1] -eq 0x50 -and $data[2] -eq 0x4E -and $data[3] -eq 0x47) {
    $script:IconSource = "png $($best[0].Width)px"
    return [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(, $data)))
  }
  $script:IconSource = 'bitmap'
  return (New-Object System.Drawing.Icon($IconPath, $Size, $Size)).ToBitmap()
}

function New-StateIcon([string]$DotColor, [bool]$Faded) {
  $size = [System.Windows.Forms.SystemInformation]::SmallIconSize
  $width = $size.Width
  $height = $size.Height
  $source = Get-IconImage $width
  $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
    if ($Faded) {
      $matrix = New-Object System.Drawing.Imaging.ColorMatrix
      $matrix.Matrix33 = 0.4
      $attributes = New-Object System.Drawing.Imaging.ImageAttributes
      $attributes.SetColorMatrix($matrix)
      $graphics.DrawImage($source, $rect, 0, 0, $width, $height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
    } else {
      $graphics.DrawImage($source, $rect)
    }
    if ($DotColor) {
      $dot = [Math]::Max(6, [int][Math]::Round($width * 0.55))
      $x = $width - $dot
      $y = $height - $dot
      $graphics.FillEllipse([System.Drawing.Brushes]::White, $x - 1, $y - 1, $dot + 1, $dot + 1)
      $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($DotColor))
      $graphics.FillEllipse($brush, $x, $y, $dot - 1, $dot - 1)
      $brush.Dispose()
    }
  } finally {
    $graphics.Dispose()
    $source.Dispose()
  }
  return [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
}

$Icons = @{
  idle = New-StateIcon '' $false
  working = New-StateIcon '#1E88E5' $false
  attention = New-StateIcon '#E53935' $false
  offline = New-StateIcon '' $true
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $Icons.offline
$notify.Text = $AppName
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$notify.ContextMenuStrip = $menu

$script:Status = $null
$script:State = ''
$script:Failures = 0
$script:Quitting = $false
$script:Exiting = $false
$script:LastOpen = [DateTime]::MinValue
$timer = $null

function Set-Tooltip([string]$Text) {
  if (-not $Text) { $Text = $AppName }
  # Windows refuses longer texts for this kind of icon.
  if ($Text.Length -gt 63) { $Text = $Text.Substring(0, 62) + [char]0x2026 }
  $notify.Text = $Text
}

function Set-State([string]$State) {
  if (-not $Icons.ContainsKey($State)) { $State = 'idle' }
  if ($State -ne $script:State) {
    $notify.Icon = $Icons[$State]
    $script:State = $State
  }
}

# ---------------------------------------------------------------------------
# Actions

function Open-App {
  # A double click arrives as two clicks: open the app only once.
  if (([DateTime]::Now - $script:LastOpen).TotalSeconds -lt 2) { return }
  $script:LastOpen = [DateTime]::Now
  try { Start-Process "$BaseUrl/" } catch { Write-TrayLog "Could not open the browser: $_" }
}

function Show-Question([string]$Text) {
  # An invisible owner window in the middle of the screen keeps the question in front of other windows.
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $owner.Opacity = 0
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Show()
  try {
    return [System.Windows.Forms.MessageBox]::Show($owner, $Text, $AppName, [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
  } finally {
    $owner.Close()
    $owner.Dispose()
  }
}

function Switch-Autostart {
  $want = -not [bool]$script:Status.start_with_windows
  $body = '{"start_with_windows":' + $(if ($want) { 'true' } else { 'false' }) + '}'
  [void](Invoke-App 'PUT' '/api/settings' $body)
  Update-Status
  $message = 'The app will no longer start by itself with Windows.'
  if ($want) { $message = 'The app will now start by itself, quietly in the background, when you log in to Windows.' }
  $notify.ShowBalloonTip(5000, $AppName, $message, [System.Windows.Forms.ToolTipIcon]::Info)
}

function Stop-App {
  $text = "Quit $AppName?`r`n`r`nScheduled sessions only run while the app is running. A session that is running now will be stopped.`r`n`r`nYou can start the app again with its icon on your desktop."
  if ((Show-Question $text) -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  $script:Quitting = $true
  Set-State 'offline'
  Set-Tooltip "$AppName`nStopping..."
  try { [void](Invoke-App 'POST' '/api/shutdown' '') } catch { Write-TrayLog "Could not ask the app to stop: $_" }
}

# One click handler for all menu items; each item carries its action in its Tag.
$MenuClick = {
  param($sender, $e)
  try { & $sender.Tag } catch { Write-TrayLog "Menu action failed: $_" }
}

function Add-MenuItem([string]$Text, [scriptblock]$Action) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem($Text)
  $item.Tag = $Action
  $item.add_Click($MenuClick)
  [void]$menu.Items.Add($item)
  return $item
}

function Update-Menu {
  $menu.Items.Clear()
  $open = Add-MenuItem "Open $AppName" { Open-App }
  $open.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $lines = @()
  if ($script:Status) { $lines = @($script:Status.lines) }
  if ($script:Quitting) { $lines = @([pscustomobject]@{ kind = 'info'; text = 'Stopping...' }) }
  elseif (-not $script:Status) { $lines = @([pscustomobject]@{ kind = 'info'; text = 'The app is not answering right now.' }) }
  foreach ($line in $lines) {
    $item = Add-MenuItem ([string]$line.text) { Open-App }
    if ($line.kind -eq 'attention') { $item.ForeColor = [System.Drawing.Color]::FromArgb(183, 28, 28) }
    elseif ($line.kind -eq 'info') { $item.ForeColor = [System.Drawing.SystemColors]::GrayText }
  }
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $auto = Add-MenuItem 'Start with Windows' { Switch-Autostart }
  $auto.Checked = [bool]($script:Status -and $script:Status.start_with_windows)
  $auto.Enabled = [bool]($script:Status -and -not $script:Quitting)
  $quit = Add-MenuItem "Quit $AppName" { Stop-App }
  $quit.Enabled = -not $script:Quitting
}

function Exit-Tray([string]$Reason) {
  $script:Exiting = $true
  Write-TrayLog "Icon closed: $Reason"
  if ($timer) { $timer.Stop() }
  # Removing the icon properly keeps a dead icon from staying next to the clock.
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

function Update-Status {
  if ($script:Exiting) { return }
  if (-not (Test-ParentAlive)) { Exit-Tray 'the app stopped'; return }
  if ($script:Quitting) { return }
  try {
    $status = Invoke-App 'GET' '/api/tray' $null
    $script:Failures = 0
    $script:Status = $status
    if (-not $status.show) { Exit-Tray 'switched off in Settings'; return }
    Set-State ([string]$status.state)
    Set-Tooltip ([string]$status.tooltip)
  } catch {
    $script:Failures++
    if ($script:Failures -ge 2) {
      $script:Status = $null
      Set-State 'offline'
      Set-Tooltip "$AppName`nNot answering right now"
    }
  }
}

function Show-WelcomeOnce {
  if (-not $DataDir) { return }
  $marker = Join-Path $DataDir 'tray-welcome'
  $identity = "$env:COMPUTERNAME|$env:USERNAME"
  try { if ((Test-Path $marker) -and ((Get-Content -Path $marker -Raw -Encoding UTF8).Trim() -eq $identity)) { return } } catch {}
  $notify.ShowBalloonTip(15000, "$AppName is running", 'It works quietly in the background. Click this icon to open it. If you cannot see the icon, click the small arrow (^) next to the clock.', [System.Windows.Forms.ToolTipIcon]::Info)
  try { Set-Content -Path $marker -Value $identity -Encoding UTF8 } catch {}
}

$menu.add_Opening({
  param($sender, $e)
  try { Update-Menu } catch { Write-TrayLog "Menu could not be built: $_" }
  $e.Cancel = $false
})
$notify.add_MouseClick({
  param($sender, $e)
  try { if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-App } } catch { Write-TrayLog "Click failed: $_" }
})
$notify.add_BalloonTipClicked({ try { Open-App } catch {} })

# ---------------------------------------------------------------------------

if ($SelfTest) {
  $script:Status = [pscustomobject]@{
    state = 'attention'
    tooltip = "$AppName`nSelf-test"
    lines = @([pscustomobject]@{ kind = 'working'; text = 'Working on a project' }, [pscustomobject]@{ kind = 'attention'; text = 'Something needs attention' })
    start_with_windows = $true
    show = $true
  }
  Update-Menu
  foreach ($state in @('idle', 'working', 'attention', 'offline')) { Set-State $state }
  Set-Tooltip ('x' * 100)
  $items = $menu.Items.Count
  $tooltip = $notify.Text.Length
  # A menu click must reach its action (and the script's functions).
  $script:Clicked = $false
  $probe = Add-MenuItem 'Probe' { $script:Clicked = [bool](Get-Command Write-TrayLog -ErrorAction SilentlyContinue) }
  $probe.PerformClick()
  if (-not $script:Clicked) { throw 'Menu clicks do not reach their actions.' }
  $notify.Dispose()
  "tray self-test ok: $items menu items, tooltip $tooltip characters, icon from $($script:IconSource)"
  exit 0
}

if (-not (Test-ParentAlive)) { exit 0 }
Update-Menu
$notify.Visible = $true
Update-Status
if (-not $script:Exiting) {
  Show-WelcomeOnce
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 2000
  $timer.add_Tick({ try { Update-Status } catch { Write-TrayLog "Update failed: $_" } })
  $timer.Start()
  Write-TrayLog "Icon started (app on port $Port)."
  [System.Windows.Forms.Application]::Run()
}
exit 0
