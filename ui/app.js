'use strict';

/* ============================ 常量 ============================ */

const $ = (id) => document.getElementById(id);

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PARAMS = new URLSearchParams(location.search);
const STATIC = PARAMS.get('static') === '1';

const BUTTON_NAMES = { 1: '左键', 2: '右键', 3: '中键', 4: '前进', 5: '后退', 6: 'DPI +', 7: 'DPI −', 8: 'DIY 键（底部）' };
const PERF_LABEL = { low: '低功耗', hp: '高性能', sport: '竞技', oc: '超频' };
const PERF_DESC = {
  low: '微秒级响应，兼顾日常使用与续航',
  hp: '提升响应速度，适合电竞场景',
  sport: '高扫描率，追求极致跟手',
  oc: '超频模式，释放全部性能',
};
const PERF_MODES_BY_POLLING = {
  125: ['low'],
  250: ['low'],
  500: ['low', 'hp'],
  1000: ['low', 'hp', 'sport', 'oc'],
  2000: ['hp', 'sport', 'oc'],
  4000: ['sport', 'oc'],
  8000: ['sport', 'oc'],
};

const DPI_MIN = 50;
const DPI_MAX = 26000;
const SLOT_MAX = 6;
const POLLING_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];
const KEY_SCAN_RATES = [1000, 2000, 4000, 8000];
const SLOT_COLORS = ['#ff6b6b', '#6f8dff', '#4ade9b', '#ffb44d', '#b06bff', '#39c8d8'];
const SLOT_TICKS = [50, 5240, 10430, 15620, 20810, 26000];

/** 按键动作库：{label, funckey, keycode, group} */
const ACTIONS = (() => {
  const list = [];
  const add = (group, label, funckey, keycode = 0) => list.push({ group, label, funckey, keycode });

  add('鼠标', '左键', 0x01);
  add('鼠标', '右键', 0x02);
  add('鼠标', '中键', 0x04);
  add('鼠标', '后退', 0x08);
  add('鼠标', '前进', 0x10);
  add('鼠标', 'DPI +（加一档）', 0x08, 0x0005);
  add('鼠标', 'DPI −（减一档）', 0x08, 0x0006);
  add('鼠标', 'DIY 键', 0x0a);
  add('鼠标', '禁用此键', 0x07);

  for (let i = 0; i < 26; i++) add('键盘', String.fromCharCode(65 + i), 0x00, 0x04 + i);
  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  digits.forEach((d, i) => add('键盘', d, 0x00, 0x1e + i));
  add('键盘', 'Enter', 0x00, 0x28);
  add('键盘', 'Esc', 0x00, 0x29);
  add('键盘', 'Backspace', 0x00, 0x2a);
  add('键盘', 'Tab', 0x00, 0x2b);
  add('键盘', 'Space', 0x00, 0x2c);

  add('多媒体', '上一曲', 0x04, 0x00b6);
  add('多媒体', '下一曲', 0x04, 0x00b5);
  add('多媒体', '播放 / 暂停', 0x04, 0x00cd);
  add('多媒体', '停止', 0x04, 0x00b7);
  add('多媒体', '音量 +', 0x04, 0x00e9);
  add('多媒体', '音量 −', 0x04, 0x00ea);
  add('多媒体', '静音', 0x04, 0x00e2);

  add('系统', '显示桌面 (Win+D)', 0x02, 0x0708);
  add('系统', '锁定电脑 (Win+L)', 0x02, 0x0f08);
  return list;
})();

const actionKey = (a) => `${Number(a.funckey)}:${Number(a.keycode)}`;
const ACTION_BY_KEY = new Map(ACTIONS.map((a) => [actionKey(a), a]));

/* ============================ 工具 ============================ */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, body, method) {
  const opt = { method: method || (body === undefined ? 'GET' : 'POST'), headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function paintRange(el) {
  if (!el) return;
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const pct = ((Number(el.value) - min) / (max - min)) * 100;
  el.style.setProperty('--fill', `${pct}%`);
}

/** 线性 0..1 位置 ↔ 对数 DPI，让低 DPI 段也拉得动 */
const posToDpi = (p) => clamp(Math.round((DPI_MIN + (DPI_MAX - DPI_MIN) * clamp(p, 0, 1)) / 10) * 10, DPI_MIN, DPI_MAX);
const dpiToPos = (d) => (clamp(d, DPI_MIN, DPI_MAX) - DPI_MIN) / (DPI_MAX - DPI_MIN);

async function run(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const result = await fn();
    if (okMsg) toast(okMsg);
    return result;
  } catch (e) {
    toast(e.message || '操作失败', true);
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ============================ 状态 ============================ */

let state = null;
let theme = { mode: 'gray', dim: 0.35 };
let splitXY = localStorage.getItem('rapoolite.split') === '1';
let es = null;

/* ============================ 导航 ============================ */

function setTab(name) {
  document.querySelectorAll('.tab-item').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
  document.querySelectorAll('.tb-item').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('is-active', p.id === `tab-${name}`));
  document.body.dataset.tab = name;
  if (name !== 'home') localStorage.setItem('rapoolite.lastTab', name);
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
}

function bindNav() {
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  // 主页的玻璃卡片：点一下进设置
  const dock = document.getElementById('home-dock');
  if (dock) {
    dock.addEventListener('click', () => setTab('dpi'));
    dock.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setTab('dpi');
      }
    });
  }

  const back = document.getElementById('side-back');
  if (back) back.addEventListener('click', () => setTab('home'));
}

/* ============================ 主题 ============================ */

function applyTheme(t) {
  theme = { ...theme, ...t };
  document.body.dataset.theme = theme.mode || 'gray';
  // 图片模式下固定一层轻微压暗，保证玻璃上的文字可读（不再提供滑块）
  document.documentElement.style.setProperty('--dim', theme.mode === 'image' ? '0.28' : '0');
  const img = $('bg-img');
  if (theme.imageUrl) {
    img.style.backgroundImage = `url("${theme.imageUrl}")`;
  } else {
    img.style.backgroundImage = 'none';
  }
  renderPresets();
}

const SOLID_TILES = [
  { mode: 'black', name: '纯黑', swatch: 'linear-gradient(180deg,#111319,#05060a)' },
  { mode: 'gray', name: '深灰', swatch: 'linear-gradient(180deg,#3a3f4b,#22252d)' },
  { mode: 'light', name: '浅灰', swatch: 'linear-gradient(180deg,#dfe3ec,#b9bfcc)' },
];

function renderPresets() {
  const wrap = $('bg-presets');
  if (!wrap) return;
  const presets = theme.presets || [];
  const hint = $('bg-hint');
  if (hint) hint.textContent = presets.length ? `${presets.length + 3} 个可选` : '点一下切换';

  wrap.innerHTML = '';

  SOLID_TILES.forEach((tile) => {
    const card = document.createElement('button');
    card.className = 'preset preset-solid' + (theme.mode === tile.mode ? ' is-active' : '');
    card.innerHTML = `
      <span class="preset-swatch" style="background:${tile.swatch}"></span>
      <span class="preset-bar"><span class="preset-name">${tile.name}</span></span>`;
    card.addEventListener('click', async () => {
      await run(null, () => api('/api/theme', { mode: tile.mode }), null);
    });
    wrap.appendChild(card);
  });

  presets.forEach((preset) => {
    const card = document.createElement('div');
    card.className = 'preset' + (theme.mode === 'image' && theme.activeId === preset.id ? ' is-active' : '');
    card.innerHTML = `
      <div class="preset-thumb" style="background-image:url('${preset.url}')"></div>
      <div class="preset-bar"><span class="preset-name">${escapeHtml(preset.name)}</span>
      <button class="preset-del" title="删除">×</button></div>`;

    card.addEventListener('click', async (e) => {
      if (e.target.closest('.preset-del')) return;
      await run(null, () => api('/api/theme', { activeId: preset.id, mode: 'image' }), '背景已切换');
    });

    card.querySelector('.preset-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除背景「${preset.name}」？`)) return;
      await run(null, () => api(`/api/theme/presets?id=${preset.id}`, undefined, 'DELETE'), '已删除');
    });

    wrap.appendChild(card);
  });
}

async function uploadBackground(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return toast('图片过大（上限 20MB）', true);
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('读取图片失败'));
    fr.readAsDataURL(file);
  });
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 18) || '背景';
  await run(null, () => api('/api/theme/presets', { dataUrl, name }), `已添加「${name}」`);
}
async function loadTheme() {
  try {
    applyTheme(await api('/api/theme'));
  } catch {
    applyTheme({ mode: 'gray', presets: [] });
  }
}

function bindTheme() {
  const addBtn = $('bg-add');
  const fileInput = $('bg-file');
  if (addBtn && fileInput) {
    addBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        await uploadBackground(file);
      }
    });
  }


  // 支持把图片直接拖到背景页
  const page = $('tab-theme');
  if (page) {
    page.addEventListener('dragover', (e) => {
      e.preventDefault();
      page.classList.add('is-dragover');
    });
    page.addEventListener('dragleave', () => page.classList.remove('is-dragover'));
    page.addEventListener('drop', async (e) => {
      e.preventDefault();
      page.classList.remove('is-dragover');
      const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        await uploadBackground(file);
      }
    });
  }

  const themeBtn = $('btn-theme');
  if (themeBtn) themeBtn.addEventListener('click', () => setTab('theme'));
  const themeBack = $('theme-back');
  if (themeBack) themeBack.addEventListener('click', () => setTab('home'));
}

/* ============================ 主页 ============================ */

function renderHome(st) {
  const battery = st.battery >= 0 ? `${st.battery}%` : '—';
  const setText = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  setText('dock-battery', battery);
  setText('dock-link', st.connected ? '2.4G' : '未连接');

  // 电池图标随电量变化：填充高度 + 颜色
  const fill = document.getElementById('dock-batt-fill');
  if (fill) {
    const pct = st.battery >= 0 ? Math.min(100, Math.max(0, st.battery)) : 0;
    const innerH = 12;
    const bottom = 18.4;
    const hh = Math.max(1.6, (innerH * pct) / 100);
    fill.setAttribute('height', hh.toFixed(2));
    fill.setAttribute('y', (bottom - hh).toFixed(2));
  }
  const battIco = document.querySelector('.dock-ico.batt');
  if (battIco) {
    const color =
      st.battery < 0 ? '#9aa0b0' : st.battery > 35 ? '#f2f4f8' : st.battery > 15 ? '#f0a53a' : '#ff6b6b';
    battIco.style.color = color;
  }

  const dock = document.getElementById('home-dock');
  if (dock) dock.classList.toggle('is-offline', !st.connected);
}

/* ============================ 侧栏 ============================ */

function renderChrome(st) {
  $('device-name').textContent = st.model || 'VT3';
  $('device-sub').textContent = st.product || 'Rapoo Gaming Device';
  $('conn-dot').className = `dot ${st.connected ? 'on' : 'off'}`;
  $('conn-text').textContent = st.connected ? '已连接' : '未连接';
  $('chip-battery').textContent = st.battery >= 0 ? `电量 ${st.battery}%` : '电量 —';
  $('chip-hz').textContent = st.pollingHz ? `${st.pollingHz} Hz` : '— Hz';
  $('side-status').textContent = st.lastError ? st.lastError : st.connected ? '就绪' : '等待设备';
  const hzEl = $('side-hz');
  if (hzEl) hzEl.textContent = st.pollingHz ? `${st.pollingHz} Hz` : '— Hz';
  const slotBadge = $('side-slot');
  if (slotBadge) {
    slotBadge.textContent =
      st.slotCount && st.dpiIndex >= 0 ? `${st.dpiIndex + 1} / ${st.slotCount}` : '—';
  }
}

/* ============================ DPI ============================ */

const slotEls = [];

function buildSlot(index, split) {
  const el = document.createElement('div');
  el.className = 'slot';
  el.style.setProperty('--slot-color', SLOT_COLORS[index] || '#d8dbe2');
  el.innerHTML = `
    <div class="slot-top">
      <button class="slot-idx" title="设为当前档">${index + 1}</button>
      <span class="slot-label">档位 ${index + 1}</span>
      <input class="slot-value" type="number" min="${DPI_MIN}" max="${DPI_MAX}" step="10" />
    </div>
    <div class="slot-axis" data-axis="x"><span class="ax">${split ? 'X' : ''}</span><input class="range" type="range" min="0" max="1000" step="1" /></div>
    ${split ? '<div class="slot-axis" data-axis="y"><span class="ax">Y</span><input class="range" type="range" min="0" max="1000" step="1" /></div>' : ''}
    <div class="slot-ticks">${SLOT_TICKS.map((v) => `<span>${v}</span>`).join('')}</div>
  `;

  const idxBtn = el.querySelector('.slot-idx');
  const valueInput = el.querySelector('.slot-value');
  const xRange = el.querySelector('[data-axis="x"] .range');
  const yRange = el.querySelector('[data-axis="y"] .range');

  idxBtn.addEventListener('click', () => {
    if (!state) return;
    run(null, async () => {
      await api('/api/dpi', { dpiX: state.dpiX, dpiY: state.dpiY, slotCount: state.slotCount, dpiIndex: index });
      toast(`已切换到第 ${index + 1} 档`);
    });
  });

  const commit = async (dpiX, dpiY) => {
    if (!state) return;
    const xs = state.dpiX.slice();
    const ys = state.dpiY.slice();
    xs[index] = dpiX;
    ys[index] = split ? dpiY : dpiX;
    await run(null, async () => {
      await api('/api/dpi', { dpiX: xs, dpiY: ys, slotCount: state.slotCount, dpiIndex: state.dpiIndex });
      toast(`第 ${index + 1} 档已写入`);
    });
  };

  xRange.addEventListener('input', () => {
    const dpi = posToDpi(Number(xRange.value) / 1000);
    valueInput.value = String(dpi);
    paintRange(xRange);
  });
  xRange.addEventListener('change', () => {
    const dpi = posToDpi(Number(xRange.value) / 1000);
    const y = split ? Number(valueInput.dataset.y || dpi) : dpi;
    commit(dpi, y);
  });
  if (yRange) {
    yRange.addEventListener('input', () => {
      const dpi = posToDpi(Number(yRange.value) / 1000);
      valueInput.dataset.y = String(dpi);
      paintRange(yRange);
    });
    yRange.addEventListener('change', () => {
      const y = posToDpi(Number(yRange.value) / 1000);
      const x = state ? state.dpiX[index] : y;
      commit(x, y);
    });
  }
  valueInput.addEventListener('change', () => {
    const dpi = clamp(Math.round(Number(valueInput.value) / 10) * 10, DPI_MIN, DPI_MAX);
    valueInput.value = String(dpi);
    if (state) {
      const y = split ? Number(valueInput.dataset.y || dpi) : dpi;
      commit(dpi, y);
    }
  });

  slotEls[index] = { el, idxBtn, valueInput, xRange, yRange, split };
  return el;
}

function renderSlots(st) {
  const count = Math.max(1, Math.min(SLOT_MAX, st.slotCount || 4));
  const wrap = $('dpi-slots');
  if (wrap.dataset.count !== String(count) || wrap.dataset.split !== String(splitXY)) {
    wrap.innerHTML = '';
    slotEls.length = 0;
    for (let i = 0; i < count; i++) wrap.appendChild(buildSlot(i, splitXY));
    wrap.dataset.count = String(count);
    wrap.dataset.split = String(splitXY);
  }

  for (let i = 0; i < count; i++) {
    const s = slotEls[i];
    if (!s) continue;
    const x = st.dpiX[i] ?? 800;
    const y = st.dpiY[i] ?? x;
    if (document.activeElement !== s.valueInput) s.valueInput.value = String(x);
    s.valueInput.dataset.y = String(y);
    s.xRange.value = String(Math.round(dpiToPos(x) * 1000));
    paintRange(s.xRange);
    if (s.yRange) {
      if (document.activeElement !== s.yRange) s.yRange.value = String(Math.round(dpiToPos(y) * 1000));
      paintRange(s.yRange);
    }
    s.el.classList.toggle('is-current', i === st.dpiIndex);
  }
}

function renderDpiControls(st) {
  const seg = $('dpi-count');
  if (seg.dataset.count !== String(st.slotCount)) {
    seg.innerHTML = '';
    for (let n = 1; n <= SLOT_MAX; n++) {
      const b = document.createElement('button');
      b.textContent = String(n);
      b.classList.toggle('is-active', n === st.slotCount);
      b.addEventListener('click', () => {
        if (!state) return;
        const kept = state.dpiX.slice(0, n);
        while (kept.length < n) kept.push(800);
        const keptY = state.dpiY.slice(0, n);
        while (keptY.length < n) keptY.push(800);
        run(null, async () => {
          await api('/api/dpi', {
            dpiX: kept,
            dpiY: keptY,
            slotCount: n,
            dpiIndex: Math.min(state.dpiIndex, n - 1),
          });
          toast(`档位数量设为 ${n}`);
        });
      });
      seg.appendChild(b);
    }
    seg.dataset.count = String(st.slotCount);
  } else {
    [...seg.children].forEach((b, i) => b.classList.toggle('is-active', i + 1 === st.slotCount));
  }
  const split = $('split-xy');
  if (split.checked !== splitXY) split.checked = splitXY;
}

/* ============================ 性能 ============================ */

function renderPolling(st) {
  const seg = $('polling-seg');
  if (!seg.children.length) {
    for (const hz of POLLING_RATES) {
      const b = document.createElement('button');
      b.textContent = String(hz);
      b.addEventListener('click', () => {
        if (!state || state.pollingHz === hz) return;
        run(b, async () => {
          await api('/api/polling', { hz });
          toast(`回报率已切换到 ${hz} Hz`);
        });
      });
      seg.appendChild(b);
    }
  }
  [...seg.children].forEach((b) => b.classList.toggle('is-active', Number(b.textContent) === st.pollingHz));
  $('perf-hz').textContent = st.pollingHz ? `${st.pollingHz} Hz` : '—';
}

function renderScan(st) {
  const seg = $('scan-seg');
  if (!seg.children.length) {
    for (const hz of KEY_SCAN_RATES) {
      const b = document.createElement('button');
      b.textContent = String(hz);
      b.addEventListener('click', () => {
        if (!state || state.keyScanningRate === hz) return;
        run(b, async () => {
          await api('/api/setting', { key: 'keyScanningRate', value: hz });
          toast(`按键扫描率已设为 ${hz} Hz`);
        });
      });
      seg.appendChild(b);
    }
  }
  [...seg.children].forEach((b) => b.classList.toggle('is-active', Number(b.textContent) === st.keyScanningRate));
}

function renderPerf(st) {
  const wrap = $('perf-cards');
  const allowed = PERF_MODES_BY_POLLING[st.pollingHz] || ['low', 'hp', 'sport', 'oc'];
  const sig = `${st.pollingHz}|${st.performanceMode}|${allowed.join(',')}`;
  if (wrap.dataset.sig !== sig) {
    wrap.innerHTML = '';
    for (const mode of allowed) {
      const b = document.createElement('button');
      b.className = `mode-card${mode === st.performanceMode ? ' is-active' : ''}`;
      b.innerHTML = `<b>${PERF_LABEL[mode]}</b><span>${PERF_DESC[mode] || ''}</span>`;
      b.addEventListener('click', () => {
        if (!state || state.performanceMode === mode) return;
        run(b, async () => {
          await api('/api/perf', { mode });
          toast(`性能模式：${PERF_LABEL[mode]}`);
        });
      });
      wrap.appendChild(b);
    }
    wrap.dataset.sig = sig;
  }
  $('perf-tip').textContent =
    st.pollingHz >= 2000 ? '当前回报率下「低功耗」模式不可用。' : '高回报率下「低功耗」模式不可用。';
}

/* ============================ 按键 ============================ */

function renderButtons(st) {
  const wrap = $('btn-rows');
  const list = st.buttons || [];
  if (!list.length) {
    wrap.innerHTML = '<p class="tip">还没有读到按键。点右上角「重新读取」。</p>';
    return;
  }
  const sig = list.map((b) => `${b.index}:${Number(b.funckey)}:${Number(b.keycode)}`).join('|');
  if (wrap.dataset.sig === sig) return;

  wrap.innerHTML = '';
  for (const b of list) {
    const row = document.createElement('div');
    row.className = 'btn-row';

    const name = document.createElement('span');
    name.className = 'btn-name';
    name.textContent = BUTTON_NAMES[b.index] || `按键 ${b.index}`;

    const select = document.createElement('select');
    select.className = 'select';
    const key = actionKey(b);
    let matched = false;
    for (const group of ['鼠标', '键盘', '多媒体', '系统']) {
      const items = ACTIONS.filter((a) => a.group === group);
      if (!items.length) continue;
      const og = document.createElement('optgroup');
      og.label = group;
      for (const a of items) {
        const opt = document.createElement('option');
        opt.value = actionKey(a);
        opt.textContent = a.label;
        if (actionKey(a) === key) {
          opt.selected = true;
          matched = true;
        }
        og.appendChild(opt);
      }
      select.appendChild(og);
    }
    if (!matched) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `未知功能 (0x${Number(b.funckey).toString(16)})`;
      opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      const action = ACTION_BY_KEY.get(select.value);
      if (!action) return;
      run(null, async () => {
        await api('/api/button', { index: b.index, funckey: action.funckey, keycode: action.keycode });
        toast(`${BUTTON_NAMES[b.index] || '按键'} → ${action.label}`);
      });
    });

    row.append(name, select);
    wrap.appendChild(row);
  }
  wrap.dataset.sig = sig;
}

/* ============================ 高级 ============================ */

function bindAdvanced() {
  const lod = $('lod');
  lod.addEventListener('input', () => {
    $('lod-value').textContent = `${((Number(lod.value) + 6) / 10).toFixed(1)} mm`;
    paintRange(lod);
  });
  lod.addEventListener('change', () =>
    run(null, () => api('/api/setting', { key: 'lodLevel', value: Number(lod.value) }), '静默高度已更新')
  );

  const debounce = $('debounce');
  debounce.addEventListener('input', () => {
    $('debounce-value').textContent = `${debounce.value} ms`;
    paintRange(debounce);
  });
  debounce.addEventListener('change', () =>
    run(null, () => api('/api/setting', { key: 'debounceMs', value: Number(debounce.value) }), '去抖时间已更新')
  );

  const lift = $('lift');
  lift.addEventListener('input', () => {
    $('lift-value').textContent = `${lift.value} ms`;
    paintRange(lift);
  });
  lift.addEventListener('change', () =>
    run(null, () => api('/api/setting', { key: 'liftDelayMs', value: Number(lift.value) }), '抬起延迟已更新')
  );

  const sleep = $('sleep');
  sleep.addEventListener('input', () => {
    $('sleep-value').textContent = `${sleep.value} 分钟`;
    paintRange(sleep);
  });
  sleep.addEventListener('change', () =>
    run(null, () => api('/api/setting', { key: 'sleepMinutes', value: Number(sleep.value) }), '休眠时间已更新')
  );

  const toggles = [
    ['motion-sync', 'motionSync', '移动同步'],
    ['linear', 'linearCorrection', '直线修正'],
    ['ripple', 'rippleControl', '波纹控制'],
    ['glass', 'glassMode', '玻璃模式'],
    ['led-low', 'ledLowBattery', '低电量指示灯'],
  ];
  for (const [id, key, label] of toggles) {
    $(id).addEventListener('change', (e) =>
      run(null, () => api('/api/setting', { key, value: e.target.checked }), `${label}${e.target.checked ? '已开启' : '已关闭'}`)
    );
  }

  document.querySelectorAll('#wireless-seg button').forEach((b) => {
    b.addEventListener('click', () => {
      if (!state || state.wirelessStrategy === b.dataset.value) return;
      run(null, () => api('/api/setting', { key: 'wirelessStrategy', value: b.dataset.value }), `无线策略：${b.textContent}`);
    });
  });

  const autostart = $('autostart');
  autostart.addEventListener('change', async () => {
    const want = autostart.checked;
    const r = await run(null, () => api('/api/autostart', { enabled: want }), want ? '已开启开机自启' : '已关闭开机自启');
    if (r) {
      autostart.checked = !!r.enabled;
      if (r.enabled && r.method === 'startup-folder') toast('已写入「启动」文件夹快捷方式');
    } else {
      // 失败时把开关拨回实际状态
      autostart.checked = !want;
      try {
        const now = await api('/api/autostart');
        autostart.checked = !!now.enabled;
      } catch {}
    }
  });
  api('/api/autostart')
    .then((r) => {
      autostart.checked = !!r.enabled;
    })
    .catch(() => {});

  const uninstall = $('btn-uninstall');
  if (uninstall) {
    uninstall.addEventListener('click', async () => {
      const ok = window.confirm(
        '确定要卸载 RapooLite 吗？\n\n会移除程序本体、开始菜单快捷方式和开机自启。\n你的背景图与设置会保留在安装目录的 data 文件夹里。'
      );
      if (!ok) return;
      // 优先交给宿主程序处理（它能复制自身到临时目录、等主进程退出后再调 msiexec）
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: 'app', action: 'uninstall' });
        return;
      }
      try {
        const r = await api('/api/uninstall', {});
        if (r && r.ok) {
          uninstall.textContent = '正在卸载…';
        } else {
          toast((r && r.error) || '卸载失败', true);
        }
      } catch (err) {
        toast('卸载失败：' + (err && err.message), true);
      }
    });
  }

  $('btn-read').addEventListener('click', (e) =>
    run(e.currentTarget, async () => {
      const r = await api('/api/buttons');
      if (state) state.buttons = r.buttons;
      const wrap = $('btn-rows');
      wrap.dataset.sig = '';
      renderButtons(state || { buttons: r.buttons });
      toast('按键已重新读取');
    })
  );
}

function renderAdvanced(st) {
  const setRange = (id, value, label) => {
    const el = $(id);
    if (document.activeElement !== el) el.value = String(value);
    if (label !== undefined) $(`${id}-value`).textContent = label;
    paintRange(el);
  };
  setRange('lod', st.lodLevel || 1, `${(st.lodMm ?? (st.lodLevel || 1) * 0.1 + 0.6).toFixed(1)} mm`);
  setRange('debounce', st.debounceMs ?? 4, `${st.debounceMs ?? 4} ms`);
  setRange('lift', st.liftDelayMs ?? 8, `${st.liftDelayMs ?? 8} ms`);
  setRange('sleep', Math.round((st.sleepSeconds || 600) / 60), `${Math.round((st.sleepSeconds || 600) / 60)} 分钟`);

  $('motion-sync').checked = !!st.motionSync;
  $('linear').checked = !!st.linearCorrection;
  $('ripple').checked = !!st.rippleControl;
  $('glass').checked = !!st.glassMode;
  $('led-low').checked = !!st.ledLowBattery;

  document.querySelectorAll('#wireless-seg button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.value === st.wirelessStrategy);
  });
  $('wireless-value').textContent = st.wirelessStrategy === 'full' ? '全速' : '省电';
}

function renderLogs(logs) {
  const el = $('logs');
  if (!logs) return;
  el.textContent = logs.join('\n');
  el.scrollTop = el.scrollHeight;
}

/* ============================ 总渲染 ============================ */

function applyState(st, logs) {
  if (!st) return;
  state = st;
  renderChrome(st);
  renderHome(st);
  renderDpiControls(st);
  renderSlots(st);
  renderPolling(st);
  renderPerf(st);
  renderScan(st);
  renderButtons(st);
  renderAdvanced(st);
  renderLogs(logs);
}

/* ============================ 窗口控制 ============================ */

const isNative = () => !!(window.chrome && window.chrome.webview);

function bindWindow() {
  const send = (action) => {
    if (isNative()) window.chrome.webview.postMessage(JSON.stringify({ type: 'window', action }));
  };
  $('win-min').addEventListener('click', () => send('minimize'));
  $('win-max').addEventListener('click', () => send('maximize'));
  $('win-close').addEventListener('click', () => send('close'));

  // 顶栏空白处可拖动窗口，双击切换最大化
  const topbar = $('topbar');
  topbar.addEventListener('mousedown', (e) => {
    if (!isNative() || e.button !== 0) return;
    if (e.target.closest('button, input, select, a')) return;
    send('drag');
  });
  topbar.addEventListener('dblclick', (e) => {
    if (!isNative()) return;
    if (e.target.closest('button, input, select, a')) return;
    send('maximize');
  });

  if (!isNative() && !STATIC) {
    // 浏览器里没有原生窗控，隐藏即可
    $('winbtns').style.display = 'none';
  }
  $('btn-refresh').addEventListener('click', (e) =>
    run(e.currentTarget, async () => {
      const r = await api('/api/refresh', {});
      applyState(r.state);
      toast('已重新读取设备');
    })
  );
  $('split-xy').addEventListener('change', (e) => {
    splitXY = e.target.checked;
    localStorage.setItem('rapoolite.split', splitXY ? '1' : '0');
    const wrap = $('dpi-slots');
    wrap.dataset.count = '';
    wrap.innerHTML = '';
    slotEls.length = 0;
    if (state) applyState(state);
  });
}

/* ============================ 启动 ============================ */

function connectEvents() {
  if (STATIC) return;
  es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') applyState(msg.state);
      if (msg.type === 'theme') applyTheme(msg.theme);
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    /* 浏览器会自动重连 */
  };
}

async function boot() {
  bindNav();
  bindTheme();
  bindWindow();
  bindAdvanced();
  document.querySelectorAll('input.range').forEach(paintRange);

  const tab = PARAMS.get('tab');
  setTab(tab && ['home', 'dpi', 'perf', 'buttons', 'advanced', 'theme'].includes(tab) ? tab : 'home');

  if (PARAMS.get('split') === '1') {
    splitXY = true;
    $('split-xy').checked = true;
  }

  await loadTheme();

  try {
    const data = await api('/api/state');
    applyState(data.state, data.logs);
  } catch (err) {
    toast('读取设备状态失败：' + (err && err.message), true);
    console.error(err);
  }

  connectEvents();

  // 没有实时推送时兜底刷新一次
  if (STATIC) return;
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const data = await api('/api/state');
      applyState(data.state, data.logs);
    } catch {
      /* ignore */
    }
  }, 10000);
}

boot();
