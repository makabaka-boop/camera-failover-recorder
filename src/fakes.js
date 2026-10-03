/**
 * fakes.js — 可控媒体对象，用于在 Node 测试中精确构造事件竞争。
 *
 * 与真实对象的差异只有一个：所有异步事件都由测试显式触发，
 * 因此可以任意交错“手动停止 / 设备热插拔 / 迟到数据块 / stop 事件”。
 *
 * 用法示例：
 *   const rec = new FakeRecorder(stream, handlers);
 *   rec.start(1000);
 *   session.stop();            // 会话已停止
 *   rec.emitData(chunk);       // 迟到块 → 必须被丢弃并计数
 *   rec.emitStop();            // 迟到的 stop 事件 → 必须被忽略
 */

export class FakeTrack extends EventTarget {
  constructor(label = 'fake-track') {
    super();
    this.kind = 'video';
    this.label = label;
    this.muted = false;
    this.readyState = 'live';
    this.enabled = true;
  }
  /** 模拟轨道静音（会触发 mute 事件，与真实浏览器一致）。 */
  mute() {
    if (this.readyState !== 'live' || this.muted) return;
    this.muted = true;
    this.dispatchEvent(new Event('mute'));
  }
  unmute() {
    if (!this.muted) return;
    this.muted = false;
    this.dispatchEvent(new Event('unmute'));
  }
  /** 模拟设备被拔掉 / 权限回收：readyState 变 ended 并触发 ended 事件。 */
  end() {
    if (this.readyState !== 'live') return;
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
  /** 与真实 stop() 一致：只改状态，不触发 ended 事件。 */
  stop() {
    this.readyState = 'ended';
  }
}

export class FakeStream {
  constructor(track = new FakeTrack()) {
    this.track = track;
    this.active = true;
    this.id = `fake-stream-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
  getVideoTracks() { return [this.track]; }
  getTracks() { return [this.track]; }
}

/**
 * 可控录制器。stop() 只记录调用，不自动派发事件；
 * 测试通过 emitData / emitStop / emitError 精确控制回调时序。
 * flushAndStop() 模拟真实 MediaRecorder 的“最后一块 + stop 事件”序列。
 */
export class FakeRecorder {
  constructor(stream, handlers, { mimeType = 'video/webm' } = {}) {
    this.stream = stream;
    this.handlers = handlers;
    this.mimeType = mimeType;
    this.state = 'inactive';
    this.timeslice = 0;
    this.stopCalls = 0;
    this.started = false;
  }
  start(timeslice = 0) {
    if (this.state !== 'inactive') throw new Error('FakeRecorder: invalid start');
    this.state = 'recording';
    this.started = true;
    this.timeslice = timeslice;
  }
  stop() {
    this.stopCalls++;
    // 注意：不自动 emitStop——是否/何时 flush 完全由测试决定
  }
  requestData() {}
  /** 派发一个数据块（仅 recording 状态有效，模拟真实行为）。 */
  emitData(blob) {
    if (this.state !== 'recording') return;
    this.handlers.onData(blob);
  }
  /** 派发 stop 事件（幂等）。 */
  emitStop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.handlers.onStop();
  }
  emitError(err) {
    this.handlers.onError?.(err);
  }
  /** 便捷方法：先给最后一块，再发 stop 事件（真实 MediaRecorder 的典型序列）。 */
  flushAndStop(finalBlob = null) {
    if (finalBlob) this.emitData(finalBlob);
    this.emitStop();
  }
}

/** 生成指定大小的伪数据块。 */
export function chunkOf(bytes, fill = 1) {
  return new Blob([new Uint8Array(bytes).fill(fill)], { type: 'video/webm' });
}

/** 可配置的 acquireStream 假实现。 */
export function fakeAcquire(behavior) {
  const calls = [];
  const acquire = async (deviceId) => {
    calls.push(deviceId);
    const b = behavior[deviceId];
    if (!b) throw new Error(`no fake device: ${deviceId}`);
    if (b.defer) {           // 返回一个由测试手动 resolve 的 Promise
      return b.defer();
    }
    if (b.fail) throw b.fail instanceof Error ? b.fail : new Error(String(b.fail));
    const track = b.track || new FakeTrack(`track-${deviceId}`);
    const stream = b.stream || new FakeStream(track);
    return { stream, label: b.label || `FakeCam(${deviceId})` };
  };
  acquire.calls = calls;
  return acquire;
}

/** 可注入的确定性时钟。 */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  now.set = (v) => { t = v; };
  return now;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
