$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$dataRoot = Join-Path $projectRoot '.native/mercury-install'
$program = Join-Path $projectRoot 'src-tauri/target/debug/easy-craft.exe'
if (!(Test-Path -LiteralPath (Join-Path $dataRoot 'instances.json'))) { throw '验证库已按用户要求清理。请打开新版 easy-craft.exe，通过“导入整合包”重新安装原 ZIP。' }
$previousRoot = $env:EASYCRAFT_DATA_DIR
try {
    $env:EASYCRAFT_DATA_DIR = $dataRoot
    Start-Process -FilePath $program -WorkingDirectory $projectRoot -WindowStyle Normal
} finally {
    $env:EASYCRAFT_DATA_DIR = $previousRoot
}
