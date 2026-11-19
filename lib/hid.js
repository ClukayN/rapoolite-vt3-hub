'use strict';

const HID = require('node-hid');

const VENDOR_ID = 0x24ae;
const PRODUCT_ID = 0x1412;
const USAGE_PAGE = 0xff00;
const USAGE_WRITE = 0x0e;
const USAGE_READ = 0x0f;

const REPORT_ID_OUT = 6;
const REPORT_ID_FEATURE = 8;
const REPORT_LEN = 32;

const STATUS_OK = 0x01;
const STATUS_RETRY = 0x02;

const CMD_WRITE = 0xa5;
const CMD_READ = 0xa4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HidError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HidError';
    this.code = code || 'HID_ERROR';
  }
}

class RapooHid {
  constructor(log = () => {}) {
    this.log = log;
    this.writeDev = null;
    this.readDev = null;
    this.info = null;
    this._chain = Promise.resolve();
    this._lastOp = 0;
    this._dataHandlers = new Set();
  }

  get connected() {
    return Boolean(this.writeDev && this.readDev);
  }

  static enumerate() {
    return HID.devices().filter((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
  }

  static find() {
    const devices = RapooHid.enumerate();
    const w = devices.find((d) => d.usagePage === USAGE_PAGE && d.usage === USAGE_WRITE);
    const r = devices.find((d) => d.usagePage === USAGE_PAGE && d.usage === USAGE_READ);
    if (!w || !r) return null;
    return { write: w, read: r, all: devices };
  }

  open() {
    const found = RapooHid.find();
    if (!found) {
      throw new HidError('未找到雷柏接收器（VID_24AE / PID_1412）', 'NOT_FOUND');
    }
    this.close();
    this.writeDev = new HID.HID(found.write.path);
    this.readDev = new HID.HID(found.read.path);
    this.info = {
      path: found.write.path,
      product: found.write.product || 'Rapoo Device',
      manufacturer: found.write.manufacturer || 'Rapoo',
      serial: found.write.serialNumber || '',
    };
    this.writeDev.on('data', (data) => {
      for (const fn of this._dataHandlers) {
        try {
          fn(data);
        } catch (e) {
          this.log('data handler error: ' + e.message);
        }
      }
    });
    this.writeDev.on('error', (e) => this.log('write device error: ' + e.message));
    return this.info;
  }

  close() {
    for (const dev of [this.writeDev, this.readDev]) {
      if (!dev) continue;
      try {
        dev.close();
      } catch {
        /* ignore */
      }
    }
    this.writeDev = null;
    this.readDev = null;
  }

  onData(fn) {
    this._dataHandlers.add(fn);
    return () => this._dataHandlers.delete(fn);
  }

  /** 串行化所有 HID 操作：设备只有一个共享的 feature 缓冲区。 */
  _enqueue(task) {
    const run = this._chain.then(async () => {
      const wait = 12 - (Date.now() - this._lastOp);
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        this._lastOp = Date.now();
      }
    });
    this._chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  _frame(cmd, len, addr, bank, data = []) {
    const frame = [0xa5, cmd, len & 0xff, addr & 0xff, bank & 0xff, 0x00, 0x00];
    for (const b of data) frame.push(b & 0xff);
    return frame;
  }

  _send(frame) {
    if (!this.writeDev) throw new HidError('设备未连接', 'NOT_CONNECTED');
    const buffer = new Array(REPORT_LEN + 1).fill(0);
    buffer[0] = REPORT_ID_OUT;
    for (let i = 0; i < frame.length && i < REPORT_LEN; i++) buffer[1 + i] = frame[i];
    this.writeDev.write(buffer);
  }

  _readFeature() {
    if (!this.readDev) throw new HidError('设备未连接', 'NOT_CONNECTED');
    const resp = this.readDev.getFeatureReport(REPORT_ID_FEATURE, REPORT_LEN + 1);
    return resp;
  }

  /**
   * 读寄存器。设备休眠时返回状态 0x02，需要重试直到唤醒或超时。
   */
  read(bank, addr, len) {
    return this._enqueue(async () => {
      const deadline = Date.now() + 260;
      let lastStatus = null;
      while (Date.now() < deadline) {
        this._send(this._frame(CMD_READ, len, addr, bank));
        await sleep(14);
        let resp;
        try {
          resp = this._readFeature();
        } catch (e) {
          throw new HidError(`读取失败：${e.message}`, 'READ_FAILED');
        }
        lastStatus = resp[0];
        if (lastStatus === STATUS_OK) {
          const out = [];
          for (let i = 0; i < len; i++) out.push(resp[4 + i] ?? 0);
          return out;
        }
        if (lastStatus !== STATUS_RETRY) {
          throw new HidError(`应答异常：0x${Number(lastStatus).toString(16)}`, 'BAD_STATUS');
        }
        await sleep(18);
      }
      throw new HidError('设备休眠中（无应答），请移动鼠标后重试', 'DEVICE_ASLEEP');
    });
  }

  write(bank, addr, data) {
    return this._enqueue(async () => {
      this._send(this._frame(CMD_WRITE, data.length, addr, bank, data));
      await sleep(12);
      return true;
    });
  }

  readU8(bank, addr) {
    return this.read(bank, addr, 1).then((b) => b[0]);
  }

  writeU8(bank, addr, value) {
    return this.write(bank, addr, [value & 0xff]);
  }
}

module.exports = { RapooHid, HidError, VENDOR_ID, PRODUCT_ID, sleep };
