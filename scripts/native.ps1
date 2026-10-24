param(
    [ValidateSet('check', 'test', 'build', 'dev', 'bundle', 'fmt', 'clippy')][string]$Action = 'dev',
    [ValidateSet('none', 'metadata', 'install', 'offline', 'fabric', 'resources', 'pack')][string]$Integration = 'none'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$toolRoot = Join-Path (Split-Path $projectRoot -Parent) 'build-tools/easycraft'
$vcRoot = Join-Path $toolRoot 'msvc/VC/Tools/MSVC/14.44.35207'
$sdkRoot = Join-Path $toolRoot 'microsoft.windows.sdk.cpp/c'
$sdkLib = Join-Path $toolRoot 'microsoft.windows.sdk.cpp.x64/c'
$sdkVersion = '10.0.28000.0'
$compiler = Join-Path $vcRoot 'bin/Hostx64/x64'
$env:RUSTUP_HOME = Join-Path $toolRoot 'rustup'
$env:CARGO_HOME = Join-Path $toolRoot 'cargo'
$cargo = Join-Path $env:CARGO_HOME 'bin/cargo.exe'
foreach ($required in @($cargo, (Join-Path $compiler 'link.exe'), (Join-Path $sdkRoot "bin/$sdkVersion/x64/rc.exe"), (Join-Path $sdkLib 'um/x64/kernel32.lib'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing native tool: $required" }
}
$env:PATH = "$env:CARGO_HOME\bin;$compiler;$sdkRoot\bin\$sdkVersion\x64;$env:PATH"
$env:LIB = "$vcRoot\lib\x64;$vcRoot\lib\onecore\x64;$sdkLib\um\x64;$sdkLib\ucrt\x64"
$env:INCLUDE = "$vcRoot\include;$sdkRoot\Include\$sdkVersion\ucrt;$sdkRoot\Include\$sdkVersion\shared;$sdkRoot\Include\$sdkVersion\um;$sdkRoot\Include\$sdkVersion\winrt"
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = Join-Path $compiler 'link.exe'
$env:CC = Join-Path $compiler 'cl.exe'
$env:AR = Join-Path $compiler 'lib.exe'
$env:VCToolsInstallDir = "$vcRoot\"
$env:WindowsSdkDir = "$sdkRoot\"
$env:WindowsSDKVersion = "$sdkVersion\"
$env:CARGO_HTTP_MULTIPLEXING = 'false'
$env:CARGO_BUILD_JOBS = '4'
$env:TEMP = (New-Item -ItemType Directory -Path (Join-Path $toolRoot 'tmp') -Force).FullName
$env:TMP = $env:TEMP
$env:EASYCRAFT_DATA_DIR = Join-Path $projectRoot 'data'
$javaRoot = Join-Path $toolRoot 'java21'
if (Test-Path -LiteralPath $javaRoot) {
    $runtime = Get-ChildItem -LiteralPath $javaRoot -Directory | Select-Object -First 1
    if ($runtime) { $env:EASYCRAFT_JAVA = Join-Path $runtime.FullName 'bin/java.exe' }
}
Push-Location $projectRoot
try {
    switch ($Action) {
        'check' { & $cargo check --manifest-path src-tauri/Cargo.toml --locked }
        'test' {
            if ($Integration -eq 'none') { & $cargo test --manifest-path src-tauri/Cargo.toml --locked }
            else {
                $filter = switch ($Integration) { 'metadata' { 'official_metadata_and_java_integration' } 'install' { 'official_install_integration' } 'offline' { 'cached_offline_preparation_integration' } 'fabric' { 'official_fabric_install_integration' } 'resources' { 'modrinth_metadata_integration' } 'pack' { 'public_pack_stage_and_rollback_integration' } }
                & $cargo test --manifest-path src-tauri/Cargo.toml --locked $filter -- --ignored --nocapture
            }
        }
        'fmt' { & $cargo fmt --manifest-path src-tauri/Cargo.toml -- --check }
        'clippy' { & $cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings }
        'build' { & npm run tauri -- build --debug --no-bundle }
        'bundle' { & npm run tauri -- build }
        'dev' {
            $override = Join-Path $projectRoot '.native/dev.json'
            New-Item -ItemType Directory -Path (Split-Path $override -Parent) -Force | Out-Null
            $running = $false
            try { $running = (Invoke-WebRequest -Uri 'http://127.0.0.1:1420/' -TimeoutSec 2).StatusCode -eq 200 } catch { }
            @{ build = @{ beforeDevCommand = $(if ($running) { '' } else { 'npm run dev' }) } } | ConvertTo-Json | Set-Content -LiteralPath $override
            & npm run tauri -- dev --config $override
        }
    }
    if ($LASTEXITCODE -ne 0) { throw "Native $Action failed ($LASTEXITCODE)" }
} finally { Pop-Location }
