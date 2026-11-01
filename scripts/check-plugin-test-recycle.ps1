param([Parameter(Mandatory=$true)][string]$ManagedPackage)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$taskBoundary = [IO.Path]::GetFullPath((Join-Path $projectRoot '.native/plugins-ui')) + [IO.Path]::DirectorySeparatorChar
$taskPackage = [IO.Path]::GetFullPath($ManagedPackage)
if (-not $taskPackage.StartsWith($taskBoundary, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($taskPackage) -ne '.json') { throw 'Only isolated plugin-test packages may be inspected.' }
$taskName = [IO.Path]::GetFileName($taskPackage)
$taskStem = [IO.Path]::GetFileNameWithoutExtension($taskPackage)
$taskParent = [IO.Path]::GetDirectoryName($taskPackage)
$taskShell = New-Object -ComObject Shell.Application
$taskBin = $taskShell.Namespace(10)
$taskFound = $false
foreach ($taskItem in $taskBin.Items()) {
    if (($taskItem.Name -eq $taskName -or $taskItem.Name -eq $taskStem) -and $taskItem.ExtendedProperty('System.Recycle.DeletedFrom') -eq $taskParent) { $taskFound = $true; break }
}
Write-Output $taskFound.ToString().ToLowerInvariant()
