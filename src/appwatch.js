// The app in front, for profiles that switch with it (profiles.js rules). Windows only:
// one long-lived PowerShell asks user32 for the foreground window's process every 400 ms
// and prints its name only when it changes, so this costs next to nothing.
const cp = require('child_process');

const SCRIPT = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$last = ''
while ($true) {
  $p = 0; [void][Fg]::GetWindowThreadProcessId([Fg]::GetForegroundWindow(), [ref]$p)
  $n = ''
  if ($p) { try { $n = (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch { } }
  if ($n -and $n -ne $last) { [Console]::Out.WriteLine($n); [Console]::Out.Flush(); $last = $n }
  Start-Sleep -Milliseconds 400
}`;

// Calls onApp(name) with each new foreground app (process name, no .exe). Returns stop().
// Elsewhere than Windows it does nothing (and says so once through onError).
function watchForeground(onApp, onError = () => {}) {
  if (process.platform !== 'win32') { onError(new Error('app-linked profiles need Windows')); return () => {}; }
  const child = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true });
  let buf = '', stopped = false;
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const name = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (name) onApp(name);
    }
  });
  child.on('error', (e) => { if (!stopped) onError(e); });
  child.on('exit', (code) => { if (!stopped) onError(new Error(`the app watcher stopped (exit ${code})`)); });
  return () => { stopped = true; child.kill(); };
}

module.exports = { watchForeground };
