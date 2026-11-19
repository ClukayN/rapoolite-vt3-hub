'use strict';

/**
 * 开机自启：写 HKCU 的 Run 项，指向一个隐藏窗口的 VBS 启动器。
 * 用 reg.exe 而不是原生注册表模块，避免引入编译依赖。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'RapooLite';
const ROOT = path.join(__dirname, '..');
const VBS_PATH = path.join(ROOT, 'RapooLite.vbs');
const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
const LNK_PATH = path.join(STARTUP_DIR, 'RapooLite.lnk');

function queryRaw() {
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', VALUE_NAME], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/REG_SZ\s+(.+?)\s*$/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

/** 用 -EncodedCommand 执行 PowerShell，彻底绕开 PS 5.1 的 ANSI 读文件问题。 */
function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

function lnkExists() {
  try {
    return fs.statSync(LNK_PATH).size > 0;
  } catch {
    return false;
  }
}

/** 备选方案：注册表被拦时，往「启动」文件夹放一个快捷方式。 */
function enableViaStartupFolder() {
  if (!fs.existsSync(STARTUP_DIR)) {
    fs.mkdirSync(STARTUP_DIR, { recursive: true });
  }
  const hostExe = process.env.RAPOOLITE_HOST_EXE;
  const target = hostExe || process.execPath;
  const args = hostExe ? '--silent' : `"${path.join(ROOT, 'start.js')}" --silent`;
  const workDir = hostExe ? path.dirname(hostExe) : ROOT;
  if (fs.existsSync(LNK_PATH)) {
    fs.rmSync(LNK_PATH, { force: true });
  }
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$ws = New-Object -ComObject WScript.Shell`,
    `$sc = $ws.CreateShortcut(${psQuote(LNK_PATH)})`,
    `$sc.TargetPath = ${psQuote(target)}`,
    `$sc.Arguments = ${psQuote(args)}`,
    `$sc.WorkingDirectory = ${psQuote(workDir)}`,
    `$sc.WindowStyle = 7`,
    `$sc.Description = "RapooLite"`,
    `$sc.Save()`,
  ].join('\r\n');
  try {
    runPowerShell(script);
  } catch (err) {
    const text = String((err && (err.stderr || err.stdout)) || '').replace(/\s+/g, ' ');
    const denied = /UnauthorizedAccess|拒绝访问|0x80070005/i.test(text);
    throw new Error(denied ? '无权限写入「启动」文件夹（进程权限受限）' : '创建启动快捷方式失败');
  }
  if (!lnkExists()) {
    throw new Error('创建启动快捷方式失败');
  }
  return { method: 'startup-folder', path: LNK_PATH };
}

function isEnabled() {
  return queryRaw().length > 0 || lnkExists();
}

function currentCommand() {
  const raw = queryRaw();
  if (raw) {
    return raw;
  }
  return lnkExists() ? LNK_PATH : '';
}

/** 生成隐藏窗口启动脚本，返回 vbs 路径。exe 宿主模式下直接拉起 exe。 */
function ensureVbs() {
  const hostExe = process.env.RAPOOLITE_HOST_EXE;
  // exe 模式下把 VBS 放到 exe 旁边（dist\），重新打包 app\ 时不会被清掉
  const vbsPath = hostExe ? path.join(path.dirname(hostExe), 'RapooLite.vbs') : VBS_PATH;
  const escapedRoot = ROOT.replace(/"/g, '""');
  const runLine = hostExe
    ? `sh.Run """${hostExe.replace(/"/g, '""')}"" --silent", 0, False`
    : `sh.Run """${process.execPath}"" ""${path.join(ROOT, 'start.js')}"" --silent", 0, False`;
  const content = [
    "' 由 RapooLite 自动生成：隐藏窗口启动，供开机自启使用",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${escapedRoot}"`,
    runLine,
    '',
  ].join('\r\n');
  // WSH 对无 BOM 的 UTF-8 会按 ANSI 解析，显式写成带 BOM 的 UTF-16LE
  const bom = Buffer.from([0xff, 0xfe]);
  fs.writeFileSync(vbsPath, Buffer.concat([bom, Buffer.from(content, 'utf16le')]));
  return vbsPath;
}

/** PowerShell 单引号字面量：反斜杠和双引号都原样保留，只需把单引号翻倍。 */
function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/** 直接写注册表值（用 PowerShell 写，能正确保存以引号开头的值；reg add 会被引号坑）。 */
function writeRegValue(value) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'`,
    `Set-ItemProperty -Path $key -Name ${psQuote(VALUE_NAME)} -Value ${psQuote(value)} -Type String -Force`,
  ].join('\r\n');
  runPowerShell(script);
}

function enable() {
  const hostExe = process.env.RAPOOLITE_HOST_EXE;
  let regError = null;

  // 首选一：exe 模式直接把启动项指向 exe 本身，不依赖任何中间脚本，不会被重新打包清掉
  if (hostExe) {
    const command = `"${hostExe}" --silent`;
    try {
      writeRegValue(command);
      const written = queryRaw();
      if (written && written.toLowerCase().includes(hostExe.toLowerCase())) {
        return { enabled: true, method: 'registry-exe', command: written };
      }
      regError = new Error(written ? '启动项内容与预期不一致' : '启动项写入后读回为空');
    } catch (err) {
      const detail = String((err && (err.stderr || err.stdout)) || err.message || '').replace(/\s+/g, ' ').trim();
      regError = new Error(/拒绝访问|UnauthorizedAccess|0x80070005/i.test(detail) ? '拒绝访问（进程权限不足）' : '写入启动项失败');
    }
  }

  // 首选二：wscript 启动隐藏窗口的 VBS（Node 模式用它避免控制台黑框）
  if (!regError) {
    try {
      const command = `wscript.exe "${ensureVbs()}"`;
      execFileSync('reg', ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const written = queryRaw();
      if (written) {
        return { enabled: true, method: 'registry', command: written };
      }
      regError = new Error('启动项写入后读回为空');
    } catch (err) {
      const detail = String((err && (err.stderr || err.stdout)) || err.message || '').trim();
      regError = new Error(detail || '注册表写入失败');
    }
  }

  // 备选：往「启动」文件夹放快捷方式（注册表被策略/安全软件拦时仍可生效）
  try {
    const alt = enableViaStartupFolder();
    return { enabled: true, method: alt.method, command: alt.path, note: regError.message };
  } catch (altErr) {
    const denied = /拒绝访问|权限|UnauthorizedAccess|0x80070005/i.test(`${regError.message} ${altErr.message}`);
    const hint = denied
      ? '（当前进程权限不足：如果你是双击 dist\\RapooLite.exe 启动的，请先退出所有实例再重试；从受限环境/脚本里启动的进程无法写启动项）'
      : '';
    throw new Error(`开机自启设置失败：${regError.message}；备用方案也失败：${altErr.message}${hint}`);
  }
}

function disable() {
  try {
    execFileSync('reg', ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    /* 本来就不存在 */
  }
  try {
    if (lnkExists()) {
      fs.rmSync(LNK_PATH, { force: true });
    }
  } catch {
    /* 忽略 */
  }
  if (queryRaw() || lnkExists()) {
    throw new Error('删除启动项失败，可能被安全软件拦截');
  }
  return { enabled: false };
}

/** 自愈：启动项指向的文件不存在（例如重新打包后旧路径失效）就重写一遍。 */
function repair() {
  const cmd = currentCommand();
  if (!cmd) {
    return { changed: false };
  }
  const quoted = /"([^"]+)"/.exec(cmd);
  const target = quoted ? quoted[1] : cmd.split(/\s+/)[0];
  if (target && fs.existsSync(target)) {
    return { changed: false };
  }
  const result = enable();
  return { changed: true, ...result };
}

module.exports = { isEnabled, enable, disable, repair, currentCommand, VBS_PATH, STARTUP_DIR, LNK_PATH };
