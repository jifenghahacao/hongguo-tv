# HTTP API 路由参考

> 权威来源：`core/cmd/hongguotv/main.go:118-166` 的 `mux.HandleFunc` 注册（本文与之同步）。webOS 在 `webos/service/service.js:136-342` 用 JS 复刻同一契约。

## 1. 通用约定

- **主机**：`http://127.0.0.1:<port>`。本地开发默认 `8797`；Android/desktop 为 OS 随机端口（经握手获得）；webOS 固定 `7655`。
- **响应格式**：成功 `writeJSON`（`main.go:497-507`）设 `Content-Type: application/json; charset=utf-8`，结构 `{"ok":true,"data":...}`；失败 `{"ok":false,"error":"..."}`。前端统一解析见 `ui/app.js:550-569` 的 `fetchData()`。
- **方法**：GET 读 / POST 写；方法不符返回 405。
- **状态码**：400 参数错误、401 未登录、405 方法不允许、409 账号切换冲突（`errAccountChanged`）、413 body 过大、502 上游失败、503 未就绪。
- **安全边界**：账号/历史/收藏/播放/评论等敏感路径经 `withCORS`（`main.go:183-207`）→ `privateLocalRequest`（`:209-243`）校验 Host/RemoteAddr 为 loopback、`Sec-Fetch-Site`、Origin、Referer，否则 403；其余路径 `Access-Control-Allow-Origin: *`；统一处理 OPTIONS。`DisallowUnknownFields()`（`account.go:656`）拒绝未知字段，`http.MaxBytesReader` 限制 body。

## 2. 路由全清单

### 2.1 系统/本地存储

| 路径 | Handler | 说明 |
|---|---|---|
| `GET /api/v1/health` | `s.health` | 存活探测 `{"ok":true}` |
| `GET /api/v1/status` | `s.status` | 服务身份/版本/capabilities（握手校验用） |
| `/api/v1/library` | `s.library` | 本地历史/收藏/点赞 |
| `/api/v1/watch-statistics` | `s.watchStatistics` | 观看统计（保留 366 天） |
| `/api/v1/search-history` | `s.searchHistory` | 搜索历史 |
| `/api/v1/feed-history` | `s.feedHistory` | 信息流历史 |
| `/api/v1/ui-settings` | `s.uiSettings` | UI 偏好设置 |
| `/api/v1/feed-cache` | `s.feedCache` | 信息流/播放缓存 |

### 2.2 内容发现

| 路径 | Handler | 说明 |
|---|---|---|
| `/api/v1/category`（+`/Category`） | `s.category` | 分类（大小写别名） |
| `/api/v1/rank`（+`/Rank`） | `s.rank` | 排行榜 |
| `/api/v1/radar` | `s.radarSnapshot` | 榜单雷达 |
| `/api/v1/series/detail`（+`/SeriesDetail`） | `s.seriesDetail` | 剧集详情（含创作者专辑分支） |
| `/api/v1/series/next-season` | `s.nextSeason` | 下一季 |
| `/api/v1/series/seasons` | `s.seriesSeasons` | 系列剧分季 |
| `/api/v1/actors/works` | `s.actorWorks` | 演员作品 |
| `/api/v1/search`（+`/Search`） | `s.search` | 搜索（改写 path 后转 `s.lists`） |
| `/api/v1/search/suggestions` | `s.searchSuggestions` | 联想建议 |
| `/api/v1/search/discovery` | `s.searchDiscovery` | 发现页 |
| `/api/v1/search/phone` | `s.phoneSearch` | 手机号搜索 |
| `/api/v1/number-input` | `s.numberInput` | 数字键盘会话 |

### 2.3 列表分发 `/api/v1/lists/<kind>`

`s.lists`（`lists.go:630-688`）按 `kind` 分发：`recommend` / `new` / `rank` / `calendar` / `reservations` / `search`。`search` 分支走 `s.searchList`（`search_web.go:22`，官网免登录备用链路）。

### 2.4 账号体系 `/api/v1/account` 与 `/api/v1/account/`

`s.account`（`account.go:628-688+`）按子路径分发：`send-code` / `login` / `verify` / `cancel` / `logout` / `sync`；`GET` 返回账号状态。子路由：
- `/api/v1/account/qr/*` → `s.accountQR`（`account_scan.go:367`，扫码登录）
- `/api/v1/account/import-history` → `s.importGuestHistory`（`guest_history.go:149`）

账号切换用 `sameGeneration()` 做竞态防御（`main.go:391,420`、`lists.go:647,679`）。

### 2.5 社交/互动

| 路径 | Handler | 说明 |
|---|---|---|
| `/api/v1/follow` | `s.follow` | GET 列表 / POST 追更开关 |
| `/api/v1/notifications` | `s.notifications` | 通知 |
| `/api/v1/reservation` | `s.reservation` | 预约 |
| `/api/v1/comments` | `s.discussion` | 评论 |
| `/api/v1/danmaku` | `s.discussion` | 弹幕 |
| `/api/v1/replies` | `s.discussion` | 回复 |
| `/api/v1/player/action` | `s.playerAction` | 播放控制（POST） |
| `/api/v1/player/stats` | `s.engagement` | 观看行为上报 |
| `/api/v1/player/diagnostics` | `s.playbackDiagnostics` | 播放诊断 |

### 2.6 播放与媒体

| 路径 | Handler | 说明 |
|---|---|---|
| `/api/v1/play/info`（+`/PlayInfo`） | `s.playInfo` | 播放解析（`mode=range`；含 playCache、画质/编码/内容类型归一化） |
| `/api/v1/playback/custom-device` | `s.playbackCustomDevice` | 自定义设备 |
| `/minireel-proxy/resolve` | `handleMiniReelResolve`（`minireel.go:278`） | 播放源解析 |
| `/minireel-proxy/media/` | `handleMiniReelMedia`（`minireel.go:302`） | 本地 MP4 / Range 媒体路由 |

### 2.7 投屏

| 路径 | Handler |
|---|---|
| `/api/v1/cast/devices` | `s.castDevices` |
| `/api/v1/cast/start` | `s.castStart` |
| `/api/v1/cast/stop` | `s.castStop` |
| `/api/v1/cast/status` | `s.castStatus` |

投屏实现按平台分文件：`cast_ssdp_linux.go`（`//go:build linux`）/ `cast_ssdp_other.go`（`!linux`）。

### 2.8 页面

`/` → `serveUI(root)`，提供内嵌 UI，所有页面资源 `Cache-Control: no-store`。

## 3. 桌面壳专有端点

由 `desktop/corehost.go:277-297` 处理（非核心路由）：
- `/desktop/status`：核心启动状态
- `/desktop/retry`：重试启动核心
- `/windows-wasm/*`：`corehost.go:274-276` 拦截，提供 WASM 解码器资源（仅 Windows）

## 4. 新增接口的检查清单

- [ ] 在 `main.go` 注册路由，并判断是否需要 `withCORS` 的私密校验。
- [ ] DTO 用大驼峰导出 + `json:"snake_case"` 标签；错误用 `errXxx` 哨兵。
- [ ] `context.Context` 贯穿上游调用；上游失败映射 502，未就绪 503。
- [ ] 写 `*_test.go`（用 `net/http/httptest` + `testdata/*.json` 合成 fixture）。
- [ ] 若 webOS 需要该功能，同步在 `webos/service/service.js` 与 `provider.js` 实现。
- [ ] 更新本文件路由表。
