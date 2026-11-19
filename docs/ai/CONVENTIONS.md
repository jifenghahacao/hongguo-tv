# 编码风格与项目约定

> 本文汇总从代码中观察到的实际约定（不是理想规范）。写第一行代码前先读。配套 [`AGENTS.md`](../../AGENTS.md) §5。

## 1. 语言与注释

| 位置 | 注释/文案语言 | 证据 |
|---|---|---|
| Go / Java / JS 源码注释 | **英文为主**，可夹中文业务语义 | `main.go:21-24`、`scripts/prepare_mpv.py:1`、`account_scan.go:130-131`（中文示例） |
| 文档 / CHANGELOG / 发布说明 | **中文** | `docs/*.md`、`docs/releases/*.md`、`CHANGELOG.md` |
| 测试用例名 | 英文 | `test('MFA, cancellation ...')` |
| 测试数据/业务字符串 | 中文常见 | `tests/account-feedback.test.cjs:41` `'测试发码请求被拒绝（1003）'` |

写代码时遵循既有风格：**新注释用英文**，业务语义说明可用中文。

## 2. 命名约定

### Go（`core/cmd/hongguotv/`，单包 `main`）
- 文件 `snake_case.go`（`playback_v5_sign.go`、`account_scan.go`）；Tab 缩进（gofmt 默认）。
- 内部类型/函数小驼峰、非导出：`hongguoClient`、`accountManager`、`miniReelState`、`newXxx` 构造器。
- API DTO 大驼峰导出：`Drama`、`PlayInfo`、`ListResult`、`statusResponse`。
- JSON 标签统一 `snake_case`（`main.go:48-55` 的 `instance_id`、`started_at`）。
- 错误哨兵 `errXxx`：`errAccountChanged`、`errMiniReel*`、`errSearchParameters`。
- Handler 接收者统一 `s *server`；测试函数 `TestXxx`。

### JavaScript（`ui/`、`webos/`、`tests/`）
- 文件 `kebab-case.js` / `.test.cjs`；ES5 风格：`var`、`function`、IIFE、`'use strict'`；2 空格缩进。
- 全局命名空间 `window.Hongguo*`：`HongguoTV`、`HongguoDesktop`、`HongguoWebOS`、`HongguoDesktopUI`、`HongguoNativePlayer`。
- 平台适配层：`desktop.js`、`native-player.js`、`windows-wasm-player.js`、`webos-adapter.js`。
- webOS Service 用可注入工厂：`createService(options)`（`service.js:7`），测试文件与源码同目录 `*.test.js`。

### Java（`android/`）
- 纯 Java（无 Kotlin），包名 `rocks.aston.hongguotv`，4 空格缩进。
- 多数类 package-private `final class`；静态工厂 `create(...)`；大量嵌套状态类 `static final class Session`。
- 后缀语义：`*Policy`（纯决策）、`*State`（状态机）、`*Bridge`（JS/原生桥）、`*Manager`（生命周期）、`*Receiver`、`*Provider`。

### Python / C++
- Python 模块 `snake_case.py`，常量 `UPPER_CASE`，测试类 `XxxTests(unittest.TestCase)`。
- C++ 命名空间 `hongguo_mpv` + 小驼峰函数。

## 3. 错误处理

- Go：显式 `if err != nil → writeError(w, status, err.Error())`；用 `errors.Is` 判别哨兵（`main.go:326`、`runtime.go:77`）。
- `context.Context` 贯穿所有上游调用，支持取消。
- 入口防御：`@JavascriptInterface` 对 id 用正则 `[A-Za-z0-9_-]{1,80}`、payload 长度、URL scheme（HTTPS only）白名单校验（`PlayerBridge.java:138-148`、`RecommendedApps.java:349-371`）。
- 日志仅用标准库 `log`（`log.Printf`/`log.Fatalf`），无结构化日志框架；**敏感数据不外泄**（desktop 把 core stderr 设为 `io.Discard`，`corehost.go:107-108`；mpv JNI 在 native 侧分类日志，绝不把含签名媒体 URL 的原始日志传给 Java/WebView，`bridge.cpp:86-101`）。

## 4. 状态与并发

- `context.WithCancel` + `go s.accounts.run(ctx)` 后台任务（`main.go:73-74,113`）。
- `sync.Mutex`/`RWMutex` 保护本地 JSON 存储（`library.go:63`、`corehost.go:28`）。
- `sync.OnceValues` 惰性初始化协议表（`playback_v5_sign.go:85`）。
- `time.NewTicker` 父进程轮询（`runtime.go:41-52`）；带缓冲 channel 做启动握手与超时（`corehost.go:122-158`）。
- `sameGeneration()` 防止异步账号切换结果污染旧 generation（`main.go:391,420`）。
- Java 侧播放器有显式栅栏：`stop fence` / `generation` / `source-switch state`（`MpvPlayerBridge.java`）。

## 5. 平台差异代码

用**文件后缀 + `//go:build` 标签**分离，不要在运行时写大量平台分支：

| 文件 | 条件 |
|---|---|
| `cast_ssdp_linux.go` | `//go:build linux` |
| `cast_ssdp_other.go` | `//go:build !linux` |
| `media_cache_lease_unix.go` | `//go:build unix` |
| `media_cache_lease_other.go` | `//go:build !unix` |
| desktop `*_linux.go` / `*_other.go` / `*_windows.go` / `*_darwin.go` | 同上 |

Android flavor 差异靠**源码集**：`src/main/`（共享）、`src/standard/`（Media3）、`src/mpv/`（libmpv），编译期由 `PlayerFactory` 分派。

## 6. 配置与版本

- Go flag：`-port`（默认 8797）、`-instance-id`、`-parent-pid`、`-data-dir`（`main.go:58-62`）。
- 环境变量用 `envOr(name, fallback)` 统一封装（`hongguo_client.go:200-205`）：`HONGGUO_API_BASE`、`HONGGUO_WEB_BASE`、`HONGGUO_USER_AGENT`、`HONGGUO_TV_DATA_DIR`、`MINIREEL_CACHE_DIR`、`HONGGUO_CORE_PATH`（desktop）。
- 版本注入：`-ldflags "-X main.version=$VERSION"`（`main.go:27 var version = "0.2.9-dev"`）。
- 版本规则 `主.次.修订`，tag `vX.Y.Z`；Android `versionCode` 独立递增（standard 106 / mpv 100）；desktop/webOS `0.2.172`。详见 `CHANGELOG.md`、`docs/release-runtime.md`。

## 7. 提交约定

类 Conventional Commits，历史前缀统计：`fix`(194) / `release`(75) / `feat`(72) / `chore`(31) / `test`(27) / `docs`(22) / `ci`(21)。
- 功能提交用中文概述，如 `v1.0.6: 观看历史去掉全部记录文字; ...`
- 发布提交用英文，如 `release: v1.0.6 update manifest`，也支持 scope `fix(release): ...`。
- **不要自行发版或打 tag**，只有用户明确要求时才做（`docs/development-and-release-flow.md`）。

## 8. 测试约定

- 新增业务逻辑必须补测试；测试文件就近（Go `*_test.go`、webOS `*.test.js`）或放 `tests/`。
- Go：`net/http/httptest` + 表驱动 `t.Run` + `testdata/*.json` 合成 fixture；真实接口探针默认跳过，需 `HONGGUO_LIVE_*=1`。
- JS：Node 内置 `node:test` + `node:assert/strict`，用 `vm.createContext` 加载 `ui/app.js` 片段做隔离测试；共享文案用 `tests/helpers/app-text.cjs` 注入。
- 权限断言区分平台：Windows 跳过 Unix 权限位断言（`search_history_test.go:44` `runtime.GOOS != "windows"`）。
- fixture 必须合成/脱敏，**禁止入库真实凭证、原始抓包、媒体文件**（`.gitignore:10` 排除 `fixtures/raw/`）。
