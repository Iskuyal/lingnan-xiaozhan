param(
  [ValidateSet('prepare','restore')][string]$Action='prepare',
  [int]$Left=0,[int]$Top=0,[int]$Width=1750,[int]$Height=1100
)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class UiCaptureWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle,out Rect rect);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr handle,int x,int y,int width,int height,bool repaint);
}
'@
# Resize only this project's background window; do not activate it or change the selected device.
$taskWindow=Get-Process | Where-Object { $_.MainWindowTitle -eq 'wx-match' } | Select-Object -First 1
if (!$taskWindow) { throw 'Cannot find the wx-match DevTools window' }
$taskBounds=New-Object UiCaptureWindow+Rect
[void][UiCaptureWindow]::GetWindowRect($taskWindow.MainWindowHandle,[ref]$taskBounds)
if ($Action -eq 'prepare') {
  @{left=$taskBounds.Left;top=$taskBounds.Top;width=($taskBounds.Right-$taskBounds.Left);height=($taskBounds.Bottom-$taskBounds.Top)} | ConvertTo-Json -Compress
}
if (![UiCaptureWindow]::MoveWindow($taskWindow.MainWindowHandle,$Left,$Top,$Width,$Height,$true)) { throw 'Cannot resize the capture window' }
