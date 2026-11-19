# 生成 RapooLite 图标（抽象的鼠标轮廓）：host\app.ico + docs\icon.png
# 用法：powershell -ExecutionPolicy Bypass -File host\make-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$icoPath = Join-Path $PSScriptRoot 'app.ico'
$previewPath = Join-Path $root 'docs\icon.png'

function New-MouseBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = [float]($size / 32.0)

    # 机身（胶囊），品牌渐变填充
    $bx = 9.0 * $s
    $by = 3.0 * $s
    $bw = 14.0 * $s
    $bh = 26.0 * $s
    $r = 7.0 * $s
    $d = $r * 2
    $bodyPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bodyPath.AddArc($bx, $by, $d, $d, 180, 90)
    $bodyPath.AddArc($bx + $bw - $d, $by, $d, $d, 270, 90)
    $bodyPath.AddArc($bx + $bw - $d, $by + $bh - $d, $d, $d, 0, 90)
    $bodyPath.AddArc($bx, $by + $bh - $d, $d, $d, 90, 90)
    $bodyPath.CloseFigure()
    $p1 = New-Object System.Drawing.PointF ($bx + $bw / 2), $by
    $p2 = New-Object System.Drawing.PointF ($bx + $bw / 2), ($by + $bh)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $p1, $p2, ([System.Drawing.Color]::FromArgb(255, 150, 132, 255)), ([System.Drawing.Color]::FromArgb(255, 92, 140, 255))
    $g.FillPath($brush, $bodyPath)
    $brush.Dispose()
    $bodyPath.Dispose()

    # 按键分割线
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 12, 14, 22)), ([float](1.5 * $s))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($pen, [float](16.0 * $s), [float](3.8 * $s), [float](16.0 * $s), [float](11.6 * $s))
    $pen.Dispose()

    # 滚轮
    $wx = 13.6 * $s
    $wy = 6.2 * $s
    $ww = 4.8 * $s
    $wh = 5.6 * $s
    $wr = 2.4 * $s
    $wd = $wr * 2
    $wheelPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $wheelPath.AddArc($wx, $wy, $wd, $wd, 180, 90)
    $wheelPath.AddArc($wx + $ww - $wd, $wy, $wd, $wd, 270, 90)
    $wheelPath.AddArc($wx + $ww - $wd, $wy + $wh - $wd, $wd, $wd, 0, 90)
    $wheelPath.AddArc($wx, $wy + $wh - $wd, $wd, $wd, 90, 90)
    $wheelPath.CloseFigure()
    $wbrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 10, 12, 20))
    $g.FillPath($wbrush, $wheelPath)
    $wheelPath.Dispose()
    $wbrush.Dispose()

    $g.Dispose()
    return $bmp
}

# 1) 预览图：深色底 + 浅色底
$preview = New-Object System.Drawing.Bitmap 680, 320
$pg = [System.Drawing.Graphics]::FromImage($preview)
$pg.Clear([System.Drawing.Color]::FromArgb(24, 26, 32))
$lightBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 246, 250))
$pg.FillRectangle($lightBrush, 360, 0, 320, 320)
$lightBrush.Dispose()
$pg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$big = New-MouseBitmap 256
$pg.DrawImage($big, 24, 24, 256, 256)
$pg.DrawImage($big, 320, 24, 32, 32)
$pg.DrawImage($big, 300, 24, 16, 16)
$pg.DrawImage($big, 372, 24, 256, 256)
$pg.Dispose()
$big.Dispose()
$dir = Split-Path -Parent $previewPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$preview.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Dispose()

# 2) 组装 .ico（16/24/32/48/256，PNG 压缩条目）
$sizes = @(16, 24, 32, 48, 256)
$pngs = @()
foreach ($sz in $sizes) {
    $bmp = New-MouseBitmap $sz
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += , $ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()
}

$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]
    $data = $pngs[$i]
    $dim = if ($sz -ge 256) { 0 } else { $sz }
    $bw.Write([byte]$dim)
    $bw.Write([byte]$dim)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$data.Length)
    $bw.Write([UInt32]$offset)
    $offset += $data.Length
}
foreach ($data in $pngs) { $bw.Write($data) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
$bw.Dispose()
$out.Dispose()

"icon written: $icoPath ($((Get-Item $icoPath).Length) bytes)"
"preview: $previewPath"
