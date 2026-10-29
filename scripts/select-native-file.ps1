param(
  [Parameter(Mandatory=$true)][int]$AppProcessId,
  [string]$File,
  [switch]$Directory,
  [switch]$ReadOnlyMinecraftRoot,
  [switch]$Cancel
)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$process = Get-Process -Id $AppProcessId
$expected = [IO.Path]::GetFullPath((Join-Path $project 'src-tauri/target/debug/easy-craft.exe'))
if ($process.Path -ne $expected) { throw 'Only this workspace debug launcher may be automated.' }
if (!$Cancel) {
  $fixtureRoot = [IO.Path]::GetFullPath((Join-Path $project '.native/fixtures')) + [IO.Path]::DirectorySeparatorChar
  $selected = [IO.Path]::GetFullPath($File)
  $selectedType = if ($Directory) { 'Container' } else { 'Leaf' }
  $knownMinecraft = [IO.Path]::GetFullPath((Join-Path $env:APPDATA '.minecraft'))
  $knownVersions = Join-Path $knownMinecraft 'versions'
  $userScan = $ReadOnlyMinecraftRoot -and $Directory -and ($selected.Equals($knownMinecraft, [StringComparison]::OrdinalIgnoreCase) -or $selected.Equals($knownVersions, [StringComparison]::OrdinalIgnoreCase) -or ([IO.Path]::GetDirectoryName($selected)).Equals($knownVersions, [StringComparison]::OrdinalIgnoreCase))
  if ((!$selected.StartsWith($fixtureRoot, [StringComparison]::OrdinalIgnoreCase) -and !$userScan) -or !(Test-Path -LiteralPath $selected -PathType $selectedType)) {
    throw 'Only existing workspace fixtures or the explicitly requested read-only Minecraft root may be selected.'
  }
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FileDialogControls {
  public delegate bool Visit(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr root, Visit visit, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, string text, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  public static IntPtr Edit(IntPtr parent) {
    IntPtr result = IntPtr.Zero;
    EnumChildWindows(parent, (window, data) => {
      var name = new StringBuilder(64);
      GetClassName(window, name, name.Capacity);
      if (name.ToString() != "Edit") return true;
      result = window;
      return false;
    }, IntPtr.Zero);
    return result;
  }
}
'@
$automation = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$condition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($automation::ProcessIdProperty, $AppProcessId)),
  (New-Object System.Windows.Automation.PropertyCondition($automation::ClassNameProperty, '#32770'))
)
$dialog = $null
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while (!$dialog -and [DateTime]::UtcNow -lt $deadline) {
  $dialog = $automation::RootElement.FindFirst($scope::Descendants, $condition)
  if (!$dialog) { Start-Sleep -Milliseconds 100 }
}
if (!$dialog) { throw 'The workspace launcher file dialog did not appear.' }
$buttonId = if ($Cancel) { '2' } else { '1' }
if (!$Cancel) {
  $nameControl = $dialog.FindFirst($scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($automation::AutomationIdProperty, '1148')))
  if (!$nameControl -and $Directory) {
    $nameControl = $dialog.FindFirst($scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($automation::AutomationIdProperty, '1152')))
  }
  if (!$nameControl) {
    $edits = $dialog.FindAll($scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($automation::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
    $ids = @($edits | ForEach-Object { "$($_.Current.AutomationId):$($_.Current.ClassName)" }) -join ', '
    throw "File name control was not found. Edit control ids: $ids"
  }
  $edit = [FileDialogControls]::Edit([IntPtr]$nameControl.Current.NativeWindowHandle)
  if ($edit -eq [IntPtr]::Zero -and $nameControl.Current.ClassName -eq 'Edit') { $edit = [IntPtr]$nameControl.Current.NativeWindowHandle }
  if ($edit -eq [IntPtr]::Zero) { throw 'Native filename edit was not found.' }
  $result = [IntPtr]::Zero
  if ([FileDialogControls]::SendMessageTimeout($edit, 12, [IntPtr]::Zero, $selected, 2, 5000, [ref]$result) -eq [IntPtr]::Zero) {
    throw 'Could not fill the fixture filename.'
  }
}
$buttonCondition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($automation::AutomationIdProperty, $buttonId)),
  (New-Object System.Windows.Automation.PropertyCondition($automation::ClassNameProperty, 'Button'))
)
$button = $null
while (!$button -and [DateTime]::UtcNow -lt $deadline) {
  $button = $dialog.FindFirst($scope::Descendants, $buttonCondition)
  if (!$button) { Start-Sleep -Milliseconds 100 }
}
if (!$button) {
  $controls = $dialog.FindAll($scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $ids = @($controls | Select-Object -First 70 | ForEach-Object { "$($_.Current.AutomationId):$($_.Current.ClassName):$($_.Current.ControlType.ProgrammaticName)" }) -join ', '
  throw "Dialog action was not found. Control ids: $ids"
}
$dialogHandle = [IntPtr]$dialog.Current.NativeWindowHandle
if ($Directory -and !$Cancel) {
  [void][FileDialogControls]::PostMessage([IntPtr]$button.Current.NativeWindowHandle, 245, [IntPtr]::Zero, [IntPtr]::Zero)
} elseif (![FileDialogControls]::PostMessage($dialogHandle, 273, [IntPtr][int]$buttonId, [IntPtr]$button.Current.NativeWindowHandle)) {
  throw 'Could not press the workspace dialog action.'
}
if ($Directory -and !$Cancel) {
  Start-Sleep -Milliseconds 750
  if ([FileDialogControls]::IsWindow($dialogHandle)) {
    [void][FileDialogControls]::PostMessage([IntPtr]$button.Current.NativeWindowHandle, 245, [IntPtr]::Zero, [IntPtr]::Zero)
  }
}
$closedDeadline = [DateTime]::UtcNow.AddSeconds(10)
while ([FileDialogControls]::IsWindow($dialogHandle) -and [DateTime]::UtcNow -lt $closedDeadline) { Start-Sleep -Milliseconds 100 }
if ([FileDialogControls]::IsWindow($dialogHandle)) { throw 'The workspace file dialog did not finish its action.' }
Write-Output 'PASS: workspace-owned system file dialog action completed.'
