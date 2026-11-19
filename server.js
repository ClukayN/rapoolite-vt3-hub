'use strict';

/**
 * RapooLite 本地后端：HTTP API + SSE 状态推送 + 静态 UI。
 * 启动：node server.js [--port 7373] [--open]
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { Device } = require('./lib/device');
const autostart = require('./lib/autostart');

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(argOf('--port', process.env.RAPOOLITE_PORT || 7373));
const UI_DIR = path.join(__dirname, 'ui');
const DATA_DIR = process.env.RAPOOLITE_DATA_DIR || path.join(__dirname, 'data');
const THEME_FILE = path.join(DATA_DIR, 'theme.json');
const PRESET_DIR = path.join(DATA_DIR, 'presets');

// ---------- 界面主题（背景模式 / 多张自选背景预设） ----------

let theme = { mode: 'gray', dim: 0, activeId: null, presets: [], imageVersion: 0 };

function loadTheme() {
  try {
    const raw = JSON.parse(fs.readFileSync(THEME_FILE, 'utf8'));
    theme = { ...theme, ...raw };
    if (!Array.isArray(theme.presets)) theme.presets = [];
  } catch {
    /* 首次运行，使用默认值 */
  }

  // 老版本只存一张 background.img：迁移成一个预设，避免升级后背景丢失
  try {
    const legacy = path.join(DATA_DIR, 'background.img');
    const alreadyMigrated = theme.presets.some((p) => p.name === '我的背景');
    if (!alreadyMigrated && !theme.presets.length && fs.existsSync(legacy)) {
      fs.mkdirSync(PRESET_DIR, { recursive: true });
      const id = 'p' + Date.now().toString(36);
      const ext = 'img';
      fs.copyFileSync(legacy, path.join(PRESET_DIR, `${id}.${ext}`));
      theme.presets.push({ id, name: '我的背景', ext });
      theme.activeId = id;
      theme.mode = 'image';
      theme.imageVersion = Date.now();
      saveTheme();
      try {
        fs.renameSync(legacy, legacy + '.migrated');
      } catch {
        /* 迁移后改名，避免重复导入 */
      }
      log('已把旧背景图片导入为预设');
    }
  } catch (e) {
    log('旧背景迁移失败：' + e.message);
  }

  // 图片模式但没有可用预设时回落到深灰
  if (theme.mode === 'image' && !theme.presets.length) theme.mode = 'gray';
  if (theme.mode === 'image' && !theme.presets.some((p) => p.id === theme.activeId)) {
    theme.activeId = theme.presets[0].id;
  }
}

function saveTheme() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(THEME_FILE, JSON.stringify(theme, null, 2));
  } catch (e) {
    log('主题保存失败：' + e.message);
  }
}

function presetFile(preset) {
  return path.join(PRESET_DIR, `${preset.id}.${preset.ext}`);
}

function activePreset() {
  return theme.presets.find((x) => x.id === theme.activeId) || null;
}

function themePayload() {
  const active = activePreset();
  const v = theme.imageVersion || 0;
  return {
    mode: theme.mode,
    dim: theme.dim,
    imageVersion: v,
    activeId: theme.activeId,
    presets: theme.presets.map((x) => ({
      id: x.id,
      name: x.name,
      url: `/api/theme/image?id=${x.id}&v=${v}`,
    })),
    hasImage: !!active,
    imageUrl: active ? `/api/theme/image?id=${active.id}&v=${v}` : null,
  };
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

const logs = [];
function log(msg) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  logs.push(line);
  if (logs.length > 200) logs.shift();
  console.log(line);
}

const device = new Device(log);
const sseClients = new Set();
loadTheme();

let lastButtonFetch = 0;

device.on('state', (state) => {
  const payload = `data: ${JSON.stringify({ type: 'state', state })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }

  // 设备从休眠醒来后按键表可能还是空的，自动补一次（最多 20 秒一次）
  if (state.connected && (!state.buttons || !state.buttons.length)) {
    const now = Date.now();
    if (now - lastButtonFetch > 20000) {
      lastButtonFetch = now;
      setTimeout(() => {
        device.readButtons().catch(() => {});
      }, 1200);
    }
  }
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

// 从注册表里找出本产品的 MSI ProductCode（卸载用）
function findProductCode() {
  const uninstallKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of uninstallKeys) {
    let out = '';
    try {
      out = execFileSync('reg', ['query', root, '/s', '/v', 'DisplayName'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      });
    } catch {
      continue;
    }
    // 形如：HKEY_LOCAL_MACHINE\...\Uninstall\{GUID}  ...  DisplayName  REG_SZ  RapooLite
    const blocks = out.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      if (!/DisplayName\s+REG_SZ\s+RapooLite/i.test(block)) continue;
      const m = block.match(/Uninstall\\(\{[0-9A-Fa-f-]{36}\})/);
      if (m) return m[1];
    }
  }
  return null;
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data ?? null);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > maxBytes) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/ping' && req.method === 'GET') {
    return sendJson(res, 200, { app: 'RapooLite', port: PORT, pid: process.pid });
  }

  if (p === '/api/quit' && req.method === 'POST') {
    sendJson(res, 200, { ok: true });
    log('收到退出请求');
    setTimeout(() => {
      device.disconnect();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500);
    }, 120);
    return undefined;
  }

  if (p === '/api/uninstall' && req.method === 'POST') {
    // 交给 Windows Installer 卸载；本进程随即退出，让 MSI 能删掉文件
    const code = findProductCode();
    if (!code) {
      return sendJson(res, 200, {
        ok: false,
        error: '没有找到已安装的 MSI 记录（当前可能是免安装版，请直接删除安装目录）',
      });
    }
    sendJson(res, 200, { ok: true, productCode: code });
    log(`开始卸载：${code}`);
    // 先拉起延迟执行的卸载脚本（等我们退出后再让安装器删文件），随后立刻结束本进程
    try {
      const target = path.dirname(__dirname); // 安装目录（本文件在 <安装目录>\app\ 下）
      const appDir = path.join(target, 'app');
      const cacheDir = path.join(target, 'userdata');
      const ps = [
        'Start-Sleep -Seconds 5',
        `Start-Process -FilePath 'msiexec.exe' -ArgumentList '/x','${code}','/qn' -Wait -WindowStyle Hidden`,
        `Remove-Item -LiteralPath '${appDir}' -Recurse -Force -ErrorAction SilentlyContinue`,
        `Remove-Item -LiteralPath '${cacheDir}' -Recurse -Force -ErrorAction SilentlyContinue`,
      ].join('; ');
      const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      log('卸载进程已启动');
    } catch (err) {
      log(`调用卸载失败：${err && err.message}`);
    }
    setTimeout(() => {
      try {
        device.disconnect();
      } catch {}
      process.exit(0);
    }, 600);
    return undefined;
  }

  if (p === '/api/autostart') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, enabled: autostart.isEnabled(), command: autostart.currentCommand() });
    }
    const body = await readBody(req);
    try {
      const result = body.enabled ? autostart.enable() : autostart.disable();
      const where = result.enabled && result.method === 'startup-folder' ? '（启动文件夹）' : '';
      log(`开机自启：${result.enabled ? '已开启' + where : '已关闭'}`);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      const msg = String((err && err.message) || err);
      log(`开机自启设置失败：${msg}`);
      return sendJson(res, 200, { ok: false, error: msg, enabled: autostart.isEnabled() });
    }
  }

  if (p === '/api/theme/image' && req.method === 'GET') {
    const id = url.searchParams.get('id') || theme.activeId;
    const preset = theme.presets.find((x) => x.id === id);
    if (!preset) return sendJson(res, 404, { ok: false, error: '没有这张背景图' });
    const file = presetFile(preset);
    if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: '背景图文件缺失' });
    res.writeHead(200, {
      'Content-Type': preset.mime || 'image/jpeg',
      'Cache-Control': 'no-store',
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (p === '/api/theme/presets') {
    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      const idx = theme.presets.findIndex((x) => x.id === id);
      if (idx < 0) return sendJson(res, 404, { ok: false, error: '预设不存在' });
      const [removed] = theme.presets.splice(idx, 1);
      try {
        fs.unlinkSync(presetFile(removed));
      } catch {
        /* 文件可能已经不在了 */
      }
      if (theme.activeId === id) {
        theme.activeId = theme.presets[0]?.id ?? null;
        theme.mode = theme.activeId ? theme.mode : 'gray';
      }
      theme.imageVersion = Date.now();
      saveTheme();
      log(`已删除背景预设「${removed.name}」`);
      broadcast({ type: 'theme', theme: themePayload() });
      return sendJson(res, 200, { ok: true, ...themePayload() });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不支持' });
    const body = await readBody(req, 24e6);
    const m = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i.exec(body.dataUrl || '');
    if (!m) return sendJson(res, 400, { ok: false, error: '图片数据格式不正确' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 20 * 1024 * 1024) {
      return sendJson(res, 400, { ok: false, error: '图片过大（上限 20MB）' });
    }
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const preset = {
      id,
      ext,
      mime: `image/${m[1].toLowerCase()}`,
      name: (body.name || '').trim() || `背景 ${theme.presets.length + 1}`,
      createdAt: Date.now(),
    };
    fs.mkdirSync(PRESET_DIR, { recursive: true });
    fs.writeFileSync(path.join(PRESET_DIR, `${id}.${ext}`), buf);
    theme.presets.push(preset);
    theme.activeId = id;
    theme.mode = 'image';
    theme.imageVersion = Date.now();
    saveTheme();
    log(`已添加背景预设「${preset.name}」（${Math.round(buf.length / 1024)} KB）`);
    broadcast({ type: 'theme', theme: themePayload() });
    return sendJson(res, 200, { ok: true, ...themePayload() });
  }

  if (p === '/api/theme') {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...themePayload() });
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不支持' });

    const body = await readBody(req, 1e6);
    if (body.activeId !== undefined) {
      if (body.activeId === null) {
        theme.activeId = null;
      } else if (theme.presets.some((x) => x.id === body.activeId)) {
        theme.activeId = body.activeId;
      } else {
        return sendJson(res, 400, { ok: false, error: '预设不存在' });
      }
      theme.imageVersion = Date.now();
    }
    if (body.mode && ['black', 'gray', 'light', 'image'].includes(body.mode)) {
      if (body.mode === 'image' && !activePreset()) {
        return sendJson(res, 400, { ok: false, error: '还没有选择图片' });
      }
      theme.mode = body.mode;
    }

    saveTheme();
    broadcast({ type: 'theme', theme: themePayload() });
    return sendJson(res, 200, { ok: true, ...themePayload() });
  }

  if (p === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, { state: device.state, logs: logs.slice(-30) });
  }

  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'state', state: device.state })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return undefined;
  }

  if (p === '/api/connect' && req.method === 'POST') {
    await device.connect();
    await device.refresh();
    return sendJson(res, 200, { ok: true, state: device.state });
  }

  if (p === '/api/disconnect' && req.method === 'POST') {
    device.disconnect();
    return sendJson(res, 200, { ok: true, state: device.state });
  }

  if (p === '/api/refresh' && req.method === 'POST') {
    if (!device.hid.connected) await device.connect();
    const state = await device.refresh();
    return sendJson(res, 200, { ok: true, state });
  }

  if (p === '/api/buttons' && req.method === 'GET') {
    const buttons = await device.readButtons();
    return sendJson(res, 200, { ok: true, buttons });
  }

  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不支持' });

  const body = await readBody(req);

  if (p === '/api/dpi') {
    const result = await device.setDpi({
      dpiX: body.dpiX,
      dpiY: body.dpiY,
      slotCount: body.slotCount,
      dpiIndex: body.dpiIndex,
    });
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (p === '/api/polling') {
    const hz = await device.setPolling(body.hz);
    return sendJson(res, 200, { ok: true, pollingHz: hz, state: device.state });
  }

  if (p === '/api/perf') {
    const mode = await device.setPerformanceMode(body.mode);
    return sendJson(res, 200, { ok: true, performanceMode: mode, state: device.state });
  }

  if (p === '/api/setting') {
    const state = await device.setSetting(body.key, body.value);
    return sendJson(res, 200, { ok: true, state });
  }

  if (p === '/api/button') {
    const entry = await device.setButton(body.index, {
      funckey: body.funckey,
      keycode: body.keycode,
    });
    return sendJson(res, 200, { ok: true, button: entry, state: device.state });
  }

  return sendJson(res, 404, { ok: false, error: '未知接口' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(UI_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(UI_DIR)) return sendJson(res, 403, { ok: false, error: '越界' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
  return undefined;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      log(`API 失败 ${url.pathname}: ${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message, code: e.code || null });
      else res.end();
    });
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, '127.0.0.1', async () => {
  log(`RapooLite 已启动 http://127.0.0.1:${PORT}`);
  // 启动项自愈：旧值指向的脚本/程序被删了就按当前路径重写（权限不足时静默跳过）
  try {
    const fixed = autostart.repair();
    if (fixed.changed) log(`启动项已按当前位置重写（${fixed.method || 'unknown'}）`);
  } catch (e) {
    log('启动项检查跳过：' + e.message);
  }
  try {
    await device.connect();
    await device.refresh();
    log('设备已连接，配置读取完成');
    device.readButtons().catch((e) => log('按键读取失败：' + e.message));
  } catch (e) {
    log(`设备连接失败：${e.message}`);
    scheduleRetry(5000, '设备尚未就绪');
  }
});

/** 开机自启时鼠标可能还没唤醒，失败就静默重试直到连上。 */
let retryTimer = null;
function scheduleRetry(delay, why) {
  if (retryTimer) return;
  log(`${why}，${Math.round(delay / 1000)} 秒后自动重试`);
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    try {
      await device.connect();
      await device.refresh();
      log('设备已连接（自动重试成功）');
      device.readButtons().catch((e) => log('按键读取失败：' + e.message));
    } catch (e) {
      scheduleRetry(Math.min(30000, delay * 2), `仍在等待设备（${e.message}）`);
    }
  }, delay);
}

device.on('disconnect', () => scheduleRetry(3000, '设备已断开'));

process.on('SIGINT', () => {
  log('退出中…');
  device.disconnect();
  server.close(() => process.exit(0));
});
