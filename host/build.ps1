# RapooLite 打包脚本：编译原生宿主并把 Node 后端/界面/依赖一起放进 dist\
# 用法：powershell -ExecutionPolicy Bypass -File host\build.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$app = Join-Path $dist 'app'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) { throw "找不到 csc.exe：$csc" }

Write-Host "[1/5] 准备目录 $dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $app) { Remove-Item $app -Recurse -Force }
New-Item -ItemType Directory -Force -Path $app | Out-Null

# 图标（鼠标轮廓）：每次重新生成，保证与代码里的托盘图标一致
$iconScript = Join-Path $PSScriptRoot 'make-icon.ps1'
if (Test-Path $iconScript) {
    Write-Host '  · 生成图标 app.ico'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $iconScript | Out-Null
}

Write-Host '[2/5] 编译 RapooLite.exe'
Push-Location $PSScriptRoot
& $csc /nologo /target:winexe /platform:x64 /optimize+ `
    /out:"$dist\RapooLite.exe" `
    /win32manifest:"$PSScriptRoot\app.manifest" `
    /win32icon:"$PSScriptRoot\app.ico" `
    /r:lib\Microsoft.Web.WebView2.Core.dll `
    /r:lib\Microsoft.Web.WebView2.WinForms.dll `
    /r:System.dll /r:System.Core.dll /r:System.Drawing.dll `
    /r:System.Windows.Forms.dll /r:System.Net.Http.dll /r:System.Net.dll `
    Program.cs
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }
Pop-Location

Write-Host '[2/5] 写入 WinForms 高 DPI 配置'
$cfg = @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <startup>
    <supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" />
  </startup>
  <System.Windows.Forms.ApplicationConfigurationSection>
    <add key="DpiAwareness" value="PerMonitorV2" />
    <add key="EnableWindowsFormsHighDpiAutoResizing" value="true" />
  </System.Windows.Forms.ApplicationConfigurationSection>
</configuration>
'@
Set-Content -Path (Join-Path $dist 'RapooLite.exe.config') -Value $cfg -Encoding UTF8

Write-Host '[3/5] 复制 WebView2 运行时依赖'
Copy-Item (Join-Path $PSScriptRoot 'lib\Microsoft.Web.WebView2.Core.dll') $dist -Force
Copy-Item (Join-Path $PSScriptRoot 'lib\Microsoft.Web.WebView2.WinForms.dll') $dist -Force
Copy-Item (Join-Path $PSScriptRoot 'lib\WebView2Loader.dll') $dist -Force

Write-Host '[4/5] 复制后端与界面到 app\'
Copy-Item (Join-Path $root 'server.js') $app -Force
Copy-Item (Join-Path $root 'start.js') $app -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root 'package.json') $app -Force
Copy-Item (Join-Path $root 'lib') $app -Recurse -Force
Copy-Item (Join-Path $root 'ui') $app -Recurse -Force
Copy-Item (Join-Path $root 'node_modules') $app -Recurse -Force

Write-Host '[5/5] 打包完成'
$exe = Get-Item (Join-Path $dist 'RapooLite.exe')
$total = (Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("  可执行文件 : {0}  ({1:N0} KB)" -f $exe.FullName, ($exe.Length / 1KB))
Write-Host ("  目录总大小 : {0:N1} MB" -f ($total / 1MB))
Write-Host '  运行方式   : 双击 dist\RapooLite.exe'
