# Probe: can a browser window be OWNED by TEDI instead of made its CHILD?
#
# WHY THIS EXISTS. `dock.rs` adopts the browser window with `SetParent`, which
# makes it a `WS_CHILD` of TEDI. That buys OS clipping, minimise-with-parent and
# no taskbar button, and it costs the Chrome omnibox: a caret never blinks there
# and typing appends instead of replacing.
#
# The cause is not a message that was missed. Chromium asks the OS live:
#
#   bool HWNDMessageHandler::IsActive() const { return ::GetActiveWindow() == hwnd(); }
#
# and `GetActiveWindow` answers with the active TOP-LEVEL window of the calling
# thread's queue, which a `WS_CHILD` can never be. `HWNDMessageHandler::_WndProc`
# also refuses to forward activation at all unless `IsTopLevelWindow(window)`,
# which is literally a `WS_CHILD` test. That is why posting `WM_NCACTIVATE` and
# `WM_ACTIVATE` was tried twice and reverted both times. Do not try it a third.
#
# But `WS_CHILD` is one line of `dock.rs`, not the architecture. An OWNED
# top-level window (`SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, tedi)`) is still
# top-level, so `GetActiveWindow()` can equal it - while an owner still gets:
# the owned window always above it, hidden when the owner minimises, and no
# taskbar button once `WS_EX_APPWINDOW` is cleared. If that holds, `SetParent`,
# `AttachThreadInput` (which currently lets a hung page freeze TEDI) and the
# `WM_PARENTNOTIFY` hook in `lib.rs` all delete.
#
# WHAT IS UNVERIFIED, and why this is a probe rather than a patch. MSDN documents
# `GWLP_HWNDPARENT` as "changes the owner window" with no stated process
# restriction, and cross-process `SetParent` demonstrably works - but there is no
# shipping precedent for cross-process OWNERSHIP, ownership is documented as
# something set at creation, and the one other team that shipped this
# architecture (nextain/naia-shell) needed a 500 ms watchdog because Chrome
# reasserts its own WINDOWPLACEMENT. So: measure, then decide.
#
# RUN IT:
#   1. Start TEDI and open a browser pane, so a Chromium is running on TEDI's
#      profile. Leave the pane open.
#   2. powershell -ExecutionPolicy Bypass -File scripts\browser\owned-window-probe.ps1
#
# Everything here is read-mostly and reversible: the only writes are window
# styles on a browser window you can close afterwards. It touches no TEDI state.

$ErrorActionPreference = 'Stop'

# One Add-Type for the whole script. P/Invoke types do NOT survive between
# PowerShell invocations, so the declarations and the code that uses them have to
# live in the same run.
Add-Type -Namespace Probe -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetActiveWindow();
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
[DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", SetLastError=true)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetWindowLongPtrW(IntPtr h, int idx);
[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetWindowLongPtrW(IntPtr h, int idx, IntPtr v);
[DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
public delegate bool EnumProc(IntPtr h, IntPtr p);
'@

$GWL_STYLE = -16
$GWL_EXSTYLE = -20
$GWLP_HWNDPARENT = -8
$WS_CAPTION = 0x00C00000
$WS_THICKFRAME = 0x00040000
$WS_SYSMENU = 0x00080000
$WS_MINIMIZEBOX = 0x00020000
$WS_MAXIMIZEBOX = 0x00010000
$WS_CHILD = 0x40000000
$WS_POPUP = 0x80000000
$WS_EX_APPWINDOW = 0x00040000
$WS_EX_TOOLWINDOW = 0x00000080
$SWP_NOMOVE = 0x0002
$SWP_NOSIZE = 0x0001
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020

# A callback cannot write to the pipeline, so it collects into a list the caller
# reads afterwards.
$found = New-Object System.Collections.ArrayList
$cb = [Probe.Win+EnumProc]{
  param($h, $p)
  $cls = New-Object System.Text.StringBuilder 256
  [void][Probe.Win]::GetClassNameW($h, $cls, 256)
  $txt = New-Object System.Text.StringBuilder 512
  [void][Probe.Win]::GetWindowTextW($h, $txt, 512)
  $procId = 0
  [void][Probe.Win]::GetWindowThreadProcessId($h, [ref]$procId)
  [void]$found.Add([pscustomobject]@{
    Hwnd = $h; Class = $cls.ToString(); Title = $txt.ToString(); Pid = $procId
    Visible = [Probe.Win]::IsWindowVisible($h)
  })
  return $true
}
[void][Probe.Win]::EnumWindows($cb, [IntPtr]::Zero)

function Describe([IntPtr]$h) {
  $s = [int64][Probe.Win]::GetWindowLongPtrW($h, $GWL_STYLE)
  $x = [int64][Probe.Win]::GetWindowLongPtrW($h, $GWL_EXSTYLE)
  [pscustomobject]@{
    Visible    = [Probe.Win]::IsWindowVisible($h)
    Minimised  = [Probe.Win]::IsIconic($h)
    IsChild    = [bool]($s -band $WS_CHILD)
    HasCaption = [bool]($s -band $WS_CAPTION)
    AppWindow  = [bool]($x -band $WS_EX_APPWINDOW)
    ToolWindow = [bool]($x -band $WS_EX_TOOLWINDOW)
    # GetParent answers the OWNER for a top-level window and the PARENT for a
    # child, which is exactly the distinction under test.
    ParentOrOwner = [Probe.Win]::GetParent($h)
  }
}

Write-Host ''
Write-Host 'OWNED-WINDOW PROBE' -ForegroundColor Cyan
Write-Host '=================='

$tedi = $found | Where-Object { $_.Class -like 'Tauri*' -or $_.Title -match 'TEDI' } | Where-Object Visible | Select-Object -First 1
if (-not $tedi) {
  Write-Host 'No TEDI window found. Start TEDI first.' -ForegroundColor Red
  exit 1
}
Write-Host ("TEDI    : {0} [{1}] '{2}'" -f $tedi.Hwnd, $tedi.Class, $tedi.Title)

# A top-level Chrome frame. An already-ADOPTED one is a child and therefore not
# enumerated here at all, which is itself the signal: if none is found while a
# browser pane is open, the pane is currently on the WS_CHILD path and you must
# switch that pane to a non-adopted state first (open the pane on the canvas, or
# close and reopen it) so the window is top-level when this runs.
$chrome = $found | Where-Object { $_.Class -eq 'Chrome_WidgetWin_1' -and $_.Visible -and $_.Title } | Select-Object -First 1
if (-not $chrome) {
  Write-Host ''
  Write-Host 'No top-level Chrome window found.' -ForegroundColor Yellow
  Write-Host 'Either no browser pane is open, or its window is already adopted as a'
  Write-Host 'WS_CHILD (a child is not enumerated by EnumWindows). Open a browser pane'
  Write-Host 'on the CANVAS view first: that path parks a top-level window instead.'
  exit 1
}
Write-Host ("Chrome  : {0} [{1}] '{2}'" -f $chrome.Hwnd, $chrome.Class, $chrome.Title)
Write-Host ''
Write-Host 'BEFORE:' -ForegroundColor Yellow
Describe $chrome.Hwnd | Format-List

# --- the change under test -------------------------------------------------
$h = $chrome.Hwnd
$style = [int64][Probe.Win]::GetWindowLongPtrW($h, $GWL_STYLE)
$stripped = ($style -band -bnot ($WS_CAPTION -bor $WS_THICKFRAME -bor $WS_SYSMENU -bor $WS_MINIMIZEBOX -bor $WS_MAXIMIZEBOX)) -bor $WS_POPUP
[void][Probe.Win]::SetWindowLongPtrW($h, $GWL_STYLE, [IntPtr]$stripped)

$ex = [int64][Probe.Win]::GetWindowLongPtrW($h, $GWL_EXSTYLE)
$exNew = ($ex -band -bnot $WS_EX_APPWINDOW) -bor $WS_EX_TOOLWINDOW
[void][Probe.Win]::SetWindowLongPtrW($h, $GWL_EXSTYLE, [IntPtr]$exNew)

# The line the whole probe is about: OWNER, not parent.
[void][Probe.Win]::SetWindowLongPtrW($h, $GWLP_HWNDPARENT, $tedi.Hwnd)
[void][Probe.Win]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0,
  ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED))

Write-Host 'AFTER:' -ForegroundColor Yellow
$after = Describe $h
$after | Format-List

Write-Host 'MACHINE-CHECKABLE RESULTS' -ForegroundColor Cyan
$ownerOk = ($after.ParentOrOwner -eq $tedi.Hwnd)
$notChild = (-not $after.IsChild)
$noTaskbar = ((-not $after.AppWindow) -and $after.ToolWindow)
Write-Host ("  owner is TEDI            : {0}" -f $(if ($ownerOk) { 'PASS' } else { 'FAIL' }))
Write-Host ("  still top-level (no CHILD): {0}" -f $(if ($notChild) { 'PASS' } else { 'FAIL' }))
Write-Host ("  taskbar button suppressed : {0}" -f $(if ($noTaskbar) { 'PASS' } else { 'FAIL' }))
Write-Host ''
Write-Host 'NOW CHECK BY HAND, in this order:' -ForegroundColor Cyan
Write-Host '  1. Click the browser address bar. Does a caret BLINK, and does typing'
Write-Host '     REPLACE the selection rather than append to the end?'
Write-Host '     This is the whole question. If it fails, the idea is dead: stop.'
Write-Host '  2. Click the page, then check focus followed it (type into a text field).'
Write-Host '  3. Minimise TEDI. Does the browser go with it? Restore. Does it come back?'
Write-Host '  4. Alt-Tab to another app. Does the browser go behind TEDI, or float over'
Write-Host '     the other app? Floating over is WORSE than today.'
Write-Host '  5. Drag the TEDI window. The browser will NOT follow (nothing is placing'
Write-Host '     it in this probe) - that is expected and not a failure.'
Write-Host ''
Write-Host 'Close the browser window when done; nothing here persists.' -ForegroundColor DarkGray
