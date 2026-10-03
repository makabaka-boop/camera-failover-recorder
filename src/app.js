/**
 * app.js — 页面层：设备选择、预览、录制控制、片段/缺口清单渲染、
 * 对象 URL 生命周期管理与导出。所有数据仅保存在本机，不上传。
 */
import { RecordingSession, SessionState } from './session.js';
import { DeviceManager, requestCameraPermission, pickMimeType } from './devices.js';

const $ = (id) => document.getElementById(id);
const els = {
  primarySel: $('primarySel'), backupSel: $('backupSel'),
  previewPrimaryBtn: $('previewPrimaryBtn'), previewBackupBtn: $('previewBackupBtn'),
  refreshBtn: $('refreshBtn'), permBtn: $('permBtn'), permState: $('permState'),
  audioChk: $('audioChk'), maxMbInput: $('maxMbInput'),
  previewPrimary: $('previewPrimary'), previewBackup: $('previewBackup'), recView: $('recView'),
  startBtn: $('startBtn'), switchBtn: $('switchBtn'), resumeBtn: $('resumeBtn'), stopBtn: $('stopBtn'),
  stateBadge: $('stateBadge'), sessionClock: $('sessionClock'),
  sizeBar: $('sizeBar'), sizeText: $('sizeText'),
  segTbody: $('segTbody'), segCount: $('segCount'), gapTbody: $('gapTbody'),
  player: $('player'),
  exportManifestBtn: $('exportManifestBtn'), exportAllBtn: $('exportAllBtn'), clearBtn: $('clearBtn'),
  manifestJson: $('manifestJson'), log: $('log'),
};

const deviceManager = new DeviceManager();
/** @type {RecordingSession|null} */
let session = null;
const previews = { primary: null, backup: null };   // 独立预览流（与录制流无关）
const segUrls = new Map();                          // segmentId -> objectURL（懒创建，及时撤销）

// ------------------------------------------------------------------ 工具

const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmtTime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function fmtDur(ms) {
  if (ms == null) return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}
function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}
function logLine(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = fmtTime(new Date().toISOString());
  line.append(t, msg);
  els.log.prepend(line);
  while (els.log.childElementCount > 300) els.log.lastChild.remove();
}

// ------------------------------------------------------------------ 设备选择

function populateSelects() {
  const devs = deviceManager.devices;
  const saved = { primary: els.primarySel.value, backup: els.backupSel.value };
  for (const [sel, keep] of [[els.primarySel, saved.primary], [els.backupSel, saved.backup]]) {
    sel.innerHTML = '';
    if (devs.length === 0) {
      sel.append(new Option('（无可用相机）', ''));
      continue;
    }
    devs.forEach((d, i) => {
      sel.append(new Option(d.label || `相机 ${i + 1}（授权后显示名称）`, d.deviceId));
    });
    if (keep && devs.some((d) => d.deviceId === keep)) sel.value = keep;
  }
  // 默认主=第一台、备=第二台（若存在）
  if (devs.length >= 2 && els.primarySel.value === els.backupSel.value) {
    els.backupSel.value = devs[1].deviceId;
  }
}

function persistSelections() {
  try {
    localStorage.setItem('camrec.sel', JSON.stringify({
      primary: els.primarySel.value,
      backup: els.backupSel.value,
      audio: els.audioChk.checked,
      maxMb: els.maxMbInput.value,
    }));
  } catch { /* ignore */ }
}
function restoreSelections() {
  try {
    const s = JSON.parse(localStorage.getItem('camrec.sel') || 'null');
    if (!s) return;
    if ([...els.primarySel.options].some((o) => o.value === s.primary)) els.primarySel.value = s.primary;
    if ([...els.backupSel.options].some((o) => o.value === s.backup)) els.backupSel.value = s.backup;
    els.audioChk.checked = !!s.audio;
    if (s.maxMb) els.maxMbInput.value = s.maxMb;
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ 预览

async function togglePreview(which) {
  const video = which === 'primary' ? els.previewPrimary : els.previewBackup;
  const btn = which === 'primary' ? els.previewPrimaryBtn : els.previewBackupBtn;
  if (previews[which]) {
    for (const t of previews[which].getTracks()) t.stop();
    previews[which] = null;
    video.srcObject = null;
    btn.textContent = '预览';
    return;
  }
  const deviceId = (which === 'primary' ? els.primarySel : els.backupSel).value;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    });
    previews[which] = stream;
    video.srcObject = stream;
    btn.textContent = '停止预览';
  } catch (err) {
    logLine(`预览失败（${which}）：${err.message}`, 'err');
  }
}

function stopAllPreviews() {
  for (const which of ['primary', 'backup']) {
    if (previews[which]) {
      for (const t of previews[which].getTracks()) t.stop();
      previews[which] = null;
    }
  }
  els.previewPrimary.srcObject = null;
  els.previewBackup.srcObject = null;
  els.previewPrimaryBtn.textContent = '预览';
  els.previewBackupBtn.textContent = '预览';
}

// ------------------------------------------------------------------ 会话

function maxBytes() {
  const mb = Math.max(16, parseInt(els.maxMbInput.value, 10) || 256);
  return mb * 1024 * 1024;
}

function createSession() {
  return new RecordingSession({
    acquireStream: async (deviceId) => {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: els.audioChk.checked,
      });
      const track = stream.getVideoTracks()[0];
      const dev = deviceManager.devices.find((d) => d.deviceId === deviceId);
      return { stream, label: track?.label || dev?.label || deviceId || '默认相机' };
    },
    createRecorder: (stream, handlers) => {
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) handlers.onData(e.data); };
      rec.onstop = () => handlers.onStop();
      rec.onerror = (e) => handlers.onError(e.error || e);
      return rec;
    },
    failoverChain: () => {
      const ids = [els.backupSel.value, els.primarySel.value].filter(Boolean);
      return [...new Set(ids)];
    },
    maxBytes: maxBytes(),
    onEvent: onSessionEvent,
  });
}

function onSessionEvent(type, payload = {}) {
  switch (type) {
    case 'state':
      renderState();
      break;
    case 'segment-opened':
      logLine(`片段 #${payload.segment.index + 1} 开始（${payload.segment.deviceLabel}，${payload.openReason}）`, 'ok');
      if (session?.activeSegment) els.recView.srcObject = session.activeSegment.stream ?? null;
      renderAll();
      break;
    case 'segment-closed':
      logLine(`片段 #${payload.segment.index + 1} 结束（${payload.segment.endReason}，${fmtBytes(payload.segment.bytes)}）`);
      if (!session?.activeSegment) els.recView.srcObject = null;
      renderAll();
      break;
    case 'chunk':
      renderSizes();
      break;
    case 'chunk-dropped':
      logLine(`丢弃迟到块（片段 ${payload.segmentId}，${fmtBytes(payload.size)}）`, 'warn');
      break;
    case 'interrupt':
      logLine(`中断：${payload.reason}，结束当前片段并尝试故障转移`, 'warn');
      break;
    case 'failover':
      logLine(`故障转移成功 → ${payload.deviceId}`, 'ok');
      break;
    case 'failover-failed':
      logLine(`故障转移失败（${payload.deviceId}）：${payload.error}`, 'warn');
      break;
    case 'interrupted':
      logLine(`无可用设备，录制中断（${payload.reason}）。缺口持续扩大，等待设备恢复…`, 'err');
      renderState();
      break;
    case 'gap':
      renderAll();
      break;
    case 'size-limit':
      logLine(`已达持有上限，停止录制（${fmtBytes(payload.totalBytes)}）`, 'err');
      break;
    case 'recorder-error':
      logLine(`录制器错误（片段 ${payload.segmentId}）：${payload.error}`, 'err');
      break;
    case 'error':
      logLine(`内部错误：${payload.error}`, 'err');
      break;
    case 'segment-discarded':
      renderAll();
      break;
    case 'stopped':
      logLine(`会话结束（${payload.reason}）`);
      els.recView.srcObject = null;
      renderAll();
      renderState();
      break;
    default:
      break;
  }
}

async function startRecording() {
  if (session && session.state !== SessionState.STOPPED && session.state !== SessionState.IDLE) return;
  if (session && session.segments.length > 0) {
    if (!confirm('开始新录制将丢弃上次未导出的片段与清单，继续？')) return;
    revokeAllSegUrls();
  }
  if (els.primarySel.value && els.primarySel.value === els.backupSel.value) {
    logLine('注意：主备选择了同一台设备（通常仅用于测试）', 'warn');
  }
  session = createSession();
  persistSelections();
  try {
    await session.start(els.primarySel.value);
  } catch (err) {
    logLine(`开始录制失败：${err.message}`, 'err');
  }
  renderState();
  renderAll();
}

async function stopRecording() {
  if (!session) return;
  await session.stop();
}

async function switchNow() {
  if (!session) return;
  const active = session.activeDeviceId;
  const target = active === els.primarySel.value ? els.backupSel.value : els.primarySel.value;
  if (!target || target === active) {
    logLine('切换目标与当前设备相同，忽略', 'warn');
    return;
  }
  logLine(`手动切换 → ${target}`);
  await session.switchTo(target);
}

async function resumeNow() {
  if (!session) return;
  const ok = await session.resume();
  if (!ok) logLine('恢复失败：仍无可用设备', 'warn');
}

// ------------------------------------------------------------------ 渲染

const STATE_TEXT = {
  idle: '空闲', recording: '录制中', interrupted: '已中断',
  stopping: '停止中', stopped: '已停止',
};

function renderState() {
  const st = session ? session.state : 'idle';
  els.stateBadge.textContent = STATE_TEXT[st] || st;
  els.stateBadge.className = `state ${st}`;
  els.startBtn.disabled = !(st === 'idle' || st === 'stopped');
  els.stopBtn.disabled = !(st === 'recording' || st === 'interrupted');
  els.switchBtn.disabled = st !== 'recording';
  els.resumeBtn.disabled = st !== 'interrupted';
}

function renderSizes() {
  if (!session) { els.sizeText.textContent = '—'; els.sizeBar.style.width = '0'; return; }
  const total = session.totalBytes;
  const max = maxBytes();
  const pct = Math.min(100, (total / max) * 100);
  els.sizeBar.style.width = `${pct}%`;
  els.sizeBar.classList.toggle('over', total > max);
  els.sizeText.textContent = `${fmtBytes(total)} / ${fmtBytes(max)}`;
  // 更新未关闭片段的大小单元格
  const open = session.segments.find((s) => s.state === 'open' || s.state === 'closing');
  if (open) {
    const cell = els.segTbody.querySelector(`td[data-size-for="${open.id}"]`);
    if (cell) cell.textContent = fmtBytes(open.bytes);
  }
}

function renderAll() {
  const manifest = session ? session.getManifest() : null;
  renderSegments(manifest);
  renderGaps(manifest);
  renderSizes();
  els.manifestJson.textContent = manifest ? JSON.stringify(manifest, null, 2) : '{}';
}

function renderSegments(manifest) {
  els.segTbody.innerHTML = '';
  const segs = manifest ? manifest.segments : [];
  els.segCount.textContent = segs.length ? `共 ${segs.length} 段` : '';
  for (const s of segs) {
    const tr = document.createElement('tr');
    if (s.discarded) tr.className = 'discarded';
    tr.innerHTML = `
      <td>${s.index + 1}</td>
      <td title="${s.deviceId}">${s.deviceLabel}</td>
      <td>${fmtTime(s.startedAt)}</td>
      <td>${fmtTime(s.endedAt)}</td>
      <td>${fmtDur(s.durationMs)}</td>
      <td data-size-for="${s.id}">${fmtBytes(s.bytes)}</td>
      <td>${s.endReason ?? '—'}</td>
      <td>${s.state}${s.discarded ? '（已弃媒体）' : ''}</td>
      <td>${s.droppedLateChunks}</td>
      <td><span class="ops">
        <button data-act="play" data-id="${s.id}" ${s.discarded || !s.bytes ? 'disabled' : ''}>播放</button>
        <button data-act="dl" data-id="${s.id}" ${s.discarded || !s.bytes ? 'disabled' : ''}>下载</button>
        <button data-act="del" data-id="${s.id}" ${s.discarded ? 'disabled' : ''}>删除</button>
      </span></td>`;
    els.segTbody.append(tr);
  }
}

function renderGaps(manifest) {
  els.gapTbody.innerHTML = '';
  for (const g of manifest?.gaps ?? []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${g.afterSegment != null ? `片段 ${g.afterSegment}` : '—'}</td>
      <td>${g.beforeSegment != null ? `片段 ${g.beforeSegment}` : '（会话结束）'}</td>
      <td>${g.reason}</td>
      <td>${fmtTime(g.startedAt)}</td>
      <td>${g.open ? '持续中' : fmtTime(g.endedAt)}</td>
      <td>${g.open ? '…' : fmtDur(g.durationMs)}</td>`;
    els.gapTbody.append(tr);
  }
}

// ------------------------------------------------------- 对象 URL 与片段操作

function getSegUrl(id) {
  if (segUrls.has(id)) return segUrls.get(id);
  const blob = session?.getSegmentBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  segUrls.set(id, url);
  return url;
}

function revokeSegUrl(id) {
  const url = segUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    segUrls.delete(id);
  }
}

function revokeAllSegUrls() {
  for (const url of segUrls.values()) URL.revokeObjectURL(url);
  segUrls.clear();
  els.player.pause();
  els.player.removeAttribute('src');
  els.player.load();
  els.player.style.display = 'none';
}

function segFileName(s) {
  const safe = (s.deviceLabel || 'cam').replace(/[^\w一-龥-]+/g, '_').slice(0, 40);
  return `segment-${s.index + 1}-${safe}.webm`;
}

els.segTbody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !session) return;
  const id = Number(btn.dataset.id);
  const segPub = session.segments.find((s) => s.id === id);
  if (btn.dataset.act === 'play') {
    const url = getSegUrl(id);
    if (!url) return;
    els.player.src = url;
    els.player.style.display = 'block';
    els.player.play().catch(() => {});
  } else if (btn.dataset.act === 'dl') {
    const url = getSegUrl(id);
    if (!url || !segPub) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = segFileName(segPub);
    a.click();
  } else if (btn.dataset.act === 'del') {
    if (els.player.src === segUrls.get(id)) {
      els.player.pause();
      els.player.removeAttribute('src');
      els.player.load();
      els.player.style.display = 'none';
    }
    session.discardSegment(id);
    revokeSegUrl(id);
    logLine(`片段 ${id} 媒体已删除（清单保留审计条目）`, 'warn');
  }
});

// ------------------------------------------------------------------ 导出

function downloadJson(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000); // 下载触发后撤销
}

els.exportManifestBtn.addEventListener('click', () => {
  if (!session) { logLine('没有可导出的会话', 'warn'); return; }
  downloadJson(session.getManifest(), `manifest-${session.sessionId}.json`);
  logLine('清单已导出（JSON）', 'ok');
});

els.exportAllBtn.addEventListener('click', async () => {
  if (!session) { logLine('没有可导出的会话', 'warn'); return; }
  const segs = session.segments.filter((s) => !s.discarded && s.bytes > 0);
  for (const s of segs) {
    const url = getSegUrl(s.id);
    if (!url) continue;
    const a = document.createElement('a');
    a.href = url;
    a.download = segFileName(s);
    a.click();
    await new Promise((r) => setTimeout(r, 300)); // 避免浏览器拦截连续下载
  }
  downloadJson(session.getManifest(), `manifest-${session.sessionId}.json`);
  logLine(`已导出 ${segs.length} 个片段与清单`, 'ok');
});

els.clearBtn.addEventListener('click', async () => {
  if (session && (session.state === 'recording' || session.state === 'interrupted')) {
    if (!confirm('录制仍在进行，停止并清除全部数据？')) return;
    await session.stop();
  } else if (session && session.segments.length > 0) {
    if (!confirm('清除全部片段与清单？')) return;
  }
  revokeAllSegUrls();
  session = null;
  renderAll();
  renderState();
  logLine('已清除全部数据，对象 URL 已撤销');
});

// ------------------------------------------------------------------ 事件绑定

els.startBtn.addEventListener('click', startRecording);
els.stopBtn.addEventListener('click', stopRecording);
els.switchBtn.addEventListener('click', switchNow);
els.resumeBtn.addEventListener('click', resumeNow);
els.previewPrimaryBtn.addEventListener('click', () => togglePreview('primary'));
els.previewBackupBtn.addEventListener('click', () => togglePreview('backup'));
els.refreshBtn.addEventListener('click', async () => {
  await deviceManager.refresh();
  logLine(`设备列表已刷新（${deviceManager.devices.length} 台相机）`);
});
els.permBtn.addEventListener('click', async () => {
  try {
    await requestCameraPermission({ audio: els.audioChk.checked });
    await deviceManager.refresh();
    restoreSelections();
    logLine('相机权限已授予', 'ok');
  } catch (err) {
    logLine(`权限申请失败：${err.message}`, 'err');
  }
});
for (const el of [els.primarySel, els.backupSel, els.audioChk, els.maxMbInput]) {
  el.addEventListener('change', persistSelections);
}

deviceManager.addEventListener('change', () => {
  const activeId = session?.activeDeviceId;
  populateSelects();
  if (activeId) logLine(`设备热插拔：当前活动设备 ${activeId}`, 'warn');
});
deviceManager.addEventListener('permission', () => {
  els.permState.textContent = `权限：${deviceManager.permissionState}`;
});

window.addEventListener('pagehide', () => {
  session?.releaseResources();
  stopAllPreviews();
  revokeAllSegUrls();
});

// 会话时钟
setInterval(() => {
  if (!session || !session.sessionId) { els.sessionClock.textContent = ''; return; }
  const m = session.getManifest();
  if (session.state === 'recording' && m.startedAt) {
    els.sessionClock.textContent = `已录制 ${fmtDur(Date.now() - new Date(m.startedAt).getTime())}`;
  } else if (session.state === 'interrupted') {
    els.sessionClock.textContent = '中断中（缺口持续扩大）';
  } else {
    els.sessionClock.textContent = '';
  }
}, 500);

// ------------------------------------------------------------------ 初始化

async function init() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    logLine('当前环境不支持 getUserMedia / MediaRecorder（需要安全上下文 HTTPS 或 localhost）', 'err');
    els.startBtn.disabled = true;
    return;
  }
  try {
    await deviceManager.refresh();
  } catch (err) {
    logLine(`设备枚举失败：${err.message}`, 'err');
  }
  populateSelects();
  restoreSelections();
  deviceManager.startWatching(() => session);
  renderState();
  renderAll();
  logLine('页面就绪。选择主/备摄像头后开始录制。');
}

// 测试钩子（e2e 使用）：与真实事件走同一代码路径
window.__app = {
  get session() { return session; },
  getManifest: () => session?.getManifest() ?? null,
  state: () => session?.state ?? 'idle',
  forceInterrupt: (reason) => session?.forceInterrupt(reason),
  getSegmentUrl: (id) => getSegUrl(id),
};

init();
