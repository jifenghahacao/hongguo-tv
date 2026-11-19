# 架构与数据流

> 配套主入口 [`AGENTS.md`](../../AGENTS.md)。本文讲清"一套 UI 四处运行"是如何实现的，以及核心与各外壳之间的启动握手与通信契约。

## 1. 总体架构

```
                    ┌──────────────────────────────────────┐
                    │   共享 Web UI（唯一真源）              │
                    │   core/cmd/hongguotv/ui/              │
                    │   //go:embed ui  →  embed.FS          │
                    └───────────────┬──────────────────────┘
                                    │ 本机 HTTP（页面 + /api/v1/* + /minireel-proxy/*）
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
   ┌──────────▼──────────┐ ┌────────▼─────────┐ ┌────────▼────────────┐
   │ Android TV 壳        │ │ Desktop 壳        │ │ webOS 壳            │
   │ WebView + JS Bridge  │ │ Wails + WebView   │ │ 构建期拷贝 UI        │
   │ 前台服务拉起 .so     │ │ sidecar 反代       │ │ JS Service 复刻 API   │
   └──────────┬──────────┘ └────────┬─────────┘ └────────┬────────────┘
              │ 启动 core            │ 启动 core          │ 不启动 Go
              └──────────┬───────────┘                     │ Node Luna Service
                         ▼                                 ▼
              ┌──────────────────────┐          ┌──────────────────────┐
              │ Go 本机核心           │          │ webOS JS Service      │
              │ 127.0.0.1:<随机端口>  │          │ 127.0.0.1:7655        │
              │ 上游 API / 签名 / 播放│          │ 同款 /api/v1/* 契约   │
              └──────────────────────┘          └──────────────────────┘
```

**关键**：Android 和 desktop **运行 Go 核心**；webOS **不运行 Go**，而是用 JavaScript 重新实现了同一套 API 契约（`webos/service/provider.js` 对 `passport_sign.go`/`minireel*.go`）。三端共享的是"同一份 UI 源码 + 同一份 HTTP 契约"。

## 2. 共享 UI 是唯一真源

- `core/cmd/hongguotv/main.go:21-25`：`//go:embed ui` / `var uiFiles embed.FS`，注释明确 "Android, desktop and development browser builds use the same page and the same local HTTP contract"。
- `fs.Sub(uiFiles, "ui")`（`main.go:64`）后由 `http.NewServeMux` 托管，`/` 路由经 `serveUI`（`main.go:173-181`，`Cache-Control: no-store`）。
- **各端消费方式**：
  - Android：`MainActivity` WebView `loadUrl(coreUrl)`，`LOAD_NO_CACHE`，加载内嵌页面。
  - Desktop：`desktop/corehost.go:268-344` 把 WebView 请求反代到核心 loopback 地址；`desktop/frontend/index.html` 只是引导页，轮询 `/desktop/status` 后 `location.replace('/index.html')` 跳到核心提供的真实页面。
  - webOS：`scripts/build_webos.sh:53` 把 `core/cmd/hongguotv/ui/` 整个拷入 IPK 暂存；因页面是 `file://`，用 `sed` 把根绝对路径 `/` 改为 `./`，并注入 `webos-adapter.js` 等适配脚本。

> 结论：**任何 UI/前端改动只改 `core/cmd/hongguotv/ui/`**。改 Android `assets` 或 `desktop/frontend` 的 UI 不会生效（前者不存在业务 UI，后者只是加载页）。

## 3. 启动握手协议

外壳启动核心并确认"是我要的那个实例"的完整流程：

1. **拉起**：外壳以如下参数启动核心二进制：
   ```
   <core-binary> -port 0 -instance-id <UUID> -parent-pid <hostPid> [-data-dir <dir>]
   ```
   - `-port 0`：让 OS 分配空闲端口，避免连到另一份应用或旧进程（`CoreEndpoint.java:3` 注释）。
   - 环境变量：`MINIREEL_CACHE_DIR`、`HONGGUO_TV_DATA_DIR`（Android `CoreService.java:102-110`；desktop `corehost.go:99`）。
2. **就绪行**：核心绑定 `tcp4 127.0.0.1:<port>`（`runtime.go:23`）后向 stdout 打印：
   ```
   HONGGUO_TV_READY <port> <instance-id>
   ```
   （`runtime.go:28`）
3. **解析与校验**：外壳解析就绪行得到 `http://127.0.0.1:<port>/`，再轮询 `GET /api/v1/status`，校验 `ok`、`service == "hongguo-tv-core"`、`instance_id`、`version == 期望版本`：
   - Android：`CoreEndpoint.fromReadyLine()` + `matches()`（`CoreEndpoint.java:14-29`）、`MainActivity.waitForCore()`（`:491-556`）。
   - Desktop：`corehost.go` 读就绪行（`:128-141`）+ `verifyCore()`（`:182-209`）。
4. **父进程守护**：核心用 `os.Getppid()` + `time.NewTicker` 轮询父进程，父进程消失即 cancel 并关闭 HTTP 服务（`runtime.go:37-54,67-79`）；`http.ErrServerClosed` 视为正常退出。Android 侧 Activity 退出时还会显式 `stopService`（`CoreService.java:47-60`，`START_NOT_STICKY`）。

**强约束**：`CoreService.java` 校验的 `BuildConfig.CORE_VERSION` 必须与 `.so` 编译时 `-X main.version=...` 注入的值一致，否则握手失败（`scripts/release_android.ps1:35-37`）。改启动参数/版本须同步 `main.go`、`CoreService.java`、`desktop/corehost.go`、构建脚本四处。

## 4. UI ↔ 原生 ↔ 核心：三条通道

| 通道 | 用途 | 机制 |
|---|---|---|
| 本机 HTTP | 业务数据（分类、搜索、详情、账号、播放…） | UI `fetch('/api/v1/...')` → 核心 mux 路由；webOS 由 `webos-adapter.js` 透明改写 `fetch`/XHR/`media.src` 指向 `127.0.0.1:7655` |
| JS Bridge（Android） | 原生能力：诊断、投屏、偏好、输入、更新、推荐应用、原生播放器 | `MainActivity.addJavascriptInterface` 注入 `window.Hongguo*`；原生反向调 `window.HongguoTV.remoteKey(...)`、`mediaCommand(...)`、`window.HongguoNativePlayback.event(...)` |
| Wails 绑定（desktop） | 窗口状态、更新、退出 | `main.go:168` `Bind: {app}`，JS 调 `window.go.main.desktopApp.*`；Go 调 JS `window.HongguoTV.prepareExit()` |

**WASM 不是桥接**：`desktop/wasm/` 是 FFmpeg 软解码器（Emscripten 编译 C），仅 Windows 在 `wasm_assets_windows.go` 内嵌并经 `/windows-wasm/` 提供；`ui/windows-wasm-player.js` 消费。默认播放仍是 WebView2 `<video>`。

## 5. webOS 的适配层（重点）

`webos/app/webos-adapter.js` 让共享 UI 无需改动即可运行：

- 常量：`SERVICE_BASE = 'http://127.0.0.1:7655'`、`SERVICE_URI = 'luna://com.aston314.hongguo.webos.service'`、模式 `luna`（`:7-9`）。
- `wakeService()`（`:208-239`）：先 Luna `ping` 唤醒 Service，再校验 HTTP `/api/v1/health`（返回 `ok && ready`）。
- 透明改写（`:300-358`）：包装 `window.fetch`、`XMLHttpRequest.open/send`、`HTMLMediaElement.src/setAttribute`，把相对路径 `/api/*`、`/minireel-proxy/*`、`/health` 指向 `SERVICE_BASE`，并在发出前唤醒 Service。
- 安全约定：签名、解密、媒体代理**只在 Service 内执行**，不放进页面 JS（`webos/README.md:66`）。

## 6. 各端服务边界

| 端 | 监听 | 谁提供 `/api/v1/*` | 页面来源 |
|---|---|---|---|
| 本地开发 | `127.0.0.1:8797`（`main.go:58` 默认） | Go 核心 | Go embed |
| Android | OS 随机端口 | Go 核心（`.so` 子进程） | Go embed（WebView 加载） |
| Desktop | 随机端口 + Wails 反代 | Go 核心（sidecar 子进程） | Go embed（经 `corehost.proxy`） |
| webOS | `127.0.0.1:7655` | JS Service（Luna 保活） | 构建期拷贝的 `ui/` |

## 7. 修改时的联动检查表

- [ ] 改 UI 行为 → 只改 `core/cmd/hongguotv/ui/`，确认 Android/desktop/webOS 三端都受影响且可接受。
- [ ] 新增/改 JS Bridge → 同时改 `MainActivity.addJavascriptInterface` 和 `ui/` 里的 JS 消费端，注意 `pageReady`/`trusted` 校验。
- [ ] 改核心启动参数/版本号 → 同步 `main.go`、`CoreService.java`、`desktop/corehost.go`、`scripts/buildso_android.ps1`/`build_android_binaries.sh`。
- [ ] 改 `/api/v1/*` 契约 → 同步 `webos/service/*.js`（webOS 是独立实现）与 `docs/ai/API.md`。
- [ ] 改播放器 → 区分 standard（`src/main/PlayerBridge.java` + Media3）与 mpv（`src/mpv/MpvPlayerBridge.java` + libmpv），维持 `NativePlayerAdapter` 契约一致。
