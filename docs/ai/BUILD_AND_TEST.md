# 构建、测试与发布

> 配套 [`AGENTS.md`](../../AGENTS.md) §6。构建脚本普遍要求 GitHub Actions 环境变量，本地直接跑会失败——这是防止误发布的设计，本地开发用 `go run` + 浏览器即可。

## 1. 本地开发

```bash
# 起核心（默认 127.0.0.1:8797），浏览器打开 http://127.0.0.1:8797/
go run ./core/cmd/hongguotv

# 自定义端口/数据目录
go run ./core/cmd/hongguotv -port 8798 -data-dir /tmp/hongguo

# 让 desktop 壳指向自建核心
HONGGUO_CORE_PATH=<path-to-core-binary> <desktop app>

# Android 诊断 APK（独立模块，不启动 Go 核心）
gradle -p android :wasm-diagnostic:assembleDebug
```

## 2. 测试命令（改代码后必跑对应项）

```bash
# Go 核心（全量）
go test ./...

# Go 竞态子集（CI 中针对账号/QR 等）
go test -race ./core/cmd/hongguotv -run 'Test(QR|Account|UpSMS|...)'

# JS 单测（项目根执行）
node --test tests/*.test.cjs
node --test tests/desktop*.test.cjs tests/i18n.test.cjs   # 定向

# webOS Service 测试（源码同目录）
cd webos/service && node --test *.test.js

# Python 单测
python3 -m unittest discover -s tests -p "test_*.py"

# Desktop 壳
cd desktop && go test ./... && go vet ./...

# C++ 原生测试（mpv JNI 解析器）
c++ -std=c++17 -Wall -Wextra -Werror tests/mpv_mediacodec_layout_parser_test.cpp -o /tmp/t && /tmp/t

# JS 语法检查（CI 逐个文件 node --check）
node --check core/cmd/hongguotv/ui/app.js

# 真实接口探针（默认跳过，需显式开启对应 HONGGUO_LIVE_* 环境变量）
HONGGUO_LIVE_...=1 go test ./core/cmd/hongguotv -run TestXxxLive
```

**测试框架分布**：`tests/` 下 105 个 `.test.cjs`（Node `node:test`）、10 个 `test_*.py`（unittest）、1 个 C++；Go 测试散落在源码树（57 个 `*_test.go`）；webOS 测试在 `webos/service/*.test.js`。

## 3. 构建入口与产物

统一入口：`go.mod` 在项目根，`go build` 目标均为 `./core/cmd/hongguotv`；版本用 `-ldflags "-s -w -X main.version=$VERSION"` 注入。

| 平台 | 脚本 | CGO | 要点 |
|---|---|---|---|
| Android `.so` | `scripts/buildso_android.ps1`（Windows）/ `scripts/build_android_binaries.sh`（Linux/Mac） | **必须 `CGO_ENABLED=1`**（关闭会破坏设备 DNS） | `GOOS=android GOARCH=arm64\|arm(GOARM=7)\|amd64`，`-buildmode=pie -trimpath`，输出 `jniLibs/<abi>/libhongguotv.so`；API 23（android5 用 21） |
| macOS universal | `scripts/build_desktop.sh` | 0 | amd64+arm64 `lipo -create` + codesign |
| Windows | `scripts/build_desktop.sh` | 0 | core exe + `wails build -platform windows/amd64 -webview2 browser` |
| Linux AppImage | `scripts/build_linux_appimage.sh` | 0 | Debian 12 容器内构建，壳层 `-tags 'production,webkit2_41'` |
| webOS IPK | `scripts/build_webos.sh` | — | 复制 UI + 注入适配 → `ares-package` → `dist/*.ipk` |
| Windows WASM 解码器 | `scripts/build_windows_wasm.sh` | — | Emscripten 4.0.19 + FFmpeg 编译 `decoder.wasm`，仅 Windows |

**典型脚本调用**（CI 实证）：
```bash
powershell -File scripts/buildso_android.ps1 -Version 1.0.0
powershell -File scripts/release_android.ps1 -Version 1.0.1 -Code 101 [-Mpv]
bash scripts/build_desktop.sh      # 需 GITHUB_ACTIONS/HONGGUO_CORE_VERSION/APP_VERSION/DESKTOP_VERSION_CODE/DESKTOP_PLATFORM
bash scripts/build_webos.sh
python3 scripts/release_metadata.py --github-env "$GITHUB_ENV"
python3 scripts/desktop_metadata.py --github-env "$GITHUB_ENV"
python3 scripts/generate_update.py --apk X.apk --version V --code C --min-sdk S --notes docs/releases/vV.md --out update.json
```

## 4. 校验脚本（发布前最后防线）

```bash
python3 scripts/verify_release_source.py --event "$GITHUB_EVENT_NAME" --ref "$GITHUB_REF" --sha "$GITHUB_SHA"  # 拒绝非 main 发布
python3 scripts/verify_apks.py --standard A.apk --mpv B.apk --version V --standard-code C --mpv-code M          # flavor APK 隔离
bash scripts/verify_webos.sh ; python3 scripts/verify_webos_ipk.py
python3 scripts/verify_desktop_core.py ; python3 scripts/verify_desktop_packages.py ; python3 scripts/verify_desktop_ui.py
python3 scripts/test_windows_wasm.py desktop/build/bin
```

Gradle 内还有 `verifyPlayerDependencyIsolation` 任务：解析 resolved artifacts，校验各 flavor 的 Media3 版本精确匹配（standard 1.8.0 / mpv 1.11.1），并禁止 `nextlib`/`ffmpeg`/`media3ext` 混入。

## 5. 脚本清单（按用途）

| 类别 | 脚本 |
|---|---|
| 构建（10） | `build_android_binaries.sh`、`build_desktop.sh`、`build_linux_appimage.sh`、`build_webos.sh`、`build_windows_wasm.sh`、`buildso_android.ps1`、`prepare_mpv.py`、`rebuild_mpv_libraries.py`、`replace_mpv_library.py`、`package_mpv_sources.py`、`package_desktop_app.py`、`render_brand_icons.mjs` |
| 发布/元数据（9） | `release_android.ps1`、`release_metadata.py`、`desktop_metadata.py`、`linux_release_source.py`、`generate_update.py`、`publish_public_release.py`、`publish_desktop_release.py`、`publish_linux_appimage.py`、`publish_webos_update.py` |
| 校验/安全（13） | `verify_release_source.py`、`verify_apks.py`、`verify_android5_apk.py`、`verify_desktop_core.py`、`verify_desktop_packages.py`、`verify_desktop_ui.py`、`verify_webos.sh`、`verify_webos_ipk.py`、`verify_webos_simulator_playback.py`、`verify_mobile_v5_webos.cjs`、`verify_linux_playback.py`、`check_android_update_export.sh`、`check_mpv_software.c` |
| 测试/冒烟（4） | `smoke_android5.py`、`test_linux_appimage.sh`、`test_windows_wasm.py`、`linux_playback_pictures.py` |
| 探针/辅助（6） | `linux_playback_probe.js`、`webos_simulator_probe.js`、`webos_simulator_report_server.js`、`windows_wasm_probe.js`、`run_webos_http_direct_service.js`、`linux_appimage_apprun.sh` |
| 数据（1） | `mpv_sources.json`（LGPL 依赖固定 commit + SHA256） |

## 6. GitHub Actions 工作流

| 工作流 | 触发 | 主要动作 |
|---|---|---|
| `ci.yml` | push / PR / dispatch | 全量测试（Go/JS/Python/C++/双 flavor debug APK）+ core-preview artifact |
| `release.yml` | tag `v*` / dispatch | 签名双 APK + Android5 + MPV 源码 ZIP + 三份 update JSON + SHA256SUMS → GitHub Release + 镜像公开仓库；`concurrency: hongguo-signed-release` |
| `desktop.yml` | dispatch / 指定分支 / tag | macOS universal + Windows x64 ZIP、desktop-update-v2.json、WASM artifact |
| `android5-compat.yml` | push / PR / dispatch | API21 兼容包 + 签名 + 模拟器冒烟 |
| `desktop-window-checks.yml` | push main / PR | 三平台窗口测试 `go test -race -tags production` |
| `linux-appimage.yml` / `linux-playback-validation.yml` | dispatch / 指定分支 / tag | AppImage 构建 + 真实媒体播放验证 + 证据上传 |
| `webos-experimental.yml` | dispatch / 指定分支 / tag | webOS IPK 测试版发布到公开仓库 |
| `windows-wasm-validation.yml` / `wasm-diagnostic.yml` / `mpv-software-check.yml` | dispatch / 指定分支 | 解码器与播放器专项验证 |
| `publish-downloads.yml` / `update-export-checks.yml` / `device-preview.yml` | dispatch / 路径过滤 | 白名单发布、更新导出校验、私有设备预览 |

**共性约定**：`permissions: contents: read`（发布 job 局部提升 `write`）、签名发布用 `concurrency`、`if: always()` 清理临时密钥、产物保留期显式设置（1/3/5 天）、发布前统一 `verify_release_source.py`。

## 7. 发布红线（再强调）

1. `main` 唯一正式源码线；**只有用户明确要求**才递增版本并打 tag。
2. 签名密钥只在 GitHub Secrets，缺一即拒绝构建。
3. 公开仓库只发白名单编译产物，绝不上传源码 checkout。
4. 凭证、原始抓包、媒体文件不入库；协议样本脱敏。
5. LGPL 依赖固定 commit + SHA256 并附源码包；GPL-3.0 移植声明保留。
