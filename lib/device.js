'use strict';

const { EventEmitter } = require('node:events');
const HID = require('node-hid');
const { RapooHid, sleep } = require('./hid');
const P = require('./protocol');

const BATTERY_USAGE = 0x02;

/**
 * 设备状态与会话管理。所有写操作都在写完后回读校验。
 */
class Device extends EventEmitter {
  constructor(log = () => {}) {
    super();
    this.log = log;
    this.hid = new RapooHid(log);
    this.batteryDev = null;
    this.state = {
      connected: false,
      model: 'VT3',
      product: 'Rapoo Gaming Device',
      serial: '',
      battery: -1,
      pollingHz: null,
      performanceMode: null,
      keyScanningRate: null,
      lodLevel: null,
      lodMm: null,
      motionSync: null,
      linearCorrection: null,
      rippleControl: null,
      glassMode: null,
      sensorAngle: null,
      debounceMs: null,
      liftDelayMs: null,
      sleepSeconds: null,
      wirelessStrategy: null,
      slotCount: 4,
      dpiIndex: 0,
      dpiX: [],
      dpiY: [],
      ledLowBattery: null,
      buttons: [],
      capabilities: {
        pollingRates: P.POLLING_RATES,
        dpiMin: P.DPI_MIN,
        dpiMax: P.DPI_MAX,
        dpiSlotMax: P.DPI_SLOT_MAX,
        dpiStep: P.DPI_STEP,
        perfModesByPolling: P.PERF_MODES_BY_POLLING,
        perfModeLabel: P.PERF_MODE_LABEL,
      },
      lastError: null,
      updatedAt: 0,
    };
  }

  _set(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (JSON.stringify(this.state[k]) !== JSON.stringify(v)) {
        this.state[k] = v;
        changed = true;
      }
    }
    if (changed) {
      this.state.updatedAt = Date.now();
      this.emit('state', this.state);
    }
  }

  _openBatteryChannel() {
    const found = RapooHid.find();
    const target = found?.all.find((d) => d.usagePage === 0xff00 && d.usage === BATTERY_USAGE);
    if (!target) return;
    try {
      this.batteryDev = new HID.HID(target.path);
      this.batteryDev.on('data', (raw) => this._onBatteryPacket(raw));
      this.batteryDev.on('error', (e) => this.log('battery device error: ' + e.message));
    } catch (e) {
      this.log('battery channel open failed: ' + e.message);
    }
  }

  _onBatteryPacket(raw) {
    const data = Array.from(raw);
    // 该集合只有 report 7，node-hid 会在首位带上 report id
    const body = data[0] === 0x07 ? data.slice(1) : data;
    if (body.length < 11) return;

    const patch = {};

    // 电量
    const battery = body[7];
    if (Number.isInteger(battery) && battery >= 0 && battery <= 100 && battery !== this.state.battery) {
      patch.battery = battery;
    }

    // 档位数：body[9] 是 code，真实档位数 = code + 1
    const slotCount = (body[9] & 0x0f) + 1;
    if (slotCount >= 1 && slotCount <= P.DPI_SLOT_MAX && slotCount !== this.state.slotCount) {
      patch.slotCount = slotCount;
    }

    // 当前档位：按鼠标上的 DPI+ / DPI- 时设备会主动广播这一包
    // 实测报文：07 10 <idx> <dpiX lo hi> <dpiY lo hi> 00 <电量> 00 <档位code> <回报率code> ...
    const idx = body[1];
    const nextIdx = Number.isInteger(idx) && idx >= 0 && idx < P.DPI_SLOT_MAX ? idx : null;
    if (nextIdx !== null && nextIdx !== this.state.dpiIndex) {
      patch.dpiIndex = nextIdx;
    }

    // 当前档的 X / Y 值（用户可能直接用鼠标改过 DPI）
    const x = body[2] | (body[3] << 8);
    const y = body[4] | (body[5] << 8);
    const inRange = (v) => v >= P.DPI_MIN && v <= P.DPI_MAX;
    if (nextIdx !== null && inRange(x) && inRange(y)) {
      const count = Math.max(patch.slotCount || this.state.slotCount || 1, nextIdx + 1);
      if (this.state.dpiX[nextIdx] !== x || this.state.dpiY[nextIdx] !== y) {
        const dpiX = this.state.dpiX.slice();
        const dpiY = this.state.dpiY.slice();
        while (dpiX.length < count) dpiX.push(800);
        while (dpiY.length < count) dpiY.push(800);
        dpiX[nextIdx] = x;
        dpiY[nextIdx] = y;
        patch.dpiX = dpiX;
        patch.dpiY = dpiY;
      }
    }

    // 休眠唤醒/参数不全时补一次全量读取（10 秒内最多一次）
    const incomplete = this.state.performanceMode == null || this.state.keyScanningRate == null;
    if (incomplete && !this._wakeRefreshAt) {
      this._wakeRefreshAt = Date.now();
      setTimeout(() => {
        this._wakeRefreshAt = 0;
        this.refresh().catch(() => {});
      }, 1500);
    } else if (incomplete && Date.now() - this._wakeRefreshAt > 10000) {
      this._wakeRefreshAt = Date.now();
      setTimeout(() => {
        this._wakeRefreshAt = 0;
        this.refresh().catch(() => {});
      }, 1500);
    }

    const polling = P.pollingFromCode(body[10]);
    if (polling && polling !== this.state.pollingHz) {
      patch.pollingHz = polling;
      // 性能模式的寄存器地址跟着回报率走，回报率一变就整体重读一次
      if (this._pollRefreshTimer) clearTimeout(this._pollRefreshTimer);
      this._pollRefreshTimer = setTimeout(() => {
        this._pollRefreshTimer = null;
        this.refresh().catch(() => {});
      }, 500);
    }

    if (!Object.keys(patch).length) return;
    if (patch.dpiIndex !== undefined) {
      this.log(`鼠标切换档位 → 第 ${patch.dpiIndex + 1} 档`);
    }
    this._set(patch);
  }

  async connect() {
    if (this.hid.connected) return this.state;
    const info = this.hid.open();
    this._openBatteryChannel();
    this._set({ connected: true, product: info.product, serial: info.serial, lastError: null });
    return this.state;
  }

  disconnect() {
    this.hid.close();
    if (this.batteryDev) {
      try {
        this.batteryDev.close();
      } catch {
        /* ignore */
      }
      this.batteryDev = null;
    }
    this._set({ connected: false });
    this.emit('disconnect');
  }

  /** 全量读取设备当前配置。 */
  async refresh() {
    if (!this.hid.connected) await this.connect();
    const patch = {};

    const pollingCode = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.pollingHz);
    const pollingHz = P.pollingFromCode(pollingCode);
    if (pollingHz) patch.pollingHz = pollingHz;

    const perfCode = await this.hid.readU8(P.BANKS.SYSTEM, P.perfAddr(pollingHz ?? 1000));
    patch.performanceMode = P.PERF_CODE_MODE.get(perfCode) ?? null;

    const scanCode = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.keyScanningRate);
    patch.keyScanningRate = P.KEY_SCAN_HZ.get(scanCode) ?? null;

    const lodCode = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.lodHeight);
    patch.lodLevel = lodCode;
    patch.lodMm = Math.round(((lodCode + 6) / 10) * 10) / 10;

    patch.motionSync = (await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.motionSync)) === 0x01;
    patch.glassMode = (await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.glassMode)) === 0x01;

    const ripple = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.linearRipple);
    patch.linearCorrection = (ripple & 0x01) === 0x00;
    patch.rippleControl = (ripple & 0x02) === 0x00;

    patch.sensorAngle = P.i8(await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.sensorAngle));
    patch.debounceMs = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.debounceMs);
    patch.liftDelayMs = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.liftDelayMs);
    patch.sleepSeconds = (await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.sleepTime)) * 60;

    const ws = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.wirelessStrategy);
    patch.wirelessStrategy = ws === 0x01 ? 'full' : 'smart';

    const cp = await this.hid.readU8(P.BANKS.COMM, P.ADDR.commProtocol);
    patch.commProtocol = cp === 0x00 ? 'efficient' : 'initial';

    const countCode = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.currentSlotCount);
    const slotCount = P.clamp(countCode + 1, 1, P.DPI_SLOT_MAX);
    patch.slotCount = slotCount;

    const idxRaw = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.currentDpiIndex);
    patch.dpiIndex = P.clamp(idxRaw, 0, slotCount - 1);

    const tableX = await this.hid.read(P.BANKS.SYSTEM, P.ADDR.dpiTableX, slotCount * 2);
    const tableY = await this.hid.read(P.BANKS.SYSTEM, P.ADDR.dpiTableY, slotCount * 2);
    const xs = P.decodeU16le(tableX, slotCount);
    const ys = P.decodeU16le(tableY, slotCount);
    patch.dpiX = xs;
    patch.dpiY = ys;

    this._set(patch);
    return this.state;
  }

  async readButtons() {
    if (!this.hid.connected) await this.connect();
    const prev = this.state.buttons || [];
    const buttons = [];
    let okCount = 0;

    for (const [index, addr] of Object.entries(P.BUTTON_ADDR)) {
      let action = null;
      for (let attempt = 0; attempt < 3 && !action; attempt += 1) {
        try {
          const bytes = await this.hid.read(P.BANKS.BUTTON, addr, 4);
          const raw = Array.from(bytes).slice(0, 4);
          const blank = raw.every((x) => x === 0) || raw[0] === 0xff;
          if (!blank) {
            action = decodeButton(bytes);
            okCount += 1;
          }
        } catch (e) {
          this.log(`button ${index} read failed: ${e.message}`);
        }
        if (!action) await sleep(40);
      }

      if (!action) {
        const old = prev.find((b) => b.index === Number(index));
        action = old
          ? { funckey: old.funckey, keycode: old.keycode, raw: old.raw }
          : { funckey: 0, keycode: 0, raw: null };
      }
      buttons.push({ index: Number(index), addr, ...action });
    }

    // 一个都没读到（多半是设备休眠）：保留原值，不要把空表写进状态
    if (!okCount) {
      this.log('按键读取失败：设备可能处于休眠状态');
      return prev;
    }

    this._set({ buttons });
    return buttons;
  }

  async setPolling(hz) {
    const code = P.pollingCode(hz);
    await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.pollingHz, code);
    await sleep(120);
    const back = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.pollingHz);
    if (back !== code) {
      // 切换回报率后设备可能短暂忙，再等一次
      await sleep(180);
      const retry = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.pollingHz);
      if (retry !== code) throw new Error(`回报率写入校验失败（写入 ${hz}Hz，读回码 0x${retry.toString(16)}）`);
    }
    this._set({ pollingHz: Number(hz) });
    return this.state.pollingHz;
  }

  async setPerformanceMode(mode) {
    const code = P.PERF_MODE_CODE.get(String(mode).toLowerCase());
    if (code === undefined) throw new Error(`未知性能模式：${mode}`);
    const hz = this.state.pollingHz ?? 1000;
    await this.hid.writeU8(P.BANKS.SYSTEM, P.perfAddr(hz), code);
    await sleep(30);
    const back = await this.hid.readU8(P.BANKS.SYSTEM, P.perfAddr(hz));
    if (back !== code) throw new Error(`性能模式写入校验失败（码 0x${back.toString(16)}）`);
    this._set({ performanceMode: mode });
    return mode;
  }

  async setKeyScanningRate(hz) {
    const code = P.KEY_SCAN_CODE.get(Number(hz));
    if (code === undefined) throw new Error(`不支持的按键扫描率：${hz}`);
    await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.keyScanningRate, code);
    await sleep(30);
    const back = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.keyScanningRate);
    if (back !== code) throw new Error('按键扫描率写入校验失败');
    this._set({ keyScanningRate: Number(hz) });
    return hz;
  }

  /** DPI 表写入：X 表 → Y 表 → 档位数 → 当前档位。 */
  async setDpi({ dpiX, dpiY, slotCount, dpiIndex }) {
    const count = P.clamp(slotCount ?? this.state.slotCount, 1, P.DPI_SLOT_MAX);
    const xs = fillTable(dpiX ?? this.state.dpiX, count);
    const ys = fillTable(dpiY ?? this.state.dpiY, count);
    const idx = P.clamp(dpiIndex ?? this.state.dpiIndex, 0, count - 1);

    await this.hid.write(P.BANKS.SYSTEM, P.ADDR.dpiTableX, P.dpiTableBytes(xs, count));
    await sleep(12);
    await this.hid.write(P.BANKS.SYSTEM, P.ADDR.dpiTableY, P.dpiTableBytes(ys, count));
    await sleep(12);
    await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.currentSlotCount, count - 1);
    await sleep(11);
    await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.currentDpiIndex, idx);
    await sleep(30);

    // 回读校验
    const tableX = await this.hid.read(P.BANKS.SYSTEM, P.ADDR.dpiTableX, count * 2);
    const tableY = await this.hid.read(P.BANKS.SYSTEM, P.ADDR.dpiTableY, count * 2);
    const backX = P.decodeU16le(tableX, count);
    const backY = P.decodeU16le(tableY, count);
    const backCount = P.clamp((await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.currentSlotCount)) + 1, 1, P.DPI_SLOT_MAX);
    const backIdx = P.clamp(await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.currentDpiIndex), 0, backCount - 1);

    if (JSON.stringify(backX) !== JSON.stringify(xs) || JSON.stringify(backY) !== JSON.stringify(ys)) {
      throw new Error(`DPI 回读不一致：写入 X=${xs.join(',')} 读回 X=${backX.join(',')}`);
    }
    this._set({ dpiX: backX, dpiY: backY, slotCount: backCount, dpiIndex: backIdx });
    return { dpiX: backX, dpiY: backY, slotCount: backCount, dpiIndex: backIdx };
  }

  async setSetting(key, value) {
    const v = value;
    switch (key) {
      case 'lodLevel': {
        const level = P.clamp(v, 1, 11);
        await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.lodHeight, level);
        await this._verifyU8(P.ADDR.lodHeight, level, '静默高度');
        this._set({ lodLevel: level, lodMm: Math.round(((level + 6) / 10) * 10) / 10 });
        break;
      }
      case 'motionSync': {
        const on = v ? 1 : 0;
        await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.motionSync, on);
        await this._verifyU8(P.ADDR.motionSync, on, 'Motion Sync');
        this._set({ motionSync: Boolean(v) });
        break;
      }
      case 'glassMode': {
        const on = v ? 1 : 0;
        await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.glassMode, on);
        await this._verifyU8(P.ADDR.glassMode, on, '玻璃模式');
        this._set({ glassMode: Boolean(v) });
        break;
      }
      case 'linearCorrection': {
        const next = { linearCorrection: Boolean(v), rippleControl: this.state.rippleControl };
        await this._writeRipple(next);
        this._set({ linearCorrection: Boolean(v) });
        break;
      }
      case 'rippleControl': {
        const next = { linearCorrection: this.state.linearCorrection, rippleControl: Boolean(v) };
        await this._writeRipple(next);
        this._set({ rippleControl: Boolean(v) });
        break;
      }
      case 'sensorAngle': {
        const angle = P.clamp(v, -30, 30);
        await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.sensorAngle, angle & 0xff);
        this._set({ sensorAngle: angle });
        break;
      }
      case 'debounceMs': {
        const ms = P.clamp(v, 0, 255);
        await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.debounceMs, ms);
        await this._verifyU8(P.ADDR.debounceMs, ms, '去抖时间');
        this._set({ debounceMs: ms });
        break;
      }
      case 'liftDelayMs': {
        const ms = P.clamp(v, 0, 255);
        await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.liftDelayMs, ms);
        await this._verifyU8(P.ADDR.liftDelayMs, ms, '抬起延迟');
        this._set({ liftDelayMs: ms });
        break;
      }
      case 'sleepMinutes': {
        const min = P.clamp(v, 2, 120);
        await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.sleepTime, min);
        await this._verifyU8(P.ADDR.sleepTime, min, '休眠时间');
        this._set({ sleepSeconds: min * 60 });
        break;
      }
      case 'wirelessStrategy': {
        const code = String(v) === 'full' ? 0x01 : 0x00;
        await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.wirelessStrategy, code);
        this._set({ wirelessStrategy: code ? 'full' : 'smart' });
        break;
      }
      case 'ledLowBattery': {
        const on = v ? 1 : 0;
        await this.hid.write(P.BANKS.SYSTEM, P.ADDR.ledLowBattery, [0x01, on, 0x00, on ? 0x0f : 0xff]);
        this._set({ ledLowBattery: Boolean(v) });
        break;
      }
      case 'keyScanningRate': {
        const hz = Number(v);
        const code = P.KEY_SCAN_CODE.get(hz);
        if (code === undefined) throw new Error(`不支持的按键扫描率：${hz}`);
        await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.keyScanningRate, code);
        await this._verifyU8(P.ADDR.keyScanningRate, code, '按键扫描率');
        this._set({ keyScanningRate: hz });
        break;
      }
      case 'commProtocol': {
        const code = String(v) === 'efficient' ? 0x00 : 0x02;
        await this.hid.writeU8(P.BANKS.COMM, P.ADDR.commProtocol, code);
        this._set({ commProtocol: code ? 'initial' : 'efficient' });
        break;
      }
      default:
        throw new Error(`未知设置项：${key}`);
    }
    return this.state;
  }

  async _verifyU8(addr, expect, label) {
    await sleep(30);
    const back = await this.hid.readU8(P.BANKS.SYSTEM, addr);
    if (back !== expect) throw new Error(`${label}写入校验失败（期望 0x${expect.toString(16)}，读回 0x${back.toString(16)}）`);
    return true;
  }

  async _writeRipple(next) {
    // bit0 = 直线修正（0 开）、bit1 = 波形修正（0 开）
    const value = (next.linearCorrection ? 0 : 1) | (next.rippleControl ? 0 : 2);
    await this.hid.writeU8(P.BANKS.SYSTEM, P.ADDR.linearRipple, value);
    await sleep(30);
    const back = await this.hid.readU8(P.BANKS.SYSTEM, P.ADDR.linearRipple);
    if (back !== value) throw new Error('直线/波形修正写入校验失败');
  }

  async setButton(index, action) {
    const addr = P.BUTTON_ADDR[index];
    if (addr === undefined) throw new Error(`未知按键编号：${index}`);
    const bytes = encodeButton(action);
    await this.hid.write(P.BANKS.BUTTON, addr, bytes);
    await sleep(40);
    const back = await this.hid.read(P.BANKS.BUTTON, addr, 4);
    if (JSON.stringify(Array.from(back).slice(0, 4)) !== JSON.stringify(bytes)) {
      throw new Error(`按键写入校验失败（读回 ${Array.from(back).slice(0, 4).map((b) => b.toString(16)).join(' ')}）`);
    }
    const buttons = this.state.buttons.slice();
    const at = buttons.findIndex((b) => b.index === index);
    const entry = { index: Number(index), addr, ...decodeButton(bytes) };
    if (at >= 0) buttons[at] = entry;
    else buttons.push(entry);
    this._set({ buttons });
    return entry;
  }
}

function fillTable(values, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(P.clamp(values[i] ?? 800, P.DPI_MIN, P.DPI_MAX));
  return out;
}

/**
 * 按键映射解码：4 字节 payload -> { funckey, keycode }
 * 0x03 鼠标键、0x00 键盘键、0x08 DPI、0x04 多媒体、0x02 组合键
 */
function decodeButton(bytes) {
  const [b0, b1, b2, b3] = Array.from(bytes).slice(0, 4);
  if (b0 === 0x03) return { funckey: b2, keycode: 0, raw: [b0, b1, b2, b3] };
  if (b0 === 0x00) return { funckey: 0, keycode: b2, raw: [b0, b1, b2, b3] };
  if (b0 === 0x08) return { funckey: 0x08, keycode: b2, raw: [b0, b1, b2, b3] };
  if (b0 === 0x04) return { funckey: 0x04, keycode: (b2 << 8) | b3, raw: [b0, b1, b2, b3] };
  if (b0 === 0x02) return { funckey: 0x02, keycode: (b1 << 8) | b2, raw: [b0, b1, b2, b3] };
  return { funckey: b0, keycode: (b2 << 8) | b3, raw: [b0, b1, b2, b3] };
}

function encodeButton(action) {
  const fk = action?.funckey ?? 0;
  const kc = P.clamp(action?.keycode ?? 0, 0, 0xffff);
  const hi = (kc >> 8) & 0xff;
  const lo = kc & 0xff;
  if (kc === 0 && [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x07].includes(fk)) return [0x03, 0x00, fk, 0x00];
  if (fk === 0x00) return [0x00, 0x00, lo, 0x00];
  if (fk === 0x08) return [0x08, 0x00, lo, 0x00];
  if (fk === 0x04) return [0x04, 0x00, hi, lo];
  if (fk === 0x02) return [0x02, hi, lo, 0x00];
  return [fk, 0x00, hi, lo];
}

module.exports = { Device, decodeButton, encodeButton };
