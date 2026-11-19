'use strict';

/**
 * 雷柏（Rapoo）54L 系列 HID 配置协议。
 *
 * 帧格式（经 output report 6 下发，32 字节）：
 *   写  A5 A5 <len> <addr> <bank> 00 00 <data...>
 *   读  A5 A4 <len> <addr> <bank> 00 00 00
 * 应答经 feature report 8 读回：01 00 00 00 <data...>，后续为 len 个有效字节。
 */

const BANKS = Object.freeze({
  COMM: 0x00,
  SYSTEM: 0x08,
  BUTTON: 0x06,
});

const ADDR = Object.freeze({
  commProtocol: 0x60,
  pollingHz: 0x80,
  keyScanningRate: 0x81,
  lodHeight: 0x84,
  motionSync: 0x85,
  dpiTableX: 0x88,
  currentSlotCount: 0x96,
  currentDpiIndex: 0x98,
  debounceMs: 0xc0,
  liftDelayMs: 0xc1,
  sleepTime: 0xc2,
  linearRipple: 0xc3,
  sensorAngle: 0xc4,
  glassMode: 0xc5,
  dpiTableY: 0xc8,
  ledLowBattery: 0xd8,
  wirelessStrategy: 0xd8,
});

const BUTTON_ADDR = Object.freeze({
  1: 0x00, // 左键
  2: 0x08, // 右键
  3: 0x04, // 中键
  4: 0x14, // 前进
  5: 0x18, // 后退
  6: 0x0c, // DPI +
  7: 0x10, // DPI −
  8: 0x34, // DIY 键
});

const POLLING_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

const POLLING_CODE = new Map([
  [125, 0x08],
  [250, 0x04],
  [500, 0x02],
  [1000, 0x01],
  [2000, 0x84],
  [4000, 0x82],
  [8000, 0x81],
]);

const PERF_ADDR = new Map([
  [125, 0xdc],
  [250, 0xdd],
  [500, 0xde],
  [1000, 0xdf],
  [2000, 0xe0],
  [4000, 0xe1],
  [8000, 0xe2],
]);

const PERF_MODES_BY_POLLING = Object.freeze({
  125: ['low'],
  250: ['low'],
  500: ['low', 'hp'],
  1000: ['low', 'hp', 'sport', 'oc'],
  2000: ['hp', 'sport', 'oc'],
  4000: ['sport', 'oc'],
  8000: ['sport', 'oc'],
});

const PERF_MODE_LABEL = Object.freeze({
  low: '低功耗',
  hp: '高性能',
  sport: '竞技',
  oc: '超频',
});

const PERF_MODE_CODE = new Map([['low', 0x01], ['hp', 0x02], ['sport', 0x04], ['oc', 0x05]]);
const PERF_CODE_MODE = new Map([...PERF_MODE_CODE].map(([k, v]) => [v, k]));

const KEY_SCAN_CODE = new Map([[1000, 0x03], [2000, 0x04], [4000, 0x05], [8000, 0x06]]);
const KEY_SCAN_HZ = new Map([...KEY_SCAN_CODE].map(([k, v]) => [v, k]));

const DPI_MIN = 50;
const DPI_MAX = 26000;
const DPI_SLOT_MAX = 6;
const DPI_STEP = 50;

const clamp = (n, min, max) => Math.min(max, Math.max(min, Math.trunc(Number(n))));

function pollingCode(hz) {
  return POLLING_CODE.get(Number(hz)) ?? 0x01;
}

function pollingFromCode(code) {
  for (const [hz, c] of POLLING_CODE) if (c === code) return hz;
  return null;
}

function perfAddr(hz) {
  return PERF_ADDR.get(Number(hz)) ?? 0xdf;
}

function dpiTableBytes(values, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = clamp(values[i] ?? 800, DPI_MIN, DPI_MAX);
    out.push(v & 0xff, (v >> 8) & 0xff);
  }
  return out;
}

function decodeU16le(bytes, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = i * 2;
    out.push((bytes[off] | (bytes[off + 1] << 8)) & 0xffff);
  }
  return out;
}

function i8(v) {
  const n = Number(v) & 0xff;
  return n >= 0x80 ? n - 0x100 : n;
}

module.exports = {
  BANKS,
  ADDR,
  BUTTON_ADDR,
  POLLING_RATES,
  PERF_MODES_BY_POLLING,
  PERF_MODE_LABEL,
  DPI_MIN,
  DPI_MAX,
  DPI_SLOT_MAX,
  DPI_STEP,
  clamp,
  pollingCode,
  pollingFromCode,
  perfAddr,
  dpiTableBytes,
  decodeU16le,
  i8,
  PERF_MODE_CODE,
  PERF_CODE_MODE,
  KEY_SCAN_CODE,
  KEY_SCAN_HZ,
};
