param(
  [Parameter(Mandatory=$true)][int]$LauncherProcessId,
  [Parameter(Mandatory=$true)][string]$Control,
  [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$testRoot=[IO.Path]::GetFullPath((Join-Path $project '.native/launch-smoke'))+'\'
$outputRoot=[IO.Path]::GetFullPath((Join-Path $project 'output/playwright/window-display'))+'\'
if(!([IO.Path]::GetFullPath($Control)).StartsWith($testRoot,[StringComparison]::OrdinalIgnoreCase) -or !([IO.Path]::GetFullPath($Output)).StartsWith($outputRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Window monitor must stay in isolated test directories.'}
if((Get-Process -Id $LauncherProcessId).Path -ne (Join-Path $project 'src-tauri/target/debug/easy-craft.exe')){throw 'Unexpected launcher.'}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class GameWindowTrace {
 public delegate bool Visitor(IntPtr h,IntPtr state);
 [StructLayout(LayoutKind.Sequential)] public struct Rect{public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] public struct Monitor{public int Size; public Rect Bounds;public Rect Work;public uint Flags;}
 public class Row{public long Hwnd;public string Title;public string Class;public bool Visible;public bool Minimized;public int Width;public int Height;public bool Fullscreen;}
 [DllImport("user32.dll")] static extern bool EnumWindows(Visitor visit,IntPtr state);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder b,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder b,int count);
 [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
 [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr h,ref Monitor m);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 public static Row[] Snapshot(uint pid){
  var rows=new List<Row>();
  EnumWindows((h,s)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid)return true;
   var title=new StringBuilder(512);var type=new StringBuilder(256);GetWindowText(h,title,512);GetClassName(h,type,256);
   if(type.ToString()!="GLFW30")return true;
   Rect r;GetWindowRect(h,out r);var m=new Monitor{Size=Marshal.SizeOf(typeof(Monitor))};GetMonitorInfo(MonitorFromWindow(h,2),ref m);
   rows.Add(new Row{Hwnd=h.ToInt64(),Title=title.ToString(),Class=type.ToString(),Visible=IsWindowVisible(h),Minimized=IsIconic(h),Width=r.Right-r.Left,Height=r.Bottom-r.Top,Fullscreen=r.Left<=m.Bounds.Left&&r.Top<=m.Bounds.Top&&r.Right>=m.Bounds.Right&&r.Bottom>=m.Bounds.Bottom});return true;
  },IntPtr.Zero);return rows.ToArray();
 }
}
'@
[void][GameWindowTrace]::SetThreadDpiAwarenessContext([IntPtr](-4))
[IO.File]::WriteAllText($Control+'.ready','ready')
$deadline=[DateTime]::UtcNow.AddSeconds(120)
while(!(Test-Path -LiteralPath $Control)) {if([DateTime]::UtcNow -gt $deadline){throw 'No test game PID supplied.'};Start-Sleep -Milliseconds 30}
$gameId=[int]([IO.File]::ReadAllText($Control))
$game=Get-CimInstance Win32_Process -Filter "ProcessId = $gameId"
if(!$game -or $game.ParentProcessId -ne $LauncherProcessId -or $game.Name -ne 'java.exe' -or !$game.CommandLine.Contains($testRoot)){throw 'Unexpected test Java process.'}
$clock=[Diagnostics.Stopwatch]::StartNew()
$events=[Collections.Generic.List[object]]::new()
$previous=''
while(!(Test-Path -LiteralPath ($Control+'.stop')) -and $clock.Elapsed.TotalSeconds -lt 100){
 $windows=@([GameWindowTrace]::Snapshot($gameId))
 $key=ConvertTo-Json -InputObject $windows -Compress
 if($key -ne $previous){$events.Add([pscustomobject]@{ms=$clock.ElapsedMilliseconds;windows=$windows});$previous=$key}
 Start-Sleep -Milliseconds 40
}
[IO.File]::WriteAllText($Output,(ConvertTo-Json -InputObject ([pscustomobject]@{pid=$gameId;elapsedMs=$clock.ElapsedMilliseconds;events=$events}) -Depth 7))
