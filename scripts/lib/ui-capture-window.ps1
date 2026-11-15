param(
  [ValidateSet('prepare','restore','list')][string]$Action='prepare',
  [int]$Left=0,[int]$Top=0,[int]$Width=1750,[int]$Height=1100,
  [string]$Title='wx-match',
  [string]$Matches=''
)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class UiCapWin {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  public const int SW_RESTORE = 9;
  public static List<IntPtr> Handles = new List<IntPtr>();
  public static List<string> Info = new List<string>();
  public static void Find(string exact, string pattern) {
    Handles.Clear(); Info.Clear();
    EnumWindows((h, p) => {
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      var name = t.ToString();
      bool hit = (!String.IsNullOrEmpty(exact) && name == exact)
        || (!String.IsNullOrEmpty(pattern) && System.Text.RegularExpressions.Regex.IsMatch(name, pattern));
      if (!hit) return true;
      Rect r; GetWindowRect(h, out r);
      int pid; GetWindowThreadProcessId(h, out pid);
      Handles.Add(h);
      Info.Add("pid=" + pid + " state=" + (IsIconic(h) ? "min" : (IsWindowVisible(h) ? "vis" : "hid"))
        + " rect=" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + " title=" + name);
      return true;
    }, IntPtr.Zero);
  }
}
'@
# Resize only this project's DevTools window; do not activate it or change the selected device.
# A minimised window (rect -32000,-32000) keeps the simulator at its tiny default size, so restore
# it first and only then apply the new geometry. Otherwise screenshots come out around 149x321.
[UiCapWin]::Find($Title, $Matches)
$info = [UiCapWin]::Info
$handles = [UiCapWin]::Handles
if ($Action -eq 'list') { foreach ($row in $info) { Write-Output $row }; exit 0 }
if ($handles.Count -eq 0) {
  $what = if ($Matches -ne '') { "matching pattern $Matches" } else { "titled $Title" }
  throw "Cannot find the DevTools window $what"
}
# Prefer a visible, non-minimised window when several match.
$index = 0
for ($i = 0; $i -lt $info.Count; $i++) { if ($info[$i] -match 'state=vis') { $index = $i; break } }
$handle = $handles[$index]
$before = $info[$index]
if ($before -match 'state=min') {
  [void][UiCapWin]::ShowWindow($handle, [UiCapWin]::SW_RESTORE)
  Start-Sleep -Milliseconds 900
}
if ($Action -eq 'prepare') {
  $bounds = New-Object UiCapWin+Rect
  [void][UiCapWin]::GetWindowRect($handle, [ref]$bounds)
  @{left=$bounds.Left;top=$bounds.Top;width=($bounds.Right-$bounds.Left);height=($bounds.Bottom-$bounds.Top)} | ConvertTo-Json -Compress
}
if (![UiCapWin]::MoveWindow($handle,$Left,$Top,$Width,$Height,$true)) { throw 'Cannot resize the capture window' }
