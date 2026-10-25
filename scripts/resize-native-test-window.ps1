param(
    [Parameter(Mandatory=$true)][int]$AppProcessId,
    [Parameter(Mandatory=$true)][ValidateRange(800,1920)][int]$Width,
    [Parameter(Mandatory=$true)][ValidateRange(540,1080)][int]$Height,
    [ValidateSet('debug','release')][string]$BuildProfile = 'debug'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$appProcess = Get-Process -Id $AppProcessId
$expectedPath = [IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri/target/$BuildProfile/easy-craft.exe"))
if ($appProcess.Path -ne $expectedPath) { throw 'Only this workspace launcher may be resized.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LauncherWindowSize {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
}
'@
if ([LauncherWindowSize]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { throw 'Could not establish DPI-aware measurement.' }
$appProcess.Refresh()
$windowHandle = $appProcess.MainWindowHandle
if ($windowHandle -eq [IntPtr]::Zero) { throw 'The workspace launcher has no main window.' }
$ownerProcessId = [uint32]0
[void][LauncherWindowSize]::GetWindowThreadProcessId($windowHandle, [ref]$ownerProcessId)
if ($ownerProcessId -ne $AppProcessId) { throw 'Window ownership changed.' }
$windowRect = New-Object LauncherWindowSize+Rect
$clientRect = New-Object LauncherWindowSize+Rect
if (![LauncherWindowSize]::GetWindowRect($windowHandle,[ref]$windowRect) -or ![LauncherWindowSize]::GetClientRect($windowHandle,[ref]$clientRect)) { throw 'Could not measure workspace window.' }
$windowDpi = [LauncherWindowSize]::GetDpiForWindow($windowHandle)
if ($windowDpi -lt 96 -or $windowDpi -gt 384) { throw 'Unexpected DPI; no resize performed.' }
$targetClientWidth = [int][Math]::Round($Width * $windowDpi / 96)
$targetClientHeight = [int][Math]::Round($Height * $windowDpi / 96)
$targetOuterWidth = $targetClientWidth + ($windowRect.Right - $windowRect.Left - $clientRect.Right)
$targetOuterHeight = $targetClientHeight + ($windowRect.Bottom - $windowRect.Top - $clientRect.Bottom)
if (![LauncherWindowSize]::SetWindowPos($windowHandle, [IntPtr]::Zero, 0, 0, $targetOuterWidth, $targetOuterHeight, 0x0016)) { throw 'Workspace resize failed.' }
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
    Start-Sleep -Milliseconds 50
    if (![LauncherWindowSize]::GetClientRect($windowHandle,[ref]$clientRect)) { throw 'Could not verify resize.' }
} while (($clientRect.Right -ne $targetClientWidth -or $clientRect.Bottom -ne $targetClientHeight) -and [DateTime]::UtcNow -lt $deadline)
if ($clientRect.Right -ne $targetClientWidth -or $clientRect.Bottom -ne $targetClientHeight) { throw 'Workspace window did not reach the requested client size.' }
[pscustomobject]@{ width=$Width; height=$Height; clientWidth=$clientRect.Right; clientHeight=$clientRect.Bottom; dpi=$windowDpi } | ConvertTo-Json -Compress
