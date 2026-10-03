/**
 * e2e/takeover.mjs — 用 Chromium 假摄像头完成一次真实录制 + 故障接管。
 *
 * 启动参数：
 *   --use-fake-device-for-media-stream  提供假摄像头（真实 getUserMedia/MediaRecorder 管线）
 *   --use-fake-ui-for-media-stream      自动授予相机权限
 *
 * 流程：开始录制 → 注入 device-lost（与真实事件同一代码路径）→ 故障转移到新片段
 *       → 停止 → 校验清单（两段 + 缺口）→ 校验两段 webm 均可解码 → 保存产物。
 *
 * 运行：npm run e2e
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { listen } from '../tools/serve.mjs';

// 无 root 环境：若存在本地解包的系统库（见 README「浏览器依赖」），注入 LD_LIBRARY_PATH
const LIBS = fileURLToPath(new URL('../.libs', import.meta.url));
const libDirs = [join(LIBS, 'lib/aarch64-linux-gnu'), join(LIBS, 'usr/lib/aarch64-linux-gnu'),
  join(LIBS, 'lib/x86_64-linux-gnu'), join(LIBS, 'usr/lib/x86_64-linux-gnu')].filter(existsSync);
if (libDirs.length) {
  process.env.LD_LIBRARY_PATH = [...libDirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

const ARTIFACTS = fileURLToPath(new URL('./artifacts', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ← ${detail}`}`);
  if (!ok) failures++;
}

async function main() {
  const server = await listen(0); // 随机端口
  const port = server.address().port;
  console.log(`[e2e] 静态服务 http://127.0.0.1:${port}/`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });

  try {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.log('[page console.error]', m.text()); });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));

    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => window.__app !== undefined);

    // 1. 申请权限并确认假设备出现
    await page.click('#permBtn');
    await page.waitForFunction(() => document.getElementById('primarySel').options.length > 0
      && document.getElementById('primarySel').value !== '');
    const devices = await page.evaluate(() => [...document.getElementById('primarySel').options].map((o) => o.textContent));
    console.log('[e2e] 相机设备：', devices.join(' | '));
    check('枚举到至少一台（假）相机', devices.length >= 1);

    // 2. 主备选择（假设备只有一台时主备同机，页面允许并告警）
    const primary = await page.evaluate(() => document.getElementById('primarySel').value);
    const backup = await page.evaluate(() => document.getElementById('backupSel').value);
    check('主备设备已选定', primary !== '' && backup !== '');

    // 3. 开始录制（主设备）
    await page.click('#startBtn');
    await page.waitForFunction(() => window.__app.state() === 'recording');
    await sleep(1800); // 让 MediaRecorder 产出若干块
    const before = await page.evaluate(() => window.__app.getManifest());
    check('片段 1 正在录制且有数据', before.segments.length === 1 && before.totals.heldBytes > 0,
      JSON.stringify(before.totals));

    // 4. 注入 device-lost：与真实热插拔走同一代码路径
    await page.evaluate(() => window.__app.forceInterrupt('device-lost'));
    await page.waitForFunction(() => window.__app.getManifest().segments.length === 2, null, { timeout: 10000 });
    await page.waitForFunction(() => window.__app.state() === 'recording');
    await sleep(1500); // 第二段录一会儿

    // 5. 停止
    await page.click('#stopBtn');
    await page.waitForFunction(() => window.__app.state() === 'stopped', null, { timeout: 10000 });

    const m = await page.evaluate(() => window.__app.getManifest());
    console.log('[e2e] 清单：', JSON.stringify({ segments: m.segments.map((s) => ({ i: s.index, dev: s.deviceLabel, end: s.endReason, bytes: s.bytes })), gaps: m.gaps }, null, 2));

    // 6. 清单断言
    check('会话已停止', m.state === 'stopped');
    check('恰好两个片段（不伪装成单段）', m.segments.length === 2, `got ${m.segments.length}`);
    const [s1, s2] = m.segments;
    check('片段 1 因 device-lost 结束', s1.endReason === 'device-lost', s1.endReason);
    check('片段 2 由故障转移开启', s2.openReason === 'failover', s2.openReason);
    check('两段均有媒体数据', s1.bytes > 0 && s2.bytes > 0, `${s1.bytes}/${s2.bytes}`);
    check('恰好一个缺口，原因 device-lost', m.gaps.length === 1 && m.gaps[0].reason === 'device-lost');
    if (m.gaps.length === 1) {
      const g = m.gaps[0];
      check('缺口连接两个片段', g.afterSegment === s1.id && g.beforeSegment === s2.id);
      check('缺口已闭合且时长 ≥ 0', g.open === false && g.durationMs >= 0, `durationMs=${g.durationMs}`);
      check('片段 1 结束时刻 ≤ 片段 2 开始时刻',
        new Date(s1.endedAt).getTime() <= new Date(s2.startedAt).getTime());
    }
    check('持有字节数 = 两段之和', m.totals.heldBytes === s1.bytes + s2.bytes,
      `${m.totals.heldBytes} != ${s1.bytes + s2.bytes}`);
    check('清单声明不上传', m.policy.uploaded === false);

    // 7. 停止后注入故障不再产生新片段
    await page.evaluate(() => window.__app.forceInterrupt('device-lost'));
    await sleep(300);
    const after = await page.evaluate(() => window.__app.getManifest());
    check('停止后迟到事件被忽略', after.segments.length === 2 && after.state === 'stopped');

    // 8. 两段 webm 均可真实解码
    for (const s of m.segments) {
      const dims = await page.evaluate(async (segId) => {
        const url = window.__app.getSegmentUrl(segId);
        if (!url) return null;
        const v = document.createElement('video');
        v.muted = true;
        v.src = url;
        await new Promise((res, rej) => {
          v.onloadeddata = res;
          v.onerror = () => rej(new Error('video decode error'));
          setTimeout(() => rej(new Error('decode timeout')), 8000);
        });
        return { w: v.videoWidth, h: v.videoHeight };
      }, s.id);
      check(`片段 ${s.index + 1} 可解码（${dims ? `${dims.w}x${dims.h}` : 'null'}）`,
        dims && dims.w > 0 && dims.h > 0);
    }

    // 9. 页面 DOM 呈现缺口
    const gapRows = await page.locator('#gapTbody tr').count();
    check('缺口表格呈现 1 行', gapRows === 1, `rows=${gapRows}`);
    const manifestDom = await page.textContent('#manifestJson');
    check('页面清单含 device-lost', manifestDom.includes('device-lost'));

    // 10. 保存产物（清单 + 两段视频）
    await mkdir(ARTIFACTS, { recursive: true });
    await writeFile(join(ARTIFACTS, 'manifest.json'), JSON.stringify(m, null, 2));
    for (const s of m.segments) {
      const b64 = await page.evaluate(async (segId) => {
        const blob = window.__app.session.getSegmentBlob(segId);
        const dataUrl = await new Promise((res) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.readAsDataURL(blob);
        });
        // 注意 MIME 里可能含逗号（codecs=vp9,opus），按 ;base64, 切分
        return dataUrl.slice(dataUrl.indexOf(';base64,') + 8);
      }, s.id);
      await writeFile(join(ARTIFACTS, `segment-${s.index + 1}.webm`), Buffer.from(b64, 'base64'));
    }
    console.log(`[e2e] 产物已保存到 ${ARTIFACTS}`);

    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  if (failures > 0) {
    console.error(`\n[e2e] 失败：${failures} 项断言未通过`);
    process.exit(1);
  }
  console.log('\n[e2e] 全部断言通过：录制 → 故障接管 → 分段清单 → 可解码验证 ✔');
}

main().catch((err) => {
  console.error('[e2e] 异常：', err);
  process.exit(1);
});
