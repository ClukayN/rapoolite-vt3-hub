param(
  [int]$Port = 7373,
  [string]$TestIcon = ''
)

# RapooLite 托盘：显示电量、快捷打开界面、开机自启开关。
# 由 start.js 以 -STA -WindowStyle Hidden 启动，也可单独运行调试。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace RapooLite -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(IntPtr hIcon);
'@

$script:baseUrl = "http://127.0.0.1:$Port"
$script:last = $null
$script:misses = 0
$script:trayText = 'RapooLite'

function Get-ApiState {
  try {
    return Invoke-RestMethod -Uri "$($script:baseUrl)/api/state" -TimeoutSec 4
  } catch {
    return $null
  }
}

function Get-ApiAutostart {
  try {
    return Invoke-RestMethod -Uri "$($script:baseUrl)/api/autostart" -TimeoutSec 4
  } catch {
    return $null
  }
}

function New-BatteryBitmap([double]$pct, [bool]$connected) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  if (-not $connected) {
    $color = [System.Drawing.Color]::FromArgb(255, 150, 155, 168)
  } elseif ($pct -le 15) {
    $color = [System.Drawing.Color]::FromArgb(255, 226, 66, 66)
  } elseif ($pct -le 35) {
    $color = [System.Drawing.Color]::FromArgb(255, 232, 150, 30)
  } else {
    $color = [System.Drawing.Color]::FromArgb(255, 38, 178, 116)
  }

  $pen = New-Object System.Drawing.Pen $color, 2.4
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $brush = New-Object System.Drawing.SolidBrush $color

  # 电池外壳 + 正极
  $body = New-Object System.Drawing.Rectangle 3, 9, 22, 14
  $g.DrawRectangle($pen, $body)
  $g.FillRectangle($brush, 26, 13, 3, 6)

  if ($connected -and $pct -gt 0) {
    $ratio = [Math]::Min(100, $pct) / 100.0
    $innerWidth = [Math]::Max(2, [int](18 * $ratio))
    $fill = New-Object System.Drawing.Rectangle 5, 11, $innerWidth, 10
    $g.FillRectangle($brush, $fill)
  } elseif ($connected) {
    $g.FillRectangle($brush, 5, 16, 2, 2)
  }

  $g.Dispose()
  $pen.Dispose()
  $brush.Dispose()
  return $bmp
}

function New-TrayIcon([double]$pct, [bool]$connected) {
  $bmp = New-BatteryBitmap $pct $connected
  $handle = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($handle)
  $clone = $icon.Clone()
  [RapooLite.Native]::DestroyIcon($handle) | Out-Null
  $icon.Dispose()
  $bmp.Dispose()
  return $clone
}

function Find-Edge {
  $paths = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
  )
  foreach ($p in $paths) { if (Test-Path $p) { return $p } }
  return $null
}

function Open-Ui {
  $edge = Find-Edge
  if (-not $edge) {
    Start-Process "$($script:baseUrl)/"
    return
  }
  $profile = Join-Path $PSScriptRoot '.browser-profile'
  Start-Process -FilePath $edge -ArgumentList @(
    "--app=$($script:baseUrl)/",
    "--user-data-dir=$profile",
    '--window-size=1200,900',
    '--no-first-run',
    '--no-default-browser-check'
  ) | Out-Null
}

function Format-Tip($state) {
  if (-not $state -or -not $state.connected) { return 'RapooLite · 未连接' }
  $battery = if ($state.battery -ge 0) { "$($state.battery)%" } else { '电量…' }
  $hz = if ($state.pollingHz) { "$($state.pollingHz)Hz" } else { '' }
  $dpi = ''
  if ($state.dpiX -and $state.dpiX.Count -gt 0) {
    $idx = [Math]::Min([Math]::Max(0, [int]$state.dpiIndex), $state.dpiX.Count - 1)
    $dpi = "$($state.dpiX[$idx])DPI"
  }
  return ("RapooLite · VT3 · " + $battery + " · " + $dpi + " " + $hz).Trim()
}

if ($TestIcon) {
  $cases = @(
    @{ pct = 100; conn = $true },
    @{ pct = 52; conn = $true },
    @{ pct = 21; conn = $true },
    @{ pct = 8; conn = $true },
    @{ pct = 0; conn = $false }
  )
  $scale = 6
  $cell = 32 * $scale
  $strip = New-Object System.Drawing.Bitmap ($cell * $cases.Count), $cell
  $g = [System.Drawing.Graphics]::FromImage($strip)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 30, 32, 38))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  for ($i = 0; $i -lt $cases.Count; $i++) {
    $bmp = New-BatteryBitmap $cases[$i].pct $cases[$i].conn
    $g.DrawImage($bmp, $i * $cell, 0, $cell, $cell)
    $bmp.Dispose()
  }
  $g.Dispose()
  $strip.Save($TestIcon, [System.Drawing.Imaging.ImageFormat]::Png)
  $strip.Dispose()
  Write-Output "icon test saved: $TestIcon"
  return
}

# ---------- 托盘与菜单 ----------

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Visible = $true
$notify.Icon = New-TrayIcon 0 $false
$notify.Text = 'RapooLite'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add('打开界面')
$itemRefresh = $menu.Items.Add('重新读取')
$itemAuto = $menu.Items.Add('开机自启')
$itemAuto.CheckOnClick = $true
$null = $menu.Items.Add('-')
$itemExit = $menu.Items.Add('退出')

$itemOpen.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.WindowState = 'Minimized'
$form.FormBorderStyle = 'None'
$form.Opacity = 0
$form.ShowInTaskbar = $false
$null = $form.Handle  # 强制创建句柄，消息循环才能收到托盘事件

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000

$script:pendingIcon = $null

function Update-Tray {
  $res = Get-ApiState
  if (-not $res) {
    $script:misses++
    if ($script:misses -ge 3) {
      $timer.Stop()
      $notify.Visible = $false
      $notify.Dispose()
      $form.Close()
      return
    }
    $notify.Icon = New-TrayIcon 0 $false
    $notify.Text = 'RapooLite · 未连接'
    return
  }
  $script:misses = 0
  $state = $res.state
  $connected = [bool]$state.connected
  $pct = if ($state.battery -ge 0) { [double]$state.battery } else { 0 }

  $old = $notify.Icon
  $notify.Icon = New-TrayIcon $pct $connected
  if ($old) { $old.Dispose() }

  $notify.Text = Format-Tip $state
}

$timer.Add_Tick({ Update-Tray })

$itemOpen.Add_Click({ Open-Ui })
$itemRefresh.Add_Click({
  try { Invoke-RestMethod -Uri "$($script:baseUrl)/api/refresh" -Method Post -TimeoutSec 10 | Out-Null } catch { }
  Update-Tray
})
$itemAuto.Add_Click({
  try {
    $body = @{ enabled = [bool]$itemAuto.Checked } | ConvertTo-Json
    $res = Invoke-RestMethod -Uri "$($script:baseUrl)/api/autostart" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10
    $itemAuto.Checked = [bool]$res.enabled
  } catch {
    $itemAuto.Checked = -not $itemAuto.Checked
  }
})
$itemExit.Add_Click({
  try { Invoke-RestMethod -Uri "$($script:baseUrl)/api/quit" -Method Post -TimeoutSec 5 | Out-Null } catch { }
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  $form.Close()
})

$notify.ContextMenuStrip = $menu
$notify.Add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Ui }
})

try {
  $auto = Get-ApiAutostart
  if ($auto) { $itemAuto.Checked = [bool]$auto.enabled }
} catch { }

Update-Tray
$timer.Start()
[System.Windows.Forms.Application]::Run($form)

$timer.Stop()
$notify.Visible = $false
$notify.Dispose()
