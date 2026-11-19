# 各平台模块导读

> 配套 [`AGENTS.md`](../../AGENTS.md) §3。深入某个平台时读本文，架构总览见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 1. Android TV（`android/`）

### 工程配置
- 根 `build.gradle`：AGP `8.13.2`（`apply false`）；`settings.gradle` 含 `:app`、`:wasm-diagnostic` 两模块，仓库 `FAIL_ON_PROJECT_REPOS` + `google()/mavenCentral()`；`gradle.properties`：`android.useAndroidX=true`、`enableJetifier=true`。
- `app/build.gradle`：namespace/applicationId `rocks.aston.hongguotv`；compileSdk 36 / minSdk 23 / targetSdk 35；`appVersion=1.0.6`、standard `versionCode 106` / mpv `100`；ABI `arm64-v8a`、`armeabi-v7a`、`x86_64`；`flavorDimensions "player"`。
- **Flavor**：
  - `standard`：app 名"红果短剧"，`VARIANT_ID=standard`，`PLAYER_ENGINE=webview_media3`，Media3 `1.8.0`，用平台解码器，不打包 FFmpeg/NextLib。
  - `mpv`：`applicationIdSuffix ".mpv"`，`VARIANT_ID=mpv`，`PLAYER_ENGINE=mpv`，Media3 `1.11.1` + LGPL libmpv。
  - Android5 兼容模式：`-Pandroid5Compat=true` 时输出隔离到 `build/android5`、jniLibs 切 `src/android5/jniLibs`、standard 包后缀 `.android5test`、minSdk 21。
- 签名全部来自 4 个环境变量；`gradle.taskGraph.whenReady` 禁止 android5 兼容包打 mpv 任务，缺签名变量直接抛错。

### 关键类（`android/app/src/main/java/rocks/aston/hongguotv/`）
| 类 | 职责 |
|---|---|
| `MainActivity`（994 行） | 唯一 Activity；启动前台服务、等待 Go 就绪、加载 WebView；注册 10 个 JS Bridge（`HongguoTVDiagnostics`/`HongguoScreen`/`HongguoTVCast`/`HongguoTVPreferences`/`HongguoTVInput`/`HongguoTVHome`/`HongguoTVUpdates`/`HongguoRecommendedApps`/`HongguoStartup`/`HongguoNativePlayer`）；遥控器按键分发到 `window.HongguoTV.remoteKey(...)`/`mediaCommand(...)`/`requestBack()`；渲染进程崩溃恢复 |
| `CoreService` | 前台服务，`ProcessBuilder` 启动 `libhongguotv.so`（`-port 0 -instance-id -parent-pid`），读 stdout 就绪行，`START_NOT_STICKY` |
| `CoreEndpoint` | 解析 `HONGGUO_TV_READY <port> <id>`，构造 URL，`matches()` 校验 service/instance/version |
| `NativePlayerAdapter` | 两 flavor 共享的 `@JavascriptInterface` 契约（`play/begin/stop/pause/resume/setSpeed/seekTo/bounds/diagnostics/...`） |
| `PlayerFactory` | 编译期分派：standard→`PlayerBridge`，mpv→`MpvPlayerBridge` |
| `PlayerBridge`（standard） | Media3 ExoPlayer 有界回退；URL 白名单 `MediaUrlPolicy`；HEVC 软件回退、首帧 25s 超时重试；原生层默认隐藏，仅 HTML5 `<video>` 显式回退时显示 |
| `MpvPlayerBridge`（mpv，1176 行） | 单 libmpv 客户端，stop fence/generation/source-switch 状态；解码选项 `vo=gpu`、`hwdec`、`ao=audiotrack,opensles`；许可弹窗读 `assets/mpv-notices.txt` |
| `MPVLib` + `mpv-jni/bridge.cpp` | JNI 封装（MIT）；`JNI_OnLoad` 让 libmpv MediaCodec 硬解可用；**native 侧分类日志，绝不把含签名媒体 URL 的原始日志传给 WebView** |
| `TvHomeChannelManager` | 创建"红果精选"系统频道（最多 20 条推荐），同步 PreviewProgram，解析 `hongguo://play?series_id=...` |
| `RecommendedApps` / `AppUpdater` | 白名单应用下载/SHA256+签名校验/安装；自有更新传输与安装（schema 1、variant 校验） |

### 辅助模块
- `android/wasm-diagnostic/`：独立临时诊断 APK（`rocks.aston.hongguowasmdiag`，minSdk 23/targetSdk 28），测 WebView 跑 HEVC WASM worker 的能力；内置 HTTP 服务 `AssetHttpServer`（端口 18998）从 `assets/www` 提供页面。不启动 Go 核心，与账号/历史无关。
- `android/mpv-jni/`：`bridge.cpp`（MIT）+ `media_codec_layout_parser.h` + `LICENSE`；`scripts/prepare_mpv.py` 下载 hash-pinned libmpv v1.1.11 头文件，编译 `libhongguompv.so` 到 `src/mpv/jniLibs/<abi>/`。

## 2. Desktop（`desktop/`）

- 技术栈：Wails v2（`go.mod` 唯一直接依赖 `github.com/wailsapp/wails/v2 v2.11.0`）+ 独立 Go 核心子进程 + 原生 JS 前端。
- `desktop/frontend/`：**只是加载/引导页**（`index.html` 轮询 `/desktop/status`，就绪后跳 `/index.html`），不是业务 UI。
- `desktop/corehost.go`：启动核心 sidecar（`-port 0 -instance-id -data-dir -parent-pid`）→ 读就绪行 → `verifyCore()` 校验 → `proxy()`（`:268-344`）把 WebView 请求反代到核心 loopback，剔除 `Origin/Referer/Sec-Fetch-Site` 合成头 → `writePage()`（`:345-350`）注入 `window.HongguoDesktop={platform,version,mediaBase,wasmDecoder}`。
- `desktop/main.go`：`wails.Run`；`Bind: {app}` 提供 `GetWindowState/CheckUpdate/FinishExit` 等；`beforeClose` 调 JS `window.HongguoTV.prepareExit()`。
- Wails 方法调用：`window.go.main.desktopApp.*`（见 `ui/desktop.js:134-180`）。
- `desktop/wasm/`：FFmpeg 软解码器 C 源码；`wasm-runtime/`、前端 `windows-wasm/` 均为 CI 产物（`.gitignore` 排除）。默认播放是 WebView2 `<video>`，仅 Windows 且打包了解码器才暴露"CPU (WASM)"选项。
- 平台分文件：`media_linux.go`/`media_other.go`、`power_windows.go`、`window_state_darwin.go`、`wasm_assets_windows.go`/`wasm_assets_other.go`。

## 3. webOS（`webos/`）

- `appinfo.json`：`id=com.aston314.hongguo.webos`、版本 `0.2.172`、`type=web`、`main=index.html`、1280x720、`disableBackHistoryAPI=true`。
- **webOS 不运行 Go 核心**，用 Node Luna Service 在 `127.0.0.1:7655` 复刻 `/api/v1/*` 契约。
- `webos/service/`：
  - `service-entry.js`：`module.exports = require('./service')()`。
  - `service.js`：`createService(options)` 可注入工厂，HTTP 路由表（`:136-342`）覆盖分类/榜单/搜索/详情/账号/评论/云收藏、`/minireel-proxy/media/`、`/api/v1/play/info`；Luna 方法 `ping/getDiagnostics/shutdown`；用 `activityManager` 保活。
  - `provider.js`（145KB）：共享协议实现，含 playback-v5 签名（GPL-3.0 组件）等，对应 Go 的 `passport_sign.go`/`minireel*.go`。
  - `account.js`（68KB）、`qr-code/`、大量 `*.test.js`。
- `webos/app/webos-adapter.js`：让共享 UI 无需改动——包装 `fetch`/XHR/`media.src` 把相对 `/api/*` 等指向 `SERVICE_BASE`；`wakeService()` 先 Luna ping 再 `/api/v1/health`；覆盖 `window.HongguoNativePlayer`（不可用，`webos-html5`）、`window.HongguoTVUpdates`；音频相关 `webos-audio*.js` 实现有声倍速。
- 构建：`scripts/build_webos.sh` 复制 `core/cmd/hongguotv/ui/` → 注入适配脚本 → `sed` 改绝对路径为相对 → `ares-package` 出 `.ipk`。签名/解密/媒体代理只在 Service，不放页面 JS。

## 4. 三端对照速查

| 维度 | Android | Desktop | webOS |
|---|---|---|---|
| 核心 | Go `.so` 子进程 | Go exe sidecar | 无 Go，JS Service |
| UI 来源 | Go embed（WebView 加载） | Go embed（Wails 反代） | 构建期拷贝 `ui/` |
| 数据通道 | 本机 HTTP + JS Bridge | 本机 HTTP + Wails 绑定 | 本机 HTTP（Luna 唤醒） |
| 播放器 | Media3(standard) / libmpv(mpv) | WebView2/WebKitGTK + 可选 WASM 软解 | HTML5 + 有声倍速 JS |
| API 实现 | `core/cmd/hongguotv/*.go` | 同左 | `webos/service/*.js` |
| 端口 | OS 随机 | OS 随机 | 固定 7655 |
| 版本线 | `1.0.x` | `0.2.x` | `0.2.x` |
