# 生成 RapooLite 的 MSI 安装包（WiX 3.x，per-user 安装）
# 用法：powershell -ExecutionPolicy Bypass -File installer\build-msi.ps1
param(
    [string]$Version = '1.0.0.0',
    [switch]$SkipSign
)

$ErrorActionPreference = 'Stop'

# WiX 的 light.exe 会往 %TEMP% 写临时文件；本机 TEMP 权限受限，改到项目内
$tmpDir = Join-Path $PSScriptRoot '.wix-tmp'
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$env:TMP = $tmpDir
$env:TEMP = $tmpDir
$root = Split-Path -Parent $PSScriptRoot
$wix = Join-Path $root 'tools\wix\tools'
$stage = Join-Path $PSScriptRoot 'stage'
$obj = Join-Path $PSScriptRoot 'obj'
$msi = Join-Path $root 'dist\RapooLite-Setup.msi'

function Step($n, $text) { Write-Host "[$n/6] $text" -ForegroundColor Cyan }

if (-not (Test-Path (Join-Path $wix 'candle.exe'))) {
    throw "找不到 WiX 工具：$wix（需要 tools\wix\tools\candle.exe）"
}

# 1) 准备暂存目录：只带程序本体，不带用户数据/缓存/日志
Step 1 '准备暂存目录'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
robocopy (Join-Path $root 'dist') $stage /E /NFL /NDL /NJH /NJS /XD (Join-Path $root 'dist\userdata') (Join-Path $root 'dist\data') /XF *.log icon-preview.png 'RapooLite-Setup.msi' *.wixpdb | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }

# 2) 许可证文本（RTF，WiX 的 Minimal UI 会显示）
Step 2 '生成许可证文本'
$licenseText = @'
{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fswiss Segoe UI;}}
\viewkind4\uc1\pard\f0\fs20
RapooLite 1.0\par
\par
This is an unofficial, third-party configuration tool for the Rapoo VT3 mouse.\par
It is provided AS IS, without warranty of any kind.\par
\par
It only writes configuration registers of your own mouse; no firmware is modified.\par
Use at your own risk. The author is not responsible for any damage.\par
\par
The bundled WebView2 runtime files are Microsoft redistributables.\par
}
'@
$licensePath = Join-Path $PSScriptRoot 'license.rtf'
[System.IO.File]::WriteAllText($licensePath, $licenseText, [System.Text.Encoding]::ASCII)

# 2b) 生成 WiX UI 位图（banner / dialog）
Add-Type -AssemblyName System.Drawing
function New-Banner([string]$path, [int]$w, [int]$h, [string]$title, [string]$sub) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(28,30,40)), ([System.Drawing.Color]::FromArgb(58,62,84)), 20.0
    $g.FillRectangle($brush, $rect)
    $brush.Dispose()
    $f1 = New-Object System.Drawing.Font 'Segoe UI', ([Math]::Max(12, $h * 0.32)), ([System.Drawing.FontStyle]::Bold)
    $w1 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240,242,250))
    $g.DrawString($title, $f1, $w1, 16, [Math]::Max(2, ($h - $f1.Height) / 2 - 2))
    if ($sub) {
        $f2 = New-Object System.Drawing.Font 'Segoe UI', ([Math]::Max(8, $h * 0.16))
        $w2 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(170,176,196))
        $g.DrawString($sub, $f2, $w2, 18, ($h - $f1.Height) / 2 + $f1.Height - 4)
        $f2.Dispose(); $w2.Dispose()
    }
    $g.Dispose(); $f1.Dispose(); $w1.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
}
New-Banner (Join-Path $PSScriptRoot 'banner.bmp') 493 58 'RapooLite' ''
New-Banner (Join-Path $PSScriptRoot 'dialog.bmp') 493 312 'RapooLite' '雷柏 VT3 驱动'
# 3) 收集文件（heat）
Step 3 '收集文件清单'
$harvest = Join-Path $PSScriptRoot 'Harvest.wxs'
& (Join-Path $wix 'heat.exe') dir $stage -cg AppFiles -gg -g1 -sfrag -srd -sreg -dr INSTALLDIR -var var.StageDir -out $harvest
if ($LASTEXITCODE -ne 0) { throw "heat 失败" }

# 4) 编译（candle）
Step 4 '编译 wxs'
if (Test-Path $obj) { Remove-Item $obj -Recurse -Force }
New-Item -ItemType Directory -Path $obj -Force | Out-Null
$product = Join-Path $PSScriptRoot 'product.wxs'
& (Join-Path $wix 'candle.exe') -nologo -ext WixUIExtension -dStageDir="$stage" -dVersion="$Version" -out "$obj\" $product $harvest
if ($LASTEXITCODE -ne 0) { throw "candle 失败" }

# 5) 链接（light）
Step 5 '生成 MSI'
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$env:TMP = $tmpDir; $env:TEMP = $tmpDir
$light = Join-Path $wix 'light.exe'
$cmd = 'set TMP=' + $tmpDir + '&& set TEMP=' + $tmpDir + '&& "' + $light + '" -nologo -sval -ext WixUIExtension -sice:ICE60 -sice:ICE61 -b "' + $PSScriptRoot + '" -out "' + $msi + '" "' + (Join-Path $obj 'product.wixobj') + '" "' + (Join-Path $obj 'Harvest.wixobj') + '"'
& cmd /c $cmd
if ($LASTEXITCODE -ne 0) { throw "light 失败" }

# 6) 签名（用与应用相同的自签名证书）
Step 6 '签名 MSI'
if ($SkipSign) {
    Write-Host '  跳过签名'
} else {
    $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq 'CN=RapooLite Local Dev, O=RapooLite, C=CN' } |
        Sort-Object NotAfter -Descending | Select-Object -First 1
    if ($cert) {
        $res = Set-AuthenticodeSignature -FilePath $msi -Certificate $cert -HashAlgorithm SHA256
        Write-Host ("  签名状态：" + $res.Status)
    } else {
        Write-Host '  没有找到代码签名证书，跳过（可先运行 host\sign.ps1）'
    }
}

$size = (Get-Item $msi).Length / 1MB
Write-Host ''
Write-Host ("安装包：{0}  ({1:N1} MB)" -f $msi, $size) -ForegroundColor Green
