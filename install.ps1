# 把 dist\ 里的成品装到当前用户的程序目录，并接好开机自启与开始菜单快捷方式。
# 为什么不在 D:\dshWorkspace 里直接跑：那个目录带沙盒 ACL（Everyone 拒绝删除子项等），
# 从那里启动的进程 Windows 不会登记托盘图标，写启动项也容易被拒。
param(
    [string]$Source = (Join-Path $PSScriptRoot 'dist'),
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'Programs\RapooLite'),
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path $Source).Path
$exeName = 'RapooLite.exe'
$srcExe = Join-Path $Source $exeName
if (-not (Test-Path $srcExe)) { throw "找不到 $srcExe，请先运行 host\build.ps1" }

Write-Host "[1/4] 结束正在运行的实例"
Get-Process RapooLite -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*RapooLite*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Write-Host "[2/4] 复制到 $Target"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
# data 目录里是用户数据（背景预设等），已存在就不要用发布包里的覆盖
if (Test-Path (Join-Path $Target 'data')) {
  robocopy $Source $Target /E /XD (Join-Path $Source 'data') /NFL /NDL /NJH /NJS /NP | Out-Null
} else {
  robocopy $Source $Target /E /NFL /NDL /NJH /NJS /NP | Out-Null
}
Get-ChildItem $Target -Filter 'probe-*.log' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $Target -Filter 'icon-preview.png' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
$exe = Join-Path $Target $exeName

Write-Host "[3/4] 接好开机自启（当前用户 Run 项）"
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Set-ItemProperty -Path $runKey -Name 'RapooLite' -Value ('"' + $exe + '" --silent') -Type String -Force

Write-Host "[4/4] 创建开始菜单快捷方式"
$lnkDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnkPath = Join-Path $lnkDir 'RapooLite.lnk'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = $Target
$lnk.IconLocation = $exe + ',0'
$lnk.Description = 'RapooLite · 雷柏 VT3 配置工具'
$lnk.Save()

Write-Host ''
Write-Host "安装完成：$exe"
Write-Host "  开机自启 : $((Get-ItemProperty -Path $runKey -Name 'RapooLite').RapooLite)"
Write-Host "  快捷方式 : $lnkPath"
$sig = Get-AuthenticodeSignature $exe
Write-Host "  签名状态 : $($sig.Status)"

if (-not $NoLaunch) {
    Write-Host '  启动中 ...'
    Start-Process $exe
}
