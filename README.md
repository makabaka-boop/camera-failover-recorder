# 分段相机录制（主备接管）

纯前端页面：选择主、备两个摄像头预览并录制，结果保存为**分段视频 + 时间清单**。
所有媒体只保存在本机内存中，**不上传任何内容**。

主设备断开、轨道静音或权限失效时：

1. 当前片段**立即明确结束**（结束时刻 = 故障检测时刻）；
2. 清单中记录**时间缺口**（原因、起止、时长）；
3. 备设备可用时**从新片段继续**——两段永远是独立文件，绝不拼接伪装成无中断的单段。

## 运行

```bash
npm run serve          # http://localhost:8321/ （localhost 即安全上下文，可用摄像头）
```

打开页面后：申请相机权限 → 选择主/备摄像头 → 开始录制。
录制中可手动「切换到另一台」；「停止」后可逐段播放/下载，或导出清单 JSON / 全部片段。

## 设计要点

### 分段与缺口模型（`src/session.js`，环境无关，可注入假对象测试）

- 片段生命周期：`acquiring → open → closing → closed`。
- 故障（`track ended` / `mute` / `devicechange` 丢失 / 权限 denied / 录制器异常）统一进入
  `_interrupt(reason)`：先固定 `endedAt` 并开启缺口，再尽力 flush 录制器
  （超时 `finalizeTimeoutMs` 兜底关闭），随后按故障转移链（备 → 主重试）开新片段。
- 缺口在**新片段真正开始录制**或**会话停止**时闭合；无设备可用时进入
  `interrupted`，缺口持续扩大，`devicechange` 或手动「恢复录制」触发 `resume()`。

### 事件竞争防护

- **块归属**：每个 `MediaRecorder` 回调闭包绑定其片段 id。块只在片段 `open`
  （正常）或 `closing`（停止/故障后的合法 flush）时写入该片段；片段 `closed`
  后到达的迟到块一律丢弃并计数（`droppedLateChunks`），**绝不写入其他片段**。
- **epoch 代次**：`stop()` 递增代次，使在途的异步 `getUserMedia` resolve、
  迟到的 `stop`/`dataavailable` 事件全部失效；迟到的流会被立即回收（`track.stop()`）。
- **transitioning 互斥**：故障转移与手动切换互斥，重入的故障信号被忽略；
  每次 `await` 之后都重新校验会话状态，stop 与任何异步路径交错都安全。
- **stop 幂等**：重复调用返回同一 Promise。

### 媒体持有与对象 URL

- 块只进内存；超过「持有上限」即以 `size-limit` 停止并记录。
- 片段可单独「删除」：媒体丢弃、内存释放，清单保留审计条目（`discarded: true`）。
- 对象 URL 懒创建（播放/下载时），删除片段、清除全部、页面卸载时撤销；
  清单导出的临时 URL 在下载触发后撤销。

### 清单（导出 JSON）

每段：设备 id/标签、起止时间、时长、结束原因、大小、迟到丢弃块数、MIME；
每个缺口：前后片段、原因、起止、时长、是否未闭合；另含总计与「不上传」声明。

## 测试

### 单元测试（可控媒体对象，19 个场景）

```bash
npm test
```

`src/fakes.js` 提供 `FakeTrack/FakeStream/FakeRecorder`：所有异步事件由测试显式触发，
可任意交错「手动停止 / 热插拔 / 迟到块 / stop 事件」。覆盖：故障接管与缺口计时、
迟到块归属与丢弃计数、停止后禁止追加、切换与在途块交错、stop 与在途 acquire 交错
（epoch 防护）、interrupted→resume、尺寸上限、录制器自发停止、discard 审计等。

### 浏览器端到端（假设备真实录制）

```bash
npm run e2e
```

用 Chromium 假摄像头（`--use-fake-device-for-media-stream` +
`--use-fake-ui-for-media-stream`）跑真实 `getUserMedia`/`MediaRecorder` 管线：
录制 → 注入 `device-lost`（与真实事件同一代码路径）→ 故障转移到新片段 → 停止 →
校验清单（两段 + 一个缺口）→ 两段 webm 均真实解码（640x480）→
产物保存到 `e2e/artifacts/`（`manifest.json` + `segment-*.webm`）。

**浏览器依赖**：本环境无 root，Chromium 运行库解包在 `.libs/`（e2e 自动注入
`LD_LIBRARY_PATH`）。有 root 的环境直接 `npx playwright install-deps chromium` 即可。

## 真机手动验证清单

1. 插两个摄像头，分别选为主/备，开始录制；
2. 录制中拔掉主摄像头 → 当前片段结束、出现缺口、备机接管新片段；
3. 插回主摄像头 →（中断中）自动/手动恢复；
4. 录制中在浏览器设置里收回相机权限 → 按 `permission-revoked` 记录；
5. 手动切换、停止、导出清单，核对每段起止与缺口时长。

## 文件结构

```
index.html / styles.css   页面
src/session.js            录制会话核心（分段状态机、竞争防护、清单）
src/devices.js            设备枚举、devicechange / 权限监听
src/app.js                UI  wiring、对象 URL 管理、导出
src/fakes.js              可控假媒体对象（测试用）
test/session.test.mjs     19 个竞争/接管单元测试
e2e/takeover.mjs          假设备端到端：录制 + 接管 + 解码验证
tools/serve.mjs           本地静态服务器
```
