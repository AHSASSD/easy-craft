param(
    [Parameter(Mandatory=$true)][int]$GameProcessId,
    [Parameter(Mandatory=$true)][int]$LauncherProcessId,
    [Parameter(Mandatory=$true)][string]$JavaPath,
    [Parameter(Mandatory=$true)][string]$Sandbox,
    [Parameter(Mandatory=$true)][string]$Screenshot,
    [string]$GameDirectory
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$sandboxRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.native/launch-smoke')) + '\'
$resolvedSandbox = [IO.Path]::GetFullPath($Sandbox)
if (!$resolvedSandbox.StartsWith($sandboxRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Only an isolated workspace game may be captured.' }
$outputRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'output/playwright/launch-smoke')) + '\'
$capturePath = [IO.Path]::GetFullPath($Screenshot)
if (!$capturePath.StartsWith($outputRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Capture must stay in test output.' }
$launcher = Get-Process -Id $LauncherProcessId
if ($launcher.Path -ne (Join-Path $projectRoot 'src-tauri/target/debug/easy-craft.exe')) { throw 'Unexpected parent launcher.' }
$game = Get-CimInstance Win32_Process -Filter "ProcessId = $GameProcessId"
if (!$game -or $game.ParentProcessId -ne $LauncherProcessId -or $game.ExecutablePath -ne $JavaPath -or !$game.CommandLine.Contains($resolvedSandbox)) { throw 'Game ownership or sandbox command line did not match.' }
$gameProcess = Get-Process -Id $GameProcessId
$window = $gameProcess.MainWindowHandle
if ($window -eq [IntPtr]::Zero) { throw 'Game does not have a window yet.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TestGameWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,uint message,IntPtr key,IntPtr data);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint key,uint type);
}
'@
[void][TestGameWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
if($GameDirectory){
    $gameDirectoryPath=[IO.Path]::GetFullPath($GameDirectory)
    if(!$gameDirectoryPath.StartsWith($resolvedSandbox+'\',[StringComparison]::OrdinalIgnoreCase) -or !$game.CommandLine.Contains($gameDirectoryPath)){throw 'Unexpected game screenshot directory.'}
    $screenshots=Join-Path $gameDirectoryPath 'screenshots'
    $before=@(Get-ChildItem -LiteralPath $screenshots -File -Filter '*.png' -ErrorAction SilentlyContinue | ForEach-Object {$_.FullName})
    $scan=[long][TestGameWindow]::MapVirtualKey(0x71,0) -shl 16
    [void][TestGameWindow]::PostMessage($window,0x100,[IntPtr]0x71,[IntPtr]($scan -bor 1))
    Start-Sleep -Milliseconds 80
    [void][TestGameWindow]::PostMessage($window,0x101,[IntPtr]0x71,[IntPtr]($scan -bor 0xC0000001L))
    $engineShot=$null
    for($attempt=0;$attempt -lt 40;$attempt++){
        Start-Sleep -Milliseconds 100
        $engineShot=Get-ChildItem -LiteralPath $screenshots -File -Filter '*.png' -ErrorAction SilentlyContinue | Where-Object {$_.FullName -notin $before -and $_.Length -gt 100 -and !($_.Attributes -band [IO.FileAttributes]::ReparsePoint)} | Select-Object -First 1
        if($engineShot){break}
    }
    if($engineShot){
        Start-Sleep -Milliseconds 300
        Copy-Item -LiteralPath $engineShot.FullName -Destination $capturePath
        [pscustomobject]@{pid=$GameProcessId;title=$gameProcess.MainWindowTitle;screenshot=$capturePath;capture='minecraft-f2'} | ConvertTo-Json -Compress
        exit 0
    }
    throw 'Minecraft did not write its requested engine screenshot; no visual success claimed.'
}
[void][TestGameWindow]::SetForegroundWindow($window)
Start-Sleep -Milliseconds 1500
[uint32]$owner = 0
[void][TestGameWindow]::GetWindowThreadProcessId([TestGameWindow]::GetForegroundWindow(), [ref]$owner)
if ($owner -ne $GameProcessId) { throw 'Owned test game is not foreground; no screen pixels captured.' }
$rect = New-Object TestGameWindow+Rect
if (![TestGameWindow]::GetClientRect($window,[ref]$rect)) { throw 'Could not measure game client.' }
$origin = New-Object TestGameWindow+Point
if (![TestGameWindow]::ClientToScreen($window,[ref]$origin)) { throw 'Could not locate game client.' }
function Assert-OwnedClient {
    if ([TestGameWindow]::GetForegroundWindow() -ne $window) { throw 'Owned test game is not foreground; no screen pixels captured.' }
    foreach ($offset in @(@(2,2),@(($rect.Right-3),2),@(2,($rect.Bottom-3)),@(($rect.Right-3),($rect.Bottom-3)),@([int]($rect.Right/2),[int]($rect.Bottom/2)))) {
        $point = New-Object TestGameWindow+Point
        $point.X = $origin.X + $offset[0]; $point.Y = $origin.Y + $offset[1]
        [uint32]$pointOwner = 0
        [void][TestGameWindow]::GetWindowThreadProcessId([TestGameWindow]::WindowFromPoint($point), [ref]$pointOwner)
        if ($pointOwner -ne $GameProcessId) { throw 'Owned test game is not foreground; no screen pixels captured.' }
    }
}
Assert-OwnedClient
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
$graphics = [Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen($origin.X,$origin.Y,0,0,$bitmap.Size)
    Assert-OwnedClient
    [void][TestGameWindow]::GetWindowThreadProcessId([TestGameWindow]::GetForegroundWindow(), [ref]$owner)
    if ($owner -ne $GameProcessId) { throw 'Owned test game is not foreground; no screen pixels captured.' }
    $bitmap.Save($capturePath,[Drawing.Imaging.ImageFormat]::Png)
} finally { $graphics.Dispose(); $bitmap.Dispose() }
[pscustomobject]@{pid=$GameProcessId; title=$gameProcess.MainWindowTitle; screenshot=$capturePath} | ConvertTo-Json -Compress
