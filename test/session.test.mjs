/**
 * 用可控假媒体对象测试 RecordingSession 的事件竞争与故障接管。
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingSession, EndReason, SessionState } from '../src/session.js';
import {
  FakeTrack, FakeStream, FakeRecorder,
  chunkOf, fakeAcquire, fakeClock, sleep,
} from '../src/fakes.js';

const FINALIZE_TIMEOUT = 30; // 缩短 flush 超时，加快测试

/**
 * 构造一个会话及其配套假对象。
 * behavior: { [deviceId]: { fail?, defer?, label? } }（可被测试中途修改）
 */
function setup(behavior, opts = {}) {
  const clock = fakeClock();
  const recorders = [];
  const events = [];
  const acquire = fakeAcquire(behavior);
  const session = new RecordingSession({
    acquireStream: acquire,
    createRecorder: (stream, handlers) => {
      const r = new FakeRecorder(stream, handlers);
      recorders.push(r);
      return r;
    },
    failoverChain: () => ['backup', 'primary'],
    finalizeTimeoutMs: FINALIZE_TIMEOUT,
    now: clock,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    ...opts,
  });
  return { session, clock, recorders, events, acquire, behavior };
}

const twoDevices = () => ({ primary: {}, backup: {} });

/** 等待条件满足（轮询微任务/定时器）。 */
async function waitFor(cond, { timeout = 1000, step = 5 } = {}) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error('waitFor timeout');
    await sleep(step);
  }
}

// ---------------------------------------------------------------- 基本流程

test('基本录制：块计入片段，优雅停止后清单正确', async () => {
  const { session, recorders, clock } = setup(twoDevices());
  await session.start('primary');
  assert.equal(session.state, SessionState.RECORDING);

  clock.advance(1000);
  recorders[0].emitData(chunkOf(100));
  recorders[0].emitData(chunkOf(50));

  const stopP = session.stop();
  // 真实 MediaRecorder 在 stop() 后会先给最后一块再发 stop 事件
  recorders[0].flushAndStop(chunkOf(25));
  const manifest = await stopP;

  assert.equal(session.state, SessionState.STOPPED);
  assert.equal(manifest.segments.length, 1);
  assert.equal(manifest.segments[0].bytes, 175);
  assert.equal(manifest.segments[0].endReason, EndReason.MANUAL_STOP);
  assert.equal(manifest.segments[0].state, 'closed');
  assert.equal(manifest.gaps.length, 0);
  assert.equal(manifest.totals.heldBytes, 175);
  assert.equal(manifest.policy.uploaded, false);
});

test('停止时录制器不回调：超时兜底关闭片段', async () => {
  const { session, recorders } = setup(twoDevices());
  await session.start('primary');
  recorders[0].emitData(chunkOf(10));
  const manifest = await session.stop(); // 不 flush，走 finalizeTimeout
  assert.equal(manifest.segments[0].state, 'closed');
  assert.equal(manifest.segments[0].bytes, 10);
});

// ---------------------------------------------------------------- 故障接管

test('轨道 ended：当前片段明确结束，缺口记录，备设备接管', async () => {
  const { session, recorders, clock, behavior } = setup(twoDevices());
  await session.start('primary');
  const primaryTrack = session.activeSegment.stream.getVideoTracks()[0];

  clock.advance(1000);
  recorders[0].emitData(chunkOf(100));
  primaryTrack.end();                       // 模拟设备被拔掉
  await waitFor(() => recorders[0].stopCalls === 1);
  clock.advance(500);                       // 缺口持续 500ms
  recorders[0].flushAndStop(chunkOf(20));   // 故障后 flush 出的最后一块仍归原片段
  await waitFor(() => session.segments.length === 2);

  assert.equal(session.state, SessionState.RECORDING);
  assert.equal(session.activeSegment.deviceId, 'backup');

  clock.advance(800);
  recorders[1].emitData(chunkOf(60));
  const stopP = session.stop();
  recorders[1].flushAndStop();
  const manifest = await stopP;

  const [s1, s2] = manifest.segments;
  assert.equal(s1.deviceId, 'primary');
  assert.equal(s1.endReason, EndReason.TRACK_ENDED);
  assert.equal(s1.bytes, 120);              // 100 + flush 的 20
  assert.equal(s2.deviceId, 'backup');
  assert.equal(s2.openReason, 'failover');
  assert.equal(manifest.gaps.length, 1);
  assert.equal(manifest.gaps[0].reason, EndReason.TRACK_ENDED);
  assert.equal(manifest.gaps[0].durationMs, 500);
  assert.equal(manifest.gaps[0].afterSegment, s1.id);
  assert.equal(manifest.gaps[0].beforeSegment, s2.id);
  // 两段是独立片段，绝不伪装成无中断的单段
  assert.notEqual(s1.id, s2.id);
  assert.ok(new Date(s1.endedAt).getTime() < new Date(s2.startedAt).getTime());
  assert.ok(behavior);
});

test('迟到块只能归属原片段：closed 后到达一律丢弃并计数', async () => {
  const { session, recorders } = setup(twoDevices());
  await session.start('primary');
  const primaryTrack = session.activeSegment.stream.getVideoTracks()[0];
  recorders[0].emitData(chunkOf(100));
  primaryTrack.end();
  await waitFor(() => recorders[0].stopCalls === 1);
  // 不 flush，等 finalizeTimeout 强制关闭片段；随后故障转移到 backup
  await waitFor(() => session.segments.length === 2);
  assert.equal(session.segments[0].state, 'closed');

  // 旧录制器迟到的块：只能进原片段；原片段已 closed → 丢弃计数
  recorders[0].emitData(chunkOf(50));
  recorders[0].emitData(chunkOf(50));
  recorders[0].emitStop(); // 迟到的 stop 事件：忽略，不影响新片段

  assert.equal(session.segments[0].droppedLateChunks, 2);
  assert.equal(session.segments[0].bytes, 100); // 未被污染
  assert.equal(session.segments[1].bytes, 0);
  assert.equal(session.activeSegment.deviceId, 'backup');

  const stopP2 = session.stop();
  recorders[1].flushAndStop();
  const manifest = await stopP2;
  assert.equal(manifest.totals.droppedLateChunks, 2);
  assert.equal(manifest.totals.heldBytes, 100);
});

test('会话停止后不能再追加任何块', async () => {
  const { session, recorders } = setup(twoDevices());
  await session.start('primary');
  recorders[0].emitData(chunkOf(100));
  const stopP = session.stop();           // 不 flush：走超时关闭
  const manifest = await stopP;
  assert.equal(session.state, SessionState.STOPPED);

  recorders[0].emitData(chunkOf(999));    // 停止后到达的块
  recorders[0].emitStop();
  assert.equal(session.segments[0].bytes, 100);
  assert.equal(session.segments[0].droppedLateChunks, 1);
  assert.equal(manifest.totals.heldBytes, 100);
});

// ---------------------------------------------------------------- 交错竞争

test('手动切换与在途块交错：closing 中的块归原片段，新片段不受影响', async () => {
  const { session, recorders, clock } = setup(twoDevices());
  await session.start('primary');
  recorders[0].emitData(chunkOf(100));

  clock.advance(200);
  const switchP = session.switchTo('backup');
  await waitFor(() => recorders[0].stopCalls === 1);
  // 切换进行中，旧录制器的在途块仍归原片段（flush 语义）
  recorders[0].emitData(chunkOf(30));
  clock.advance(40);                      // 切换缺口 40ms
  recorders[0].emitStop();
  const ok = await switchP;
  assert.equal(ok, true);

  const [s1, s2] = session.segments;
  assert.equal(s1.bytes, 130);
  assert.equal(s1.endReason, EndReason.MANUAL_SWITCH);
  assert.equal(s2.deviceId, 'backup');
  assert.equal(s2.bytes, 0);

  recorders[1].emitData(chunkOf(70));
  const stopP9 = session.stop();
  recorders[1].flushAndStop();
  const manifest = await stopP9;
  assert.equal(manifest.gaps.length, 1);
  assert.equal(manifest.gaps[0].reason, EndReason.MANUAL_SWITCH);
  assert.equal(manifest.gaps[0].durationMs, 40);
  assert.equal(manifest.segments[1].bytes, 70);
});

test('stop 与故障转移的异步获取交错：迟到的 acquire 被丢弃，不产生新片段', async () => {
  let resolveBackup;
  const behavior = {
    primary: {},
    backup: { defer: () => new Promise((res) => { resolveBackup = res; }) },
  };
  const { session, recorders } = setup(behavior);
  await session.start('primary');
  const primaryTrack = session.activeSegment.stream.getVideoTracks()[0];

  primaryTrack.end();
  await waitFor(() => recorders[0].stopCalls === 1);
  recorders[0].flushAndStop();
  // 故障转移正在等待 backup 的 getUserMedia……此时用户按下停止
  await waitFor(() => resolveBackup !== undefined);
  const stopP = session.stop();
  // acquire 迟到 resolve：必须被 epoch 防护丢弃
  const lateTrack = new FakeTrack('late-backup');
  resolveBackup({ stream: new FakeStream(lateTrack), label: 'LateBackup' });
  const manifest = await stopP;
  await waitFor(() => lateTrack.readyState === 'ended'); // 迟到流被回收（微任务展开后）

  assert.equal(session.state, SessionState.STOPPED);
  assert.equal(manifest.segments.length, 1);       // 没有新片段
  assert.equal(manifest.gaps.length, 1);           // 缺口闭合于停止时刻
  assert.equal(manifest.gaps[0].beforeSegment, null);
  assert.equal(manifest.gaps[0].open, false);
});

test('重复 stop 幂等，且停止后 switchTo / resume 均无效', async () => {
  const { session, recorders } = setup(twoDevices());
  await session.start('primary');
  const p1 = session.stop();
  recorders[0].flushAndStop();
  const p2 = session.stop();
  assert.equal(p1, p2);
  await p1;
  assert.equal(await session.switchTo('backup'), false);
  assert.equal(await session.resume(), false);
});

// ---------------------------------------------------------------- 中断与恢复

test('全部设备不可用 → interrupted；恢复后从新片段继续，缺口闭合', async () => {
  const behavior = { primary: {}, backup: { fail: 'unplugged' } };
  const { session, recorders, clock } = setup(behavior);
  await session.start('primary');
  const primaryTrack = session.activeSegment.stream.getVideoTracks()[0];

  clock.advance(1000);
  primaryTrack.end();
  await waitFor(() => recorders[0].stopCalls === 1);
  recorders[0].flushAndStop();
  // backup 失败；重试 primary 也失败（设备仍不可用）
  behavior.primary.fail = new Error('still gone');
  await waitFor(() => session.state === SessionState.INTERRUPTED);

  assert.equal(session.segments.length, 1);
  let manifest = session.getManifest();
  assert.equal(manifest.gaps.length, 1);
  assert.equal(manifest.gaps[0].open, true);       // 缺口仍在扩大

  // 设备恢复（热插拔回来）→ resume 开启新片段
  clock.advance(3000);
  delete behavior.primary.fail;
  const ok = await session.resume();
  assert.equal(ok, true);
  assert.equal(session.state, SessionState.RECORDING);
  assert.equal(session.activeSegment.deviceId, 'primary');

  const stopP3 = session.stop();
  recorders[1].flushAndStop();
  manifest = await stopP3;
  assert.equal(manifest.segments.length, 2);
  assert.equal(manifest.segments[1].openReason, 'resume');
  assert.equal(manifest.gaps[0].durationMs, 3000);
  assert.equal(manifest.gaps[0].open, false);
});

test('interrupted 状态下停止：缺口以停止时刻闭合', async () => {
  const behavior = { primary: {}, backup: { fail: 'gone' } };
  const { session, recorders, clock } = setup(behavior);
  await session.start('primary');
  session.activeSegment.stream.getVideoTracks()[0].end();
  await waitFor(() => recorders[0].stopCalls === 1);
  recorders[0].flushAndStop();
  behavior.primary.fail = new Error('gone');
  await waitFor(() => session.state === SessionState.INTERRUPTED);

  clock.advance(1500);
  const manifest = await session.stop();
  assert.equal(manifest.gaps.length, 1);
  assert.equal(manifest.gaps[0].open, false);
  assert.equal(manifest.gaps[0].durationMs, 1500);
  assert.equal(manifest.gaps[0].beforeSegment, null);
});

test('轨道静音触发中断；unmute 不会偷偷恢复原片段', async () => {
  const behavior = { primary: {}, backup: { fail: 'none' } };
  const { session, recorders } = setup(behavior);
  await session.start('primary');
  const track = session.activeSegment.stream.getVideoTracks()[0];

  track.mute();
  await waitFor(() => recorders[0].stopCalls === 1);
  recorders[0].flushAndStop();
  behavior.primary.fail = new Error('no device');
  await waitFor(() => session.state === SessionState.INTERRUPTED);
  assert.equal(session.segments[0].endReason, EndReason.TRACK_MUTED);

  track.unmute(); // 原片段已关闭，unmute 不得复活它
  await sleep(20);
  assert.equal(session.state, SessionState.INTERRUPTED);
  assert.equal(session.segments.length, 1);
});

test('权限失效：按故障处理并记录原因', async () => {
  const { session, recorders } = setup(twoDevices());
  await session.start('primary');
  session.notifyPermissionRevoked();
  await waitFor(() => recorders[0].stopCalls === 1);
  recorders[0].flushAndStop();
  await waitFor(() => session.segments.length === 2);
  assert.equal(session.segments[0].endReason, EndReason.PERMISSION_REVOKED);
  const stopP4 = session.stop();
  recorders[1].flushAndStop();
  const manifest = await stopP4;
  assert.equal(manifest.gaps[0].reason, EndReason.PERMISSION_REVOKED);
});

test('非活动设备的热插拔丢失不影响当前录制', async () => {
  const { session, recorders } = setup(twoDevices());
  await session.start('primary');
  session.notifyDeviceLost('backup'); // 丢的是备用机
  await sleep(20);
  assert.equal(session.state, SessionState.RECORDING);
  assert.equal(session.segments.length, 1);
  const stopP5 = session.stop();
  recorders[0].flushAndStop();
  const manifest = await stopP5;
  assert.equal(manifest.gaps.length, 0);
});

// ---------------------------------------------------------------- 其他保护

test('持有媒体超过上限：会话以 size-limit 停止', async () => {
  const { session, recorders, events } = setup(twoDevices(), { maxBytes: 150 });
  await session.start('primary');
  recorders[0].emitData(chunkOf(100));
  recorders[0].emitData(chunkOf(100)); // 200 > 150 → 触发停止
  recorders[0].flushAndStop();
  const manifest = await session.stop();
  assert.equal(session.state, SessionState.STOPPED);
  assert.equal(manifest.segments[0].endReason, EndReason.SIZE_LIMIT);
  assert.ok(events.some((e) => e.type === 'size-limit'));
});

test('录制器自行停止（底层消失）：按故障转移处理', async () => {
  const { session, recorders } = setup(twoDevices());
  await session.start('primary');
  recorders[0].emitStop(); // 未经请求的 stop 事件
  await waitFor(() => session.segments.length === 2);
  assert.equal(session.segments[0].endReason, EndReason.RECORDER_STOPPED);
  assert.equal(session.activeSegment.deviceId, 'backup');
  const stopP6 = session.stop();
  recorders[1].flushAndStop();
  await stopP6;
});

test('切换目标不可用：进入 interrupted，可 resume', async () => {
  const behavior = { primary: {}, backup: { fail: 'busy' } };
  const { session, recorders } = setup(behavior);
  await session.start('primary');
  const p = session.switchTo('backup');
  await waitFor(() => recorders[0].stopCalls === 1);
  recorders[0].flushAndStop();
  assert.equal(await p, false);
  await waitFor(() => session.state === SessionState.INTERRUPTED);

  delete behavior.backup.fail;
  assert.equal(await session.resume(), true);
  assert.equal(session.activeSegment.deviceId, 'backup');
  const stopP7 = session.stop();
  recorders[1].flushAndStop();
  await stopP7;
});

test('start 时获取流失败：回到 idle，可重试', async () => {
  const behavior = { primary: { fail: 'denied' } };
  const { session } = setup(behavior);
  await assert.rejects(() => session.start('primary'));
  assert.equal(session.state, SessionState.IDLE);
  delete behavior.primary.fail;
  await session.start('primary');
  assert.equal(session.state, SessionState.RECORDING);
  await session.stop();
});

test('片段媒体可拼接为 Blob；discard 释放内存但清单保留审计条目', async () => {
  const { session, recorders } = setup(twoDevices());
  await session.start('primary');
  recorders[0].emitData(chunkOf(100));
  recorders[0].emitData(chunkOf(60));
  recorders[0].flushAndStop();
  await session.stop();

  const segId = session.segments[0].id;
  const blob = session.getSegmentBlob(segId);
  assert.equal(blob.size, 160);
  assert.equal(session.totalBytes, 160);

  assert.equal(session.discardSegment(segId), true);
  assert.equal(session.getSegmentBlob(segId), null);
  assert.equal(session.totalBytes, 0);
  const manifest = session.getManifest();
  assert.equal(manifest.segments[0].discarded, true);
  assert.equal(manifest.segments[0].bytes, 160); // 审计信息保留
  assert.equal(manifest.totals.heldBytes, 0);
});

test('故障转移期间旧录制器的迟到 stop 事件不会破坏新片段', async () => {
  const { session, recorders } = setup(twoDevices());
  await session.start('primary');
  const track = session.activeSegment.stream.getVideoTracks()[0];
  track.end();
  await waitFor(() => recorders[0].stopCalls === 1);
  recorders[0].emitStop();                       // 正常完成旧片段关闭
  await waitFor(() => session.segments.length === 2);
  recorders[0].emitStop();                       // 重复的迟到 stop：忽略
  recorders[0].emitData(chunkOf(10));            // 已 inactive，FakeRecorder 不派发
  assert.equal(session.segments[1].state, 'open');
  assert.equal(session.activeSegment.deviceId, 'backup');
  const stopP8 = session.stop();
  recorders[1].flushAndStop();
  const manifest = await stopP8;
  assert.equal(manifest.segments.length, 2);
});
