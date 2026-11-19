'use strict';

/**
 * RapooLite 启动器
 *
 *   1. 如果已经有实例在跑（/api/ping 通），直接唤起界面后退出
 *   2. 否则选空闲端口起后端
 *   3. 起托盘（显示电量）
 *   4. 非静默模式再开一个 Edge --app 无边框窗口
 *
 * 用法：node start.js [--port 7373] [--silent] [--no-open] [--no-tray]
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const WANT_PORT = Number(argOf('--port', 7373));
const SILENT = has('--silent');
const NO_OPEN = has('--no-open');
const NO_TRAY = has('--no-tray');
const ROOT = __dirname;
const PROFILE = path.join(ROOT, '.browser-profile');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const log = (...a) => console.log('[RapooLite]', ...a);

function findEdge() {
  return EDGE_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort(start) {
  for (let p = start; p < start + 30; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await portFree(p)) return p;
  }
  throw new Error('找不到可用端口');
}

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.app === 'RapooLite' ? data : null;
  } catch {
    return null;
  }
}

async function findRunning() {
  for (let p = WANT_PORT; p < WANT_PORT + 30; p++) {
    // eslint-disable-next-line no-await-in-loop
    const info = await probe(p);
    if (info) return info;
  }
  return null;
}

function openWindow(port) {
  const edge = findEdge();
  if (!edge) {
    log(`未找到 Edge，请手动打开 http://127.0.0.1:${port}`);
    return null;
  }
  return spawn(
    edge,
    [
      `--app=http://127.0.0.1:${port}/`,
      `--user-data-dir=${PROFILE}`,
      '--window-size=1200,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--disable-background-networking',
      '--disable-sync',
    ],
    { stdio: 'ignore', windowsHide: false, detached: true },
  );
}

function startTray(port) {
  const script = path.join(ROOT, 'tray.ps1');
  if (!fs.existsSync(script) || !fs.existsSync(PS_EXE)) return null;
  return spawn(PS_EXE, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function waitReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await probe(port)) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(200);
  }
  return false;
}

async function main() {
  const running = await findRunning();
  if (running) {
    log(`已有实例在运行（端口 ${running.port}）`);
    if (!SILENT && !NO_OPEN) {
      const win = openWindow(running.port);
      // 不要等浏览器退出：本进程只是来唤起窗口的
      if (win) win.unref();
    }
    return;
  }

  const port = await pickPort(WANT_PORT);
  log(`后端端口 ${port}`);

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const ready = await waitReady(port);
  if (!ready) {
    console.error('[RapooLite] 后端启动失败');
    server.kill();
    process.exit(1);
  }
  log('后端就绪');

  const tray = NO_TRAY ? null : startTray(port);
  if (tray) {
    tray.stderr.on('data', (d) => process.stderr.write(`[tray] ${d}`));
    log('托盘已启动');
  } else if (!NO_TRAY) {
    log('托盘启动失败（找不到 powershell 或 tray.ps1）');
  }

  let browser = null;
  if (!SILENT && !NO_OPEN) {
    browser = openWindow(port);
    log('界面已打开');
  }

  let exiting = false;
  const shutdown = (code = 0) => {
    if (exiting) return;
    exiting = true;
    for (const p of [browser, tray, server]) {
      if (!p) continue;
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => process.exit(code), 300);
  };

  if (browser) {
    browser.on('exit', () => {
      if (tray) {
        // 有托盘就继续常驻：电量显示和自启开关都靠它
        log('界面已关闭，保留托盘常驻');
      } else {
        log('界面已关闭，退出');
        shutdown(0);
      }
    });
  }

  if (tray) {
    tray.on('exit', () => log('托盘已退出'));
  }

  server.on('exit', (code) => {
    log(`后端退出（${code}）`);
    shutdown(0);
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

main().catch((e) => {
  console.error('[RapooLite] 启动失败：' + e.message);
  process.exit(1);
});
