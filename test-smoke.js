'use strict';

/**
 * 冒烟测试：连接设备 → 全量读取 → 打印状态 → 读按键。
 * 只读，不写设备。用法：node test-smoke.js
 */

const { Device } = require('./lib/device');

async function main() {
  const t0 = Date.now();
  const dev = new Device((m) => console.log('[log]', m));
  dev.on('state', () => {});

  const t = (label) => console.log(`${label}: ${Date.now() - t0}ms`);

  await dev.connect();
  t('connected');

  const state = await dev.refresh();
  t('refreshed');

  console.log('\n=== 设备状态 ===');
  console.log(JSON.stringify(state, null, 2));

  try {
    const buttons = await dev.readButtons();
    t('buttons');
    console.log('\n=== 按键映射 ===');
    for (const b of buttons) {
      console.log(
        `#${b.index} addr=0x${b.addr.toString(16)} funckey=0x${Number(b.funckey).toString(16)} keycode=0x${Number(b.keycode).toString(16)} raw=${b.raw ? b.raw.map((x) => x.toString(16).padStart(2, '0')).join(' ') : '-'}`,
      );
    }
  } catch (e) {
    console.log('按键读取失败：' + e.message);
  }

  dev.disconnect();
  t('done');
}

main().catch((e) => {
  console.error('FAILED:', e.code || '', e.message);
  process.exit(1);
});
