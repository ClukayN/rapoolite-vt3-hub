# 给 RapooLite.exe 做代码签名，消除“无法验证发布者”的安全警告。
# 做法：生成一张自签名代码签名证书 → 装进当前用户的「受信任的根证书颁发机构」和「受信任的发布者」
#       → 用它给 exe 签名。只影响本机当前用户，不修改任何系统级安全策略。
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string]$Subject = 'CN=RapooLite Local Dev, O=RapooLite, C=CN'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Exe)) { throw "找不到要签名的文件：$Exe" }

# 1) 找现成的证书，没有就创建
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Subject -eq $Subject -and $_.NotAfter -gt (Get-Date).AddDays(30) } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

if (-not $cert) {
    Write-Host '  · 生成自签名代码签名证书'
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $Subject `
        -CertStoreLocation Cert:\CurrentUser\My `
        -KeyUsage DigitalSignature `
        -KeyExportPolicy Exportable `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -NotAfter (Get-Date).AddYears(10)
}

# 2) 把证书装进当前用户的根存储与受信任发布者存储（幂等）
$cerPath = Join-Path $env:LOCALAPPDATA 'RapooLite-signing.cer'
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null

foreach ($store in @('Root', 'TrustedPublisher')) {
    $exists = Get-ChildItem "Cert:\CurrentUser\$store" |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint } |
        Select-Object -First 1
    if (-not $exists) {
        Write-Host "  · 安装证书到当前用户 $store"
        Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\$store" | Out-Null
    }
}

# 3) 签名
$sig = Set-AuthenticodeSignature -FilePath $Exe -Certificate $cert -HashAlgorithm SHA256
if ($sig.Status -ne 'Valid') {
    throw "签名失败：$($sig.Status) $($sig.StatusMessage)"
}

$check = Get-AuthenticodeSignature -FilePath $Exe
Write-Host ("  签名状态   : {0}" -f $check.Status)
Write-Host ("  签名主体   : {0}" -f $cert.Subject)
Write-Host ("  证书指纹   : {0}" -f $cert.Thumbprint)
