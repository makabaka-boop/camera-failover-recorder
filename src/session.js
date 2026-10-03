/**
 * session.js — 录制会话核心（环境无关，浏览器与 Node 测试共用）。
 *
 * 职责：
 *  - 管理分段（segment）生命周期：acquiring → open → closing → closed
 *  - 主设备故障（断连 / 轨道静音 / 权限失效）时明确结束当前片段、记录时间缺口，
 *    并尝试用故障转移链（备设备 → 原设备重试）开启新片段。
 *  - 所有 MediaRecorder 异步回调都按片段归属：迟到块只能进入原片段（且仅在其
 *    尚未 closed 时），会话停止后一律丢弃并计数。
 *  - 通过 epoch（代次）使“停止/切换”与在途的异步获取流、迟到回调安全交错。
 *
 * 本文件不依赖任何 DOM / navigator API，流获取与录制器创建全部注入。
 */

export const EndReason = Object.freeze({
  MANUAL_STOP: 'manual-stop',
  MANUAL_SWITCH: 'manual-switch',
  DEVICE_LOST: 'device-lost',
  TRACK_ENDED: 'track-ended',
  TRACK_MUTED: 'track-muted',
  PERMISSION_REVOKED: 'permission-revoked',
  SIZE_LIMIT: 'size-limit',
  RECORDER_ERROR: 'recorder-error',
  RECORDER_STOPPED: 'recorder-stopped-unexpectedly',
});

export const SessionState = Object.freeze({
  IDLE: 'idle',
  RECORDING: 'recording',
  INTERRUPTED: 'interrupted', // 故障中且无可用设备，缺口仍在扩大
  STOPPING: 'stopping',
  STOPPED: 'stopped',
});

const iso = (t) => (t == null ? null : new Date(t).toISOString());

let sessionCounter = 0;

export class RecordingSession {
  /**
   * @param {object} deps
   * @param {(deviceId:string)=>Promise<{stream:any,label:string}>} deps.acquireStream
   * @param {(stream:any, handlers:{onData:Function,onStop:Function,onError:Function})=>any} deps.createRecorder
   * @param {()=>string[]} deps.failoverChain  返回按优先级排序的候选 deviceId 列表
   * @param {number} [deps.maxBytes]           会话允许持有的最大媒体字节数，超出即停止
   * @param {number} [deps.finalizeTimeoutMs]  等待录制器 flush 的最长时间
   * @param {()=>number} [deps.now]            时钟（测试可注入）
   * @param {(type:string, payload?:object)=>void} [deps.onEvent]
   */
  constructor({
    acquireStream,
    createRecorder,
    failoverChain,
    maxBytes = 256 * 1024 * 1024,
    finalizeTimeoutMs = 1500,
    now = () => Date.now(),
    onEvent = () => {},
  }) {
    if (typeof acquireStream !== 'function') throw new TypeError('acquireStream required');
    if (typeof createRecorder !== 'function') throw new TypeError('createRecorder required');
    if (typeof failoverChain !== 'function') throw new TypeError('failoverChain required');
    this._acquireStream = acquireStream;
    this._createRecorder = createRecorder;
    this._failoverChain = failoverChain;
    this._maxBytes = maxBytes;
    this._finalizeTimeoutMs = finalizeTimeoutMs;
    this._now = now;
    // UI 回调异常不得影响录制状态机
    this._emit = (type, payload) => { try { onEvent(type, payload); } catch { /* ignore */ } };

    this._state = SessionState.IDLE;
    this._segments = [];
    this._gaps = [];
    this._openGap = null;
    this._activeSeg = null;
    this._segSeq = 0;
    this._epoch = 0;            // 代次：stop() 递增，使在途异步操作失效
    this._transitioning = false; // 故障转移 / 手动切换互斥
    this._totalBytes = 0;
    this._startedAt = null;
    this._endedAt = null;
    this._stopPromise = null;
    this._sessionId = `rec-${++sessionCounter}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  get state() { return this._state; }
  get sessionId() { return this._sessionId; }
  get totalBytes() { return this._totalBytes; }
  get segments() { return this._segments.map(publicSegment); }
  get activeSegment() { return this._activeSeg; }
  get activeDeviceId() {
    const s = this._activeSeg;
    return s && s.state === 'open' ? s.deviceId : null;
  }

  // ---------------------------------------------------------------- 生命周期

  /** 开始录制。失败时回到 idle 并抛错。 */
  async start(deviceId) {
    if (this._state !== SessionState.IDLE && this._state !== SessionState.STOPPED) {
      throw new Error(`cannot start from state ${this._state}`);
    }
    if (this._state === SessionState.STOPPED) {
      throw new Error('session already used; create a new RecordingSession');
    }
    this._epoch++;
    this._state = SessionState.RECORDING;
    this._startedAt = this._now();
    this._emit('state', { state: this._state });
    try {
      await this._openSegment(deviceId, 'start');
    } catch (err) {
      this._state = SessionState.IDLE;
      this._startedAt = null;
      this._emit('state', { state: this._state });
      throw err;
    }
  }

  /**
   * 停止整个会话。递增代次使在途 acquire / 迟到回调失效，
   * 然后等待活动片段 flush 结束（片段 closed 后不再接受任何块）。
   * 可重复调用（返回同一 Promise）。
   */
  stop(reason = EndReason.MANUAL_STOP) {
    if (this._state === SessionState.IDLE) return Promise.resolve(null);
    if (this._stopPromise) return this._stopPromise;
    this._epoch++;                    // 使在途 acquire / 回调失效
    this._state = SessionState.STOPPING;
    this._emit('state', { state: this._state });
    this._stopPromise = (async () => {
      const seg = this._activeSeg;
      try {
        if (seg && seg.state === 'open') {
          await this._closeSegment(seg, reason, { flush: true });
        }
        // 防御：关闭任何仍滞留的片段（理论上不应存在）
        for (const s of this._segments) {
          if (s.state !== 'closed') this._finalizeSegment(s);
        }
      } finally {
        this._closeOpenGap(null);
        this._activeSeg = null;
        this._endedAt = this._now();
        this._state = SessionState.STOPPED;
        this._emit('state', { state: this._state, reason });
        this._emit('stopped', { reason });
      }
      return this.getManifest();
    })();
    return this._stopPromise;
  }

  /** 手动切换到另一台设备：结束当前片段（记缺口），开启新片段。 */
  async switchTo(deviceId) {
    if (this._state !== SessionState.RECORDING) return false;
    if (this._transitioning) return false;
    const seg = this._activeSeg;
    if (!seg || seg.state !== 'open' || seg.deviceId === deviceId) return false;
    this._transitioning = true;
    try {
      // _closeSegment 同步固定 endedAt，缺口从这一刻算起
      const closeP = this._closeSegment(seg, EndReason.MANUAL_SWITCH, { flush: true });
      this._beginGap(EndReason.MANUAL_SWITCH, seg);
      await closeP;
      if (this._state !== SessionState.RECORDING) return false; // 期间被 stop
      await this._openSegment(deviceId, 'switch');
      return true;
    } catch (err) {
      // 切换目标不可用：进入 interrupted，等待 resume / 热插拔
      if (this._state === SessionState.RECORDING) {
        this._state = SessionState.INTERRUPTED;
        this._emit('state', { state: this._state });
        this._emit('interrupted', { reason: EndReason.MANUAL_SWITCH, error: String(err) });
      }
      return false;
    } finally {
      this._transitioning = false;
    }
  }

  /** 从 interrupted 状态恢复（手动按钮或 devicechange 自动触发）。 */
  async resume() {
    if (this._state !== SessionState.INTERRUPTED || this._transitioning) return false;
    this._transitioning = true;
    this._state = SessionState.RECORDING;
    this._emit('state', { state: this._state });
    try {
      const tried = new Set();
      for (const candidate of this._failoverChain()) {
        if (tried.has(candidate)) continue;
        tried.add(candidate);
        if (this._state !== SessionState.RECORDING) return false; // 期间被 stop
        try {
          await this._openSegment(candidate, 'resume');
          return true;
        } catch (err) {
          this._emit('failover-failed', { deviceId: candidate, error: String(err) });
        }
      }
      if (this._state === SessionState.RECORDING) {
        this._state = SessionState.INTERRUPTED;
        this._emit('state', { state: this._state });
      }
      return false;
    } catch (err) {
      this._emit('error', { error: String(err && err.message || err) });
      return false;
    } finally {
      this._transitioning = false;
    }
  }

  // ------------------------------------------------------- 外部事件入口（设备层）

  /** 设备热插拔：丢失的是当前活动设备才触发中断。 */
  notifyDeviceLost(deviceId) {
    const seg = this._activeSeg;
    if (this._state !== SessionState.RECORDING) return;
    if (!seg || seg.state !== 'open' || seg.deviceId !== deviceId) return;
    this._interrupt(EndReason.DEVICE_LOST);
  }

  notifyPermissionRevoked() {
    if (this._state !== SessionState.RECORDING) return;
    this._interrupt(EndReason.PERMISSION_REVOKED);
  }

  /** 测试 / 诊断钩子：与真实事件走完全相同的代码路径。 */
  forceInterrupt(reason) {
    if (this._state !== SessionState.RECORDING) return;
    this._interrupt(reason);
  }

  /** 页面卸载等场景：尽力同步释放摄像头资源（不等 flush）。 */
  releaseResources() {
    this._epoch++;
    for (const s of this._segments) {
      this._detachWatchers(s);
      if (s.stream) stopStreamTracks(s.stream);
      if (s.state !== 'closed') this._finalizeSegment(s);
    }
    if (this._state !== SessionState.STOPPED) {
      this._state = SessionState.STOPPED;
      this._endedAt = this._now();
    }
  }

  // ------------------------------------------------------------ 片段生命周期

  async _openSegment(deviceId, openReason) {
    const myEpoch = this._epoch;
    const seg = {
      id: ++this._segSeq,
      index: this._segments.length,
      deviceId,
      label: deviceId,
      openReason,
      state: 'acquiring',
      startedAt: null,
      endedAt: null,
      endReason: null,
      chunks: [],
      byteSize: 0,
      droppedLateChunks: 0,
      mimeType: '',
      discarded: false,
      stream: null,
      recorder: null,
      _unwatch: null,
      _finalizeTimer: null,
    };
    seg.closedPromise = new Promise((res) => { seg._resolveClosed = res; });

    const { stream, label } = await this._acquireStream(deviceId);
    // await 之后必须重新校验：期间可能已 stop() / 发生故障转移
    if (myEpoch !== this._epoch || this._state !== SessionState.RECORDING) {
      stopStreamTracks(stream);
      throw new Error('stale acquire discarded');
    }

    seg.stream = stream;
    seg.label = label || deviceId;
    seg.recorder = this._createRecorder(stream, {
      onData: (blob) => this._onData(seg, blob),
      onStop: () => this._onRecorderStop(seg),
      onError: (err) => this._onRecorderError(seg, err),
    });
    seg.mimeType = seg.recorder?.mimeType || '';
    seg.state = 'open';
    seg.startedAt = this._now();
    this._segments.push(seg);
    this._activeSeg = seg;
    this._attachWatchers(seg);
    try {
      seg.recorder.start(1000);
    } catch (err) {
      // 录制器启动失败：回收该片段并视为打开失败
      this._detachWatchers(seg);
      stopStreamTracks(stream);
      this._segments.pop();
      this._activeSeg = null;
      throw err;
    }
    this._closeOpenGap(seg); // 缺口在新片段真正开始录制时才闭合
    this._emit('segment-opened', { segment: publicSegment(seg), openReason });
    return seg;
  }

  /**
   * 结束片段：先固定 endedAt（缺口从这一刻算起），再尽力 flush 录制器。
   * flush 完成或超时后片段进入 closed，之后到达的块一律丢弃计数。
   */
  _closeSegment(seg, reason, { flush } = { flush: true }) {
    if (seg.state === 'closed' || seg.state === 'closing') return seg.closedPromise;
    seg.endedAt = this._now();
    seg.endReason = reason;
    const canFlush = flush && seg.recorder && seg.recorder.state !== 'inactive';
    if (canFlush) {
      seg.state = 'closing';
      this._emit('segment-closing', { segment: publicSegment(seg) });
      try {
        seg.recorder.stop();
      } catch {
        this._finalizeSegment(seg);
        return seg.closedPromise;
      }
      seg._finalizeTimer = setTimeout(() => {
        if (seg.state === 'closing') this._finalizeSegment(seg);
      }, this._finalizeTimeoutMs);
    } else {
      this._finalizeSegment(seg);
    }
    return seg.closedPromise;
  }

  _finalizeSegment(seg) {
    if (seg.state === 'closed') return;
    if (seg._finalizeTimer) { clearTimeout(seg._finalizeTimer); seg._finalizeTimer = null; }
    seg.state = 'closed';
    this._detachWatchers(seg);
    if (seg.stream) stopStreamTracks(seg.stream);
    if (this._activeSeg === seg) this._activeSeg = null;
    this._emit('segment-closed', { segment: publicSegment(seg) });
    seg._resolveClosed(seg);
  }

  // ------------------------------------------------------------- 录制器回调

  _onData(seg, blob) {
    if (!blob || typeof blob.size !== 'number' || blob.size === 0) return;
    // 片段级闸门：open（正常）或 closing（stop/failover 后的合法 flush）可追加；
    // 片段 closed（含会话停止）后到达的迟到块一律丢弃并计数，绝不写入其他片段。
    if (seg.state !== 'open' && seg.state !== 'closing') {
      seg.droppedLateChunks++;
      this._emit('chunk-dropped', { segmentId: seg.id, size: blob.size });
      return;
    }
    seg.chunks.push({ blob, t: this._now() });
    seg.byteSize += blob.size;
    this._totalBytes += blob.size;
    this._emit('chunk', { segmentId: seg.id, size: blob.size, totalBytes: this._totalBytes });
    if (this._totalBytes > this._maxBytes && this._state === SessionState.RECORDING) {
      this._emit('size-limit', { totalBytes: this._totalBytes, maxBytes: this._maxBytes });
      this.stop(EndReason.SIZE_LIMIT).catch(() => {});
    }
  }

  _onRecorderStop(seg) {
    if (seg.state === 'closing') {
      this._finalizeSegment(seg);
      return;
    }
    if (seg.state === 'open') {
      // 录制器自行停止（底层设备消失等）：走统一的故障中断路径。
      // _closeSegment 发现录制器已 inactive 会立即 finalize。
      if (this._state === SessionState.RECORDING) {
        this._interrupt(EndReason.RECORDER_STOPPED);
      }
    }
    // closed：迟到的 stop 事件，忽略
  }

  _onRecorderError(seg, err) {
    this._emit('recorder-error', { segmentId: seg.id, error: String(err && err.message || err) });
    if (seg === this._activeSeg && seg.state === 'open' && this._state === SessionState.RECORDING) {
      this._interrupt(EndReason.RECORDER_ERROR);
    }
  }

  // ------------------------------------------------------------------ 故障

  async _interrupt(reason) {
    if (this._state !== SessionState.RECORDING || this._transitioning) return;
    const seg = this._activeSeg;
    if (!seg || seg.state !== 'open') return;
    this._transitioning = true;
    try {
      this._emit('interrupt', { reason, segmentId: seg.id });
      // _closeSegment 同步固定 seg.endedAt；缺口起点与片段终点严格一致
      const closeP = this._closeSegment(seg, reason, { flush: true });
      this._beginGap(reason, seg);
      await closeP;
      if (this._state !== SessionState.RECORDING) return; // 关闭期间被 stop()

      const tried = new Set([seg.deviceId]);
      for (const candidate of this._failoverChain()) {
        if (tried.has(candidate)) continue;
        tried.add(candidate);
        if (this._state !== SessionState.RECORDING) return;
        try {
          await this._openSegment(candidate, 'failover');
          this._emit('failover', { deviceId: candidate, reason });
          return;
        } catch (err) {
          this._emit('failover-failed', { deviceId: candidate, error: String(err) });
        }
      }
      // 链上设备都失败：最后重试一次原设备（静音等瞬时故障可能已恢复）
      if (this._state === SessionState.RECORDING) {
        try {
          await this._openSegment(seg.deviceId, 'failover');
          this._emit('failover', { deviceId: seg.deviceId, reason });
          return;
        } catch { /* fall through */ }
      }

      if (this._state === SessionState.RECORDING) {
        this._state = SessionState.INTERRUPTED;
        this._emit('state', { state: this._state });
        this._emit('interrupted', { reason });
      }
    } catch (err) {
      // 注入的回调（failoverChain 等）异常不得使会话崩溃
      this._emit('error', { error: String(err && err.message || err) });
    } finally {
      this._transitioning = false;
    }
  }

  _beginGap(reason, seg) {
    this._openGap = {
      afterSegmentId: seg.id,
      toSegmentId: null,
      reason,
      startedAt: seg.endedAt != null ? seg.endedAt : this._now(),
      endedAt: null,
    };
  }

  _closeOpenGap(nextSeg) {
    if (!this._openGap) return;
    const gap = this._openGap;
    this._openGap = null;
    gap.toSegmentId = nextSeg ? nextSeg.id : null;
    gap.endedAt = nextSeg ? nextSeg.startedAt : this._now();
    this._gaps.push(gap);
    this._emit('gap', { gap: publicGap(gap) });
  }

  // ------------------------------------------------------------------ 监视

  _attachWatchers(seg) {
    const track = seg.stream && seg.stream.getVideoTracks && seg.stream.getVideoTracks()[0];
    if (!track || typeof track.addEventListener !== 'function') return;
    const onEnded = () => {
      if (seg.state === 'open' && seg === this._activeSeg && this._state === SessionState.RECORDING) {
        this._interrupt(EndReason.TRACK_ENDED);
      }
    };
    const onMute = () => {
      if (seg.state === 'open' && seg === this._activeSeg && this._state === SessionState.RECORDING) {
        this._interrupt(EndReason.TRACK_MUTED);
      }
    };
    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    seg._unwatch = () => {
      track.removeEventListener('ended', onEnded);
      track.removeEventListener('mute', onMute);
    };
  }

  _detachWatchers(seg) {
    if (seg._unwatch) { seg._unwatch(); seg._unwatch = null; }
  }

  // ------------------------------------------------------------------ 数据

  /** 拼接某片段的 Blob（不持有额外副本，引用原 chunks）。 */
  getSegmentBlob(segmentId) {
    const seg = this._segments.find((s) => s.id === segmentId);
    if (!seg || seg.discarded || seg.chunks.length === 0) return null;
    const BlobCtor = typeof Blob !== 'undefined' ? Blob : null;
    if (!BlobCtor) return null;
    return new BlobCtor(seg.chunks.map((c) => c.blob), { type: seg.mimeType || 'video/webm' });
  }

  /** 丢弃片段媒体（清单保留条目并标记 discarded），释放内存。 */
  discardSegment(segmentId) {
    const seg = this._segments.find((s) => s.id === segmentId);
    if (!seg || seg.discarded) return false;
    seg.discarded = true;
    this._totalBytes -= seg.byteSize;
    seg.chunks = [];
    this._emit('segment-discarded', { segmentId: seg.id, totalBytes: this._totalBytes });
    return true;
  }

  getManifest() {
    const gaps = this._gaps.map(publicGap);
    if (this._openGap) gaps.push({ ...publicGap(this._openGap), open: true });
    return {
      version: 1,
      sessionId: this._sessionId,
      state: this._state,
      startedAt: iso(this._startedAt),
      endedAt: iso(this._endedAt),
      segments: this._segments.map(publicSegment),
      gaps,
      totals: {
        segments: this._segments.length,
        heldBytes: this._totalBytes,
        droppedLateChunks: this._segments.reduce((n, s) => n + s.droppedLateChunks, 0),
      },
      policy: {
        uploaded: false,
        note: '所有媒体数据仅保存在本机内存中，页面不上传任何媒体内容。',
      },
      generatedAt: iso(this._now()),
    };
  }
}

function publicSegment(seg) {
  return {
    id: seg.id,
    index: seg.index,
    deviceId: seg.deviceId,
    deviceLabel: seg.label,
    openReason: seg.openReason,
    state: seg.state,
    startedAt: iso(seg.startedAt),
    endedAt: iso(seg.endedAt),
    durationMs: seg.startedAt != null && seg.endedAt != null ? seg.endedAt - seg.startedAt : null,
    endReason: seg.endReason,
    bytes: seg.byteSize,
    chunks: seg.chunks.length,
    droppedLateChunks: seg.droppedLateChunks,
    mimeType: seg.mimeType,
    discarded: seg.discarded,
  };
}

function publicGap(gap) {
  return {
    afterSegment: gap.afterSegmentId,
    beforeSegment: gap.toSegmentId,
    reason: gap.reason,
    startedAt: iso(gap.startedAt),
    endedAt: iso(gap.endedAt),
    durationMs: gap.endedAt != null ? gap.endedAt - gap.startedAt : null,
    open: gap.endedAt == null,
  };
}

function stopStreamTracks(stream) {
  try {
    const tracks = typeof stream.getTracks === 'function' ? stream.getTracks() : [];
    for (const t of tracks) { try { t.stop(); } catch { /* ignore */ } }
  } catch { /* ignore */ }
}
