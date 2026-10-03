/**
 * devices.js — 浏览器设备层：枚举摄像头、监听热插拔与权限变化，
 * 把真实事件翻译成 RecordingSession 的 notify* 调用。
 */

export class DeviceManager extends EventTarget {
  constructor() {
    super();
    /** @type {MediaDeviceInfo[]} */
    this.devices = [];
    this.permissionState = 'unknown';
    this._onDeviceChange = null;
    this._permStatus = null;
    this._onPermChange = null;
  }

  /** 重新枚举视频输入设备并派发 'change'。 */
  async refresh() {
    const all = await navigator.mediaDevices.enumerateDevices();
    this.devices = all.filter((d) => d.kind === 'videoinput');
    this.dispatchEvent(new Event('change'));
    return this.devices;
  }

  /**
   * 开始监听设备热插拔与权限变化。
   * @param {()=>import('./session.js').RecordingSession|null} getSession
   */
  startWatching(getSession) {
    this._onDeviceChange = async () => {
      const session = getSession();
      const activeId = session?.activeDeviceId ?? null;
      let gone = false;
      try {
        await this.refresh();
      } catch { /* 枚举失败不致命 */ }
      if (activeId && !this.devices.some((d) => d.deviceId === activeId)) {
        gone = true;
      }
      if (gone) {
        // 活动设备被拔掉 → 中断当前片段并尝试故障转移
        session.notifyDeviceLost(activeId);
      } else if (session && session.state === 'interrupted') {
        // 有设备插回来了 → 尝试恢复录制
        session.resume();
      }
      this.dispatchEvent(new Event('change'));
    };
    navigator.mediaDevices.addEventListener('devicechange', this._onDeviceChange);

    // 权限失效（用户在浏览器设置里收回相机权限）
    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: 'camera' }).then((status) => {
        this._permStatus = status;
        this.permissionState = status.state;
        this._onPermChange = () => {
          this.permissionState = status.state;
          if (status.state === 'denied') {
            getSession()?.notifyPermissionRevoked();
          }
          this.dispatchEvent(new Event('permission'));
        };
        status.addEventListener('change', this._onPermChange);
        this.dispatchEvent(new Event('permission'));
      }).catch(() => { /* 某些浏览器不支持 camera 权限查询 */ });
    }
  }

  stopWatching() {
    if (this._onDeviceChange) {
      navigator.mediaDevices.removeEventListener('devicechange', this._onDeviceChange);
      this._onDeviceChange = null;
    }
    if (this._permStatus && this._onPermChange) {
      this._permStatus.removeEventListener('change', this._onPermChange);
      this._permStatus = null;
    }
  }
}

/** 申请一次相机权限（立即释放），使设备标签可见。 */
export async function requestCameraPermission({ audio = false } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio });
  for (const t of stream.getTracks()) t.stop();
}

/** 选择 MediaRecorder 支持的 MIME 类型。 */
export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch { /* ignore */ }
  }
  return '';
}
