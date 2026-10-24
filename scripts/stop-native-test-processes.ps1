param(
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$GameProcessId,
    [Parameter(Mandatory=$true)][string]$GameDirectory
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$instancesRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.native/integration/instances')) + [IO.Path]::DirectorySeparatorChar
$gameRoot = [IO.Path]::GetFullPath($GameDirectory)
$integrationRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.native/integration')) + [IO.Path]::DirectorySeparatorChar
if (!$gameRoot.StartsWith($instancesRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $gameRoot -Leaf) -ne 'game') { throw 'Only this workspace integration game may be stopped.' }
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path $projectRoot -Parent) 'build-tools/easycraft')) + [IO.Path]::DirectorySeparatorChar
$stopped = @{}
for ($attempt = 0; $attempt -lt 5; $attempt++) {
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '^java(w)?\.exe$' -and $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($runtimeRoot, [StringComparison]::OrdinalIgnoreCase) -and
        $_.CommandLine.IndexOf($integrationRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } | ForEach-Object {
        $main = $_.ProcessId -eq $GameProcessId -and $_.CommandLine -like '*EC_OfflineTest*' -and $_.CommandLine.IndexOf($gameRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $assistant = $_.CommandLine -match 'crash.?assistant' -and $_.CommandLine -match ("[/\\]" + $GameProcessId + '_[^\s";]*\.jar')
        if (($main -or $assistant) -and !$stopped.ContainsKey($_.ProcessId)) {
            $stopped[$_.ProcessId] = $true
            Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            Write-Output "Stopped workspace test process $($_.ProcessId)."
        }
    }
    Start-Sleep -Milliseconds 200
}
foreach ($processId in $stopped.Keys) {
    if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { throw "Workspace test process $processId did not exit." }
}
