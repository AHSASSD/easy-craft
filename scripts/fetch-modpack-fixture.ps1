$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$directory = Join-Path $projectRoot '.native/fixtures'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$target = Join-Path $directory 'adrenaline-1.21.1.mrpack'
$expected = '4f91d6537e6341beccf03d39e9127584faa99ef702f93ee71fa3d5e9c0f3a6fd4429303e46943e84ee719d9b8785716a82a455cb4feb6d3a2209e7614ac33ba7'
if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target -Algorithm SHA512).Hash -ieq $expected) {
    Write-Output 'PASS: pinned Adrenaline 26.5.1+mc1.21.1.fabric fixture is already verified.'
    return
}
$version = Invoke-RestMethod -Uri 'https://api.modrinth.com/v2/version/5SA4P3Eo' -TimeoutSec 45
if ($version.project_id -ne 'BYN9yKrV' -or $version.id -ne '5SA4P3Eo') { throw 'Pack version ownership mismatch.' }
$file = $version.files | Where-Object primary | Select-Object -First 1
$uri = [Uri]$file.url
if ($file.hashes.sha512 -ine $expected -or $file.size -ne 7198 -or $uri.Scheme -ne 'https' -or $uri.DnsSafeHost -ne 'cdn.modrinth.com' -or $uri.UserInfo -or $uri.Port -ne 443) { throw 'Pinned fixture metadata changed or source is invalid.' }
$partial = Join-Path $directory ('adrenaline-' + [guid]::NewGuid().ToString() + '.part')
try {
    Invoke-WebRequest -Uri $uri.AbsoluteUri -MaximumRedirection 0 -OutFile $partial -TimeoutSec 90
    if ((Get-Item -LiteralPath $partial).Length -ne $file.size -or (Get-FileHash -LiteralPath $partial -Algorithm SHA1).Hash -ine $file.hashes.sha1 -or (Get-FileHash -LiteralPath $partial -Algorithm SHA512).Hash -ine $expected) { throw 'Pack archive verification failed.' }
    Move-Item -LiteralPath $partial -Destination $target -Force
    Write-Output 'PASS: public MRPACK fixture downloaded and verified under .native/fixtures.'
} finally {
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
}
