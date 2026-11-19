# AGENTS.md — hongguo-tv 项目导航与全局约定

> 本文件是所有 AI 助手与开发者进入本项目时**首先阅读**的入口。目标是让你在最短时间内知道：这是个什么项目、改一处代码要去哪些地方、必须遵守哪些约定、如何验证改动。
>
> 专题细节见 [`docs/ai/`](docs/ai/) 下的分册，本文件只做导航与"必须知道"的约定。
> 项目事实以源码为准；本文件与 `docs/` 下的规范文档冲突时，以 `docs/` 中带日期/版本的规范文档和源码为准，并请顺手修正本文件。

---

## 1. 一句话定位

**红果短剧 TV** 是一个"**原生壳 + Go 本机核心 + 一套内嵌 Web UI**"的跨平台短剧客户端，覆盖 **Android TV / webOS / macOS / Windows / Linux**。前端 UI 只有**一份真源**，由 Go 核心内嵌并通过本机 HTTP 提供；各端外壳负责拉起核心、桥接原生能力。

- 源码主仓库：`https://github.com/jifenghahacao/hongguo-tv`（私密主仓库，真实源码与签名发布）
- 公开仓库：`https://github.com/aston314/hongguo-tv-releases`（只放编译产物、Release、issue 反馈；`go.mod` module 名用的是 `github.com/aston314/hongguo-tv`）
- 主分支：`main`，是**所有平台唯一的正式源码线**。

## 2. 技术栈速览

| 层 | 技术 | 位置 |
|---|---|---|
| 业务核心 | Go 1.25，单包 `main`，标准库 `net/http` + `//go:embed` | `core/cmd/hongguotv/` |
| Web UI | 原生 ES5 JS / HTML / CSS，**无框架、无打包器** | `core/cmd/hongguotv/ui/`（唯一真源） |
| Android TV | Java + Gradle 8.13 / AGP 8.13.2 + WebView + Media3 / libmpv | `android/` |
| Desktop | Wails v2（Go + WebView2/WebKitGTK） | `desktop/` |
| webOS | LG webOS JS App + Node Luna Service（**不含 Go**） | `webos/` |
| 测试 | Go `testing`、Node `node:test`、Python `unittest`、C++ `assert` | 各源码目录 + `tests/` |
| CI/CD | GitHub Actions（15 个 workflow） | `.github/workflows/` |

唯一第三方 Go 依赖：`github.com/skip2/go-qrcode`。**不要轻易引入新依赖**——这个项目的设计取向是尽量用标准库。

## 3. 目录路由表：改什么，去哪里

这是本文件最重要的部分。找到你要改的东西落在哪一行，再去对应目录。

| 我要改… | 去这里 | 提醒 |
|---|---|---|
| 页面布局、样式、交互、找剧/榜单/详情/播放页前端逻辑 | `core/cmd/hongguotv/ui/`（`app.js`、`app.css`、`index.html`、`mobile.html` 等） | **不要改** `android/assets` 或 `desktop/frontend` 里的 UI，那不是真源 |
| 新增/修改 HTTP 业务接口（分类、搜索、榜单、账号、评论…） | `core/cmd/hongguotv/` 下对应 `*.go`，路由注册在 `main.go` 的 `mux.HandleFunc` | 新增路由须同步 `docs/ai/API.md`；敏感路径要过 `withCORS`/`privateLocalRequest` |
| 红果上游 API 调用、签名、协议适配 | `hongguo_client.go`、`passport_*.go`、`minireel*.go`、`playback_*.go` | 协议改动必须有证据，见 `docs/protocol-evidence.md` |
| 播放解析、缓存、Range 媒体、解码回退 | `minireel*.go`（Go 侧）；`ui/native-player.js`（前端）；Android 播放器见下 | 播放有 standard/mpv 两套，务必分清 |
| Android 原生能力（JS Bridge、遥控器、更新、推荐应用/频道） | `android/app/src/main/java/rocks/aston/hongguotv/` | 改 Bridge 要同时改 `ui/` 里的 JS 消费端 |
| Android 播放器（Media3 标准版 / libmpv 版） | `src/main/PlayerBridge.java`(standard) vs `src/mpv/MpvPlayerBridge.java`(mpv) | 两 flavor 共享 `NativePlayerAdapter` 契约；依赖隔离由 `verifyPlayerDependencyIsolation` 守护 |
| Android 构建/flavor/签名 | `android/app/build.gradle`、`scripts/buildso_android.ps1`、`scripts/build_android_binaries.sh` | 见 §5 签名红线 |
| Desktop 壳行为（窗口、更新、退出、代理、WASM 解码器） | `desktop/*.go`、`desktop/frontend/`（仅是加载页）、`desktop/wasm/` | 业务 UI 仍来自 core 的 embed |
| webOS 应用与服务 | `webos/app/webos-adapter.js`（前端适配）、`webos/service/*.js`（重实现 API 契约） | webOS **不跑 Go**，改 Go 接口后要同步 JS Service |
| 构建 / 发布 / 校验脚本 | `scripts/` | 见 [`docs/ai/BUILD_AND_TEST.md`](docs/ai/BUILD_AND_TEST.md) |
| 自动化测试 | 配套 `*_test.go`、`ui` 旁 `*.test.js`、`tests/*.test.cjs`、`tests/test_*.py` | 改功能必须补测试 |
| 协议证据、设计决策、发布说明 | `docs/`（79 篇规范/研究 + `releases/` 167 篇版本说明） | 写新文档用"日期 + 已验证/待验收边界"风格 |

## 4. 核心架构：三条必须理解的机制

**① 一套 UI，四处运行。** `core/cmd/hongguotv/main.go` 用 `//go:embed ui` 把 `ui/` 编进二进制，通过本机 HTTP 提供。Android 的 WebView、desktop 的 Wails WebView 都是加载这个页面；webOS 则在构建时把同一份 `ui/` 拷进 IPK。所以**UI 只改一处**。

**② 本机 HTTP 是统一契约。** 所有业务数据走 `http://127.0.0.1:<port>/api/v1/*` 与 `/minireel-proxy/*`。前端统一 `fetch('/api/v1/...')`。完整路由见 [`docs/ai/API.md`](docs/ai/API.md)。

**③ 启动握手与进程守护。** 外壳以 `-port 0 -instance-id <uuid> -parent-pid <ppid>` 启动核心；核心向 stdout 打印 `HONGGUO_TV_READY <port> <instance-id>`；外壳解析后轮询 `/api/v1/status` 校验 `service/instance_id/version` 一致才加载页面。父进程消失则核心自杀。**改启动参数或版本号必须同时改 `CoreService.java` / `desktop/corehost.go` / `main.go` / 构建脚本的 `-X main.version`。**

进程与数据流详见 [`docs/ai/ARCHITECTURE.md`](docs/ai/ARCHITECTURE.md)。

## 5. ⚠️ 全局约定与红线（务必遵守）

### 版本与发版
- `main` 是唯一正式源码线；**只有用户明确要求发版时**才递增版本并打 `vX.Y.Z` tag。不要擅自发版或打 tag。
- 版本规则 `主.次.修订`（见 `CHANGELOG.md`）。tag 必须位于 `main` 历史上；CI 用 `verify_release_source.py` 强制校验。
- 注意版本双线：Android 为 `1.0.x`（`android/app/build.gradle` 的 `appVersion`/`versionCode`，standard 106、mpv 100 各自独立递增）；desktop/webOS 仍为 `0.2.172`。**不要试图把它们强行统一。**

### 安全与合规（不可逾越）
- 签名密钥**只能**来自 GitHub Secrets：`ANDROID_KEYSTORE_FILE/PASSWORD`、`ANDROID_KEY_ALIAS/PASSWORD`。缺变量时 Gradle 直接抛错（"Never upload an unsigned APK"）。
- **绝不入库**：账号凭证、Cookie/Token、设备身份、原始抓包、媒体文件（`.gitignore` 排除 `fixtures/raw/`）。协议样本必须脱敏（`docs/protocol-evidence.md`）。
- LGPL 依赖（libmpv、FFmpeg 等）固定 commit + SHA256（见 `scripts/mpv_sources.json`），分发时附源码包与声明（`THIRD_PARTY_NOTICES.md`）。playback-v5 签名移植自 GPL-3.0 项目，保留声明。
- 敏感接口（账号/历史/播放/评论）必须经 `privateLocalRequest` 校验 loopback + Origin/Referer，防止本地网络被跨站调用。
- 公开仓库只发布白名单编译产物（`scripts/publish_public_release.py` 明确 "Never upload the source checkout"）。

### 编码风格（详见 [`docs/ai/CONVENTIONS.md`](docs/ai/CONVENTIONS.md)）
- **注释语言**：源码注释以英文为主（可夹中文业务语义）；文档、CHANGELOG、发布说明、测试用例字符串以中文为主；测试名用英文。
- **命名**：Go 文件 `snake_case.go`、内部标识小驼峰、JSON 标签 `snake_case`、Tab 缩进；JS 文件 `kebab-case.js`、全局命名空间 `window.Hongguo*`、ES5 风格（`var`/`function`/IIFE/`'use strict'`）；Python `snake_case.py`。
- 平台差异用**文件后缀 + `//go:build` 标签**分离（`*_linux.go` / `*_other.go` / `*_windows.go` / `*_darwin.go`），不要在运行时用大量 if 判断平台。
- 错误用 `errXxx` 哨兵 + `errors.Is` 判别；`context.Context` 贯穿上游调用；本地 JSON 存储用 `sync.Mutex` 保护。

## 6. 常用命令速查

```bash
# —— 本地跑核心（默认 127.0.0.1:8797）——
go run ./core/cmd/hongguotv

# —— 测试（改动后必跑对应项）——
go test ./...                                   # Go 全量
node --test tests/*.test.cjs                    # JS 单测
python3 -m unittest discover -s tests -p "test_*.py"
cd desktop && go test ./... && go vet ./...     # 桌面壳

# —— 真机/真实接口探针（默认跳过，需显式开启环境变量）——
HONGGUO_LIVE_...=1 go test ./core/cmd/hongguotv -run TestXxxLive

# —— 构建入口（多在 CI 内执行，见专题文档）——
powershell -File scripts/buildso_android.ps1 -Version 1.0.0
bash scripts/build_desktop.sh    # 需 GITHUB_ACTIONS 等环境变量
bash scripts/build_webos.sh
```

> 构建脚本普遍要求 GitHub Actions 环境变量，本地直接跑会失败——这是有意为之，防止误发布。本地开发直接用 `go run` + 浏览器打开即可。

## 7. 配套文档索引

| 文档 | 内容 | 何时读 |
|---|---|---|
| [`docs/ai/ARCHITECTURE.md`](docs/ai/ARCHITECTURE.md) | 进程模型、握手协议、UI 单一真源、三端消费方式、数据流 | 改动跨端或核心启动时 |
| [`docs/ai/API.md`](docs/ai/API.md) | `/api/v1/*` 与 `/minireel-proxy/*` 完整路由、二级分发、状态码、安全边界 | 新增/修改接口时 |
| [`docs/ai/CONVENTIONS.md`](docs/ai/CONVENTIONS.md) | 命名、注释、错误处理、并发、测试、版本与提交约定 | 写第一行代码前 |
| [`docs/ai/BUILD_AND_TEST.md`](docs/ai/BUILD_AND_TEST.md) | 各平台构建、脚本清单、测试命令、CI 工作流 | 构建或发布前 |
| [`docs/ai/PLATFORMS.md`](docs/ai/PLATFORMS.md) | Android / desktop / webOS 各端模块导读 | 深入某个平台时 |

原项目规范文档入口见 [`README.md`](README.md) 的"参考文档"一节，尤其是 `docs/tv-design.md`、`docs/protocol-evidence.md`、`docs/build-plan.md`、`docs/player-editions.md`、`docs/release-runtime.md`、`docs/development-and-release-flow.md`。

## 8. 给 AI 助手的操作清单

1. **先路由**：用 §3 定位要改的文件，确认是否跨端联动（UI/Go/Bridge/Service 常需同步修改）。
2. **守住红线**：不擅自发版、不接触真实凭证、不引入新依赖、不改 flavor 依赖隔离。
3. **保持契约**：改接口同步 `API.md`，改启动参数同步握手三处，改 UI 只改 `ui/` 真源。
4. **补测试 + 验证**：按 §6 跑对应测试；能本地验证的就 `go run` 起服务用浏览器实测。
5. **更新文档**：架构/约定有变化时，同步更新本文件与 `docs/ai/` 对应分册。
