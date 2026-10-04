import { win32 } from 'node:path';

export const installerMarker = '# Chimera npm installer';
const clean = value => {
  if (/[\r\n\0]/.test(value)) throw new Error('Control characters are not allowed in launch paths');
  return String(value);
};
export const psQuote = value => `'${clean(value).replaceAll("'", "''")}'`;
export const shQuote = value => `'${clean(value).replaceAll("'", "'\\''")}'`;
export const psCommand = source => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n${source}`, 'utf16le').toString('base64')];
const unitQuote = value => `"${clean(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
// Exec receives literal argv after desktop-entry unescaping, without a shell.
const desktopQuote = value => `"${clean(value).replaceAll('\\', '\\\\\\\\').replace(/["`$]/g, '\\\\$&').replaceAll('%', '%%')}"`;

export function systemdUnit(plan, daemon, node, path) {
  return `${installerMarker}\n[Unit]\nDescription=Chimera daemon\n[Service]\nType=simple\nExecStart=${unitQuote(node).replaceAll('$', () => '$$')} ${unitQuote(daemon).replaceAll('$', () => '$$')}\nEnvironment=${unitQuote(`CHIMERA_HOME=${plan.state}`)}\nEnvironment=${unitQuote(`PATH=${path}`)}\nRestart=on-failure\nRestartSec=2\n[Install]\nWantedBy=default.target\n`;
}

export function desktopEntry(plan) {
  return `[Desktop Entry]\n${installerMarker}\nType=Application\nName=Chimera\nComment=Multi-agent desktop cockpit\nExec=${desktopQuote(plan.app)} --appimage-extract-and-run\nIcon=utilities-terminal\nTerminal=false\nCategories=Development;\n`;
}

export function cliLauncher(platform, node, entry) {
  if (platform !== 'win32') return `#!/bin/sh\n${installerMarker}\nexec ${shQuote(node)} ${shQuote(entry)} "$@"\n`;
  const cmd = value => `"${clean(value).replaceAll('%', '%%')}"`;
  // Delayed expansion would corrupt paths/arguments containing ! under cmd.exe.
  return `@echo off\r\n@rem ${installerMarker}\r\n@setlocal DisableDelayedExpansion\r\n${cmd(node)} ${cmd(entry)} %*\r\n@exit /b %errorlevel%\r\n`;
}

export function windowsShortcut(path, target, args = '', hidden = false) {
  return `$w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut(${psQuote(path)}); $s.TargetPath = ${psQuote(target)}; $s.Arguments = ${psQuote(args)}; $s.WorkingDirectory = ${psQuote(win32.dirname(target))}; $s.Description = 'Chimera npm installer'; $s.WindowStyle = ${hidden ? 7 : 1}; $s.Save()`;
}

export function windowsDaemonStart(daemon, node, state, path) {
  const source = `const {spawn}=require('node:child_process'); const {openSync,closeSync}=require('node:fs');
const log=openSync(${JSON.stringify(win32.join(state, 'daemon.log'))},'a');
const env={...process.env}; for(const key of Object.keys(env)) if(key.startsWith('CHIMERA_')) delete env[key];
for(const key of Object.keys(env)) if(key.toLowerCase()==='path') delete env[key];
env.PATH=${JSON.stringify(path)}; env.CHIMERA_HOME=${JSON.stringify(state)};
const child=spawn(${JSON.stringify(node)},[${JSON.stringify(daemon)}],{env,detached:true,windowsHide:true,stdio:['ignore',log,log]});
child.on('error',e=>{console.error(e.message);process.exitCode=1});child.unref();closeSync(log);
`;
  return source;
}

export function verifyWindowsSignature(path, thumbprint) {
  if (!/^[a-f0-9]{40}$/i.test(thumbprint ?? '')) throw new Error('The npm release must pin its Windows publisher certificate thumbprint');
  return `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(path)};
if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne ${psQuote(thumbprint)} -or $null -eq $s.TimeStamperCertificate) { throw 'Invalid Windows signature, publisher or timestamp' }`;
}

export function verifyNativeHeader(bytes, platform, arch) {
  if (platform === 'linux') {
    if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1
      || bytes.readUInt16LE(18) !== (arch === 'x64' ? 62 : 183) || bytes.subarray(8, 11).toString('hex') !== '414902') throw new Error('Expected a matching 64-bit type-2 AppImage');
  } else if (platform === 'win32') {
    if (bytes.length < 64 || bytes.subarray(0, 2).toString() !== 'MZ') throw new Error('Expected a Windows PE executable');
    const pe = bytes.readUInt32LE(60);
    if (pe + 6 > bytes.length || bytes.subarray(pe, pe + 4).toString('hex') !== '50450000'
      || bytes.readUInt16LE(pe + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64)) throw new Error('Windows executable architecture mismatch');
  }
}

export const webviewProbe = `
$found = $false
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
    try {
      $key = $base.OpenSubKey('SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')
      if ($key) { try { $v = $key.GetValue('pv'); if ($v -and [version]$v -gt [version]'0.0.0.0') { $found = $true } } finally { $key.Dispose() } }
    } finally { $base.Dispose() }
  }
}
if ($found) { 'installed' } else { 'missing' }
`;
