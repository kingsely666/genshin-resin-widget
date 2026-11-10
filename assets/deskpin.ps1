# Pin / unpin a top-level window to the Windows desktop layer.
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI when there is no BOM.
param(
  [string]$Hwnd = '0',
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Out = '',
  [int]$X = -1,
  [int]$Y = -1,
  [int]$Owner = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace DeskPin -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowTitle);
[DllImport("user32.dll", SetLastError = true)]
public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
[DllImport("user32.dll", SetLastError = true)]
public static extern IntPtr GetParent(IntPtr hWnd);
[DllImport("user32.dll", SetLastError = true)]
public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr hWnd);
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")]
public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll", SetLastError = true, EntryPoint = "SetWindowLongPtrW")]
public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
[DllImport("user32.dll", SetLastError = true, EntryPoint = "GetWindowLongPtrW")]
public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
[DllImport("user32.dll", SetLastError = true)]
public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
[DllImport("user32.dll", CharSet = CharSet.Auto)]
public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[DllImport("user32.dll", CharSet = CharSet.Auto)]
public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll", SetLastError = true)]
public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
[DllImport("user32.dll")]
public static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")]
public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")]
public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")]
public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
'@

$SWP_NOSIZE       = 0x0001
$SWP_NOMOVE       = 0x0002
$SWP_NOACTIVATE   = 0x0010
$SWP_FRAMECHANGED = 0x0020
$HWND_TOP         = [IntPtr]0
$HWND_NOTOPMOST   = [IntPtr](-2)
$GA_PARENT        = 1
$GWL_STYLE        = -16
$WS_CHILD         = 0x40000000
$WS_POPUP         = 0x80000000

$target = [IntPtr][int64]$Hwnd
if ($Action -ne 'dump' -and $Action -ne 'shot' -and $Action -ne 'toggledesktop' -and $Action -ne 'find' -and $Action -ne 'findpid' -and $Action -ne 'children' -and $target -eq [IntPtr]::Zero) {
  Write-Output 'ERR invalid-hwnd'
  exit 1
}

function Get-DesktopParent {
  $progman = [DeskPin.Native]::FindWindow('Progman', [NullString]::Value)
  if ($progman -ne [IntPtr]::Zero) {
    return $progman
  }
  $child = [IntPtr]::Zero
  while ($true) {
    $child = [DeskPin.Native]::FindWindowEx([IntPtr]::Zero, $child, 'WorkerW', [NullString]::Value)
    if ($child -eq [IntPtr]::Zero) { break }
    $def = [DeskPin.Native]::FindWindowEx($child, [IntPtr]::Zero, 'SHELLDLL_DefView', [NullString]::Value)
    if ($def -ne [IntPtr]::Zero) { return $child }
  }
  return [IntPtr]::Zero
}

function Show-DesktopToggle {
  $shell = New-Object -ComObject Shell.Application
  $shell.ToggleDesktop()
}

function Save-ScreenShot([string]$path) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

if ($Action -eq 'shot') {
  if (-not $Out) { Write-Output 'ERR no-output'; exit 4 }
  Save-ScreenShot $Out
  Write-Output ('OK shot ' + $Out)
  exit 0
}

if ($Action -eq 'toggledesktop') {
  Show-DesktopToggle
  Write-Output 'OK toggledesktop'
  exit 0
}

if ($Action -eq 'dump') {
  $script:rows = New-Object System.Collections.ArrayList
  $cb = [DeskPin.Native+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [DeskPin.Native]::GetClassName($h, $sb, 256) | Out-Null
    $ts = New-Object System.Text.StringBuilder 256
    [DeskPin.Native]::GetWindowText($h, $ts, 256) | Out-Null
    $procId = 0
    [DeskPin.Native]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    [void]$script:rows.Add(("0x{0:X} {1} visible={2} pid={3} title={4}" -f [int64]$h, $sb.ToString(), [DeskPin.Native]::IsWindowVisible($h), $procId, $ts.ToString()))
    return $true
  }
  [DeskPin.Native]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  Write-Output ('OK dump count=' + $script:rows.Count)
  $script:rows | ForEach-Object { Write-Output $_ }
  exit 0
}

if ($Action -eq 'hit') {
  $rect = New-Object DeskPin.Native+RECT
  [DeskPin.Native]::GetWindowRect($target, [ref]$rect) | Out-Null
  $pt = New-Object DeskPin.Native+POINT
  $pt.X = [int](($rect.Left + $rect.Right) / 2)
  $pt.Y = [int](($rect.Top + $rect.Bottom) / 2)
  $hit = [DeskPin.Native]::WindowFromPoint($pt)
  Write-Output ('OK hit=' + $hit.ToInt64() + ' target=' + $target.ToInt64() + ' at=' + $pt.X + ',' + $pt.Y)
  exit 0
}

if ($Action -eq 'click') {
  $old = New-Object DeskPin.Native+POINT
  [DeskPin.Native]::GetCursorPos([ref]$old) | Out-Null
  [DeskPin.Native]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 120
  [DeskPin.Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [DeskPin.Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  [DeskPin.Native]::SetCursorPos($old.X, $old.Y) | Out-Null
  Write-Output ('OK click at=' + $X + ',' + $Y)
  exit 0
}

if ($Action -eq 'query') {
  $parent = [DeskPin.Native]::GetAncestor($target, $GA_PARENT)
  $owner = [DeskPin.Native]::GetWindow($target, 4)
  $style = [DeskPin.Native]::GetWindowLongPtr($target, $GWL_STYLE)
  $visible = [DeskPin.Native]::IsWindowVisible($target)
  $rect = New-Object DeskPin.Native+RECT
  [DeskPin.Native]::GetWindowRect($target, [ref]$rect) | Out-Null
  $child = ([int64]$style -band $WS_CHILD) -ne 0
  $ex = [DeskPin.Native]::GetWindowLongPtr($target, -20)
  $topmost = ([int64]$ex -band 0x8) -ne 0
  $parentVal = 0
  if ($null -ne $parent) { $parentVal = [int64]$parent }
  $ownerVal = 0
  if ($null -ne $owner) { $ownerVal = [int64]$owner }
  Write-Output ('OK query parent=' + $parentVal + ' owner=' + $ownerVal + ' child=' + $child + ' topmost=' + $topmost + ' visible=' + $visible + ' rect=' + $rect.Left + ',' + $rect.Top + ',' + $rect.Right + ',' + $rect.Bottom)
  exit 0
}

if ($Action -eq 'move') {
  [DeskPin.Native]::SetWindowPos($target, $HWND_TOP, $X, $Y, 0, 0, $SWP_NOSIZE -bor $SWP_NOACTIVATE) | Out-Null
  $rect = New-Object DeskPin.Native+RECT
  [DeskPin.Native]::GetWindowRect($target, [ref]$rect) | Out-Null
  Write-Output ('OK move rect=' + $rect.Left + ',' + $rect.Top + ',' + $rect.Right + ',' + $rect.Bottom)
  exit 0
}

if ($Action -eq 'children') {
  $parent = $target
  if ($parent -eq [IntPtr]::Zero) { $parent = Get-DesktopParent }
  $child = [DeskPin.Native]::GetWindow($parent, 5)
  $n = 0
  while ($child -ne [IntPtr]::Zero) {
    $procId = 0
    [DeskPin.Native]::GetWindowThreadProcessId($child, [ref]$procId) | Out-Null
    $ts = New-Object System.Text.StringBuilder 256
    [DeskPin.Native]::GetWindowText($child, $ts, 256) | Out-Null
    $cs = New-Object System.Text.StringBuilder 256
    [DeskPin.Native]::GetClassName($child, $cs, 256) | Out-Null
    Write-Output ('child ' + ('0x{0:X}' -f [int64]$child) + ' pid=' + $procId + ' class=' + $cs.ToString() + ' title=' + $ts.ToString())
    $n = $n + 1
    $child = [DeskPin.Native]::GetWindow($child, 2)
  }
  Write-Output ('OK children parent=' + $parent.ToInt64() + ' count=' + $n)
  exit 0
}

if ($Action -eq 'findpid') {
  if ($Owner -le 0) { Write-Output 'ERR no-owner'; exit 4 }
  $script:hit = [IntPtr]::Zero
  $script:hitTitle = ''
  $script:all = New-Object System.Collections.ArrayList
  $cb = [DeskPin.Native+EnumWindowsProc]{
    param($h, $l)
    $procId = 0
    [DeskPin.Native]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    if ($procId -eq $Owner) {
      $ts = New-Object System.Text.StringBuilder 256
      [DeskPin.Native]::GetWindowText($h, $ts, 256) | Out-Null
      $vis = [DeskPin.Native]::IsWindowVisible($h)
      [void]$script:all.Add(("0x{0:X}" -f [int64]$h) + '/v=' + $vis + '/' + $ts.ToString())
      if ($vis -and $ts.Length -gt 0 -and $script:hit -eq [IntPtr]::Zero) {
        $script:hit = $h
        $script:hitTitle = $ts.ToString()
      }
    }
    return $true
  }
  [DeskPin.Native]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  if ($script:hit -eq [IntPtr]::Zero) {
    Write-Output ('ERR not-found count=' + $script:all.Count + ' all=' + ($script:all -join ' ; '))
    exit 5
  }
  Write-Output ('OK findpid hwnd=' + $script:hit.ToInt64() + ' title=' + $script:hitTitle + ' count=' + $script:all.Count)
  exit 0
}

if ($Action -eq 'find') {
  if (-not $Out) { Write-Output 'ERR no-title'; exit 4 }
  $script:hit = [IntPtr]::Zero
  $script:hitTitle = ''
  $script:hitClass = ''
  $cb = [DeskPin.Native+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 512
    [DeskPin.Native]::GetWindowText($h, $sb, 512) | Out-Null
    $title = $sb.ToString()
    if ($title -and $title -like ('*' + $Out + '*')) {
      $cls = New-Object System.Text.StringBuilder 256
      [DeskPin.Native]::GetClassName($h, $cls, 256) | Out-Null
      $script:hit = $h
      $script:hitTitle = $title
      $script:hitClass = $cls.ToString()
      return $false
    }
    return $true
  }
  [DeskPin.Native]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  if ($script:hit -eq [IntPtr]::Zero) { Write-Output 'ERR not-found'; exit 5 }
  Write-Output ('OK find hwnd=' + $script:hit.ToInt64() + ' class=' + $script:hitClass + ' title=' + $script:hitTitle)
  exit 0
}

if ($Action -eq 'pin') {
  $parent = Get-DesktopParent
  if ($parent -eq [IntPtr]::Zero) {
    Write-Output 'ERR no-desktop'
    exit 2
  }
  $style = [DeskPin.Native]::GetWindowLongPtr($target, $GWL_STYLE)
  $newStyle = [IntPtr](([int64]$style -bor $WS_CHILD) -band (-bnot $WS_POPUP))
  [DeskPin.Native]::SetWindowLongPtr($target, $GWL_STYLE, $newStyle) | Out-Null
  [DeskPin.Native]::SetParent($target, $parent) | Out-Null
  $now = [DeskPin.Native]::GetAncestor($target, $GA_PARENT)
  if ($now -ne $parent) {
    # 还原样式，别把窗口搞成半残废
    [DeskPin.Native]::SetWindowLongPtr($target, $GWL_STYLE, $style) | Out-Null
    Write-Output ('ERR pin-failed parent=' + $now.ToInt64())
    exit 3
  }
  # 放到桌面子窗口的最上层：壁纸与图标之上，仍然在所有普通窗口之下
  [DeskPin.Native]::SetWindowPos($target, $HWND_TOP, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED) | Out-Null
  [DeskPin.Native]::ShowWindow($target, 5) | Out-Null
  Write-Output ('OK pin parent=' + $parent.ToInt64() + ' actual=' + $now.ToInt64())
  exit 0
}

# unpin：还原窗口样式并脱离桌面，再交给 Electron 重新设置层级
$style = [DeskPin.Native]::GetWindowLongPtr($target, $GWL_STYLE)
$newStyle = [IntPtr](([int64]$style -bor $WS_POPUP) -band (-bnot $WS_CHILD))
[DeskPin.Native]::SetWindowLongPtr($target, $GWL_STYLE, $newStyle) | Out-Null
[DeskPin.Native]::SetParent($target, [IntPtr]::Zero) | Out-Null
[DeskPin.Native]::SetWindowPos($target, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED) | Out-Null
[DeskPin.Native]::ShowWindow($target, 5) | Out-Null
Write-Output ('OK unpin parent=' + ([DeskPin.Native]::GetAncestor($target, $GA_PARENT)).ToInt64())
exit 0
