# CBPanel 与上游文档的偏离

本文件记录 CBPanel 相对 [CloakBrowser 文档](https://github.com/CloakHQ/CloakBrowser/) 的**有意偏离**。
它不属于 README 的职责：README 面向首次接触本项目的人，回答"这是什么、怎么装、怎么跑"；
本文件面向同步与评估，回答"哪些地方我们故意和上游不一样，为什么，下次对齐时要不要改"。

- 中文版：本文件
- English: [UPSTREAM-DEVIATIONS.en.md](UPSTREAM-DEVIATIONS.en.md)
- 判断依据：已同步的上游版本见 `package.json` 的 `upstream.cloakbrowser`（`syncedCommit` / `npmPackage`）。
- 维护规则：**新增或撤销一条偏离时，两种语言必须同步改**；没有对应条目的行为差异应当视为缺陷，而不是偏离。
- 重新引入的触发条件：若面板开始脚本化操作页面（自动点击、按选择器取值、表单预填），`humanPreset` 与
  `humanConfig` 才第一次有作用；届时重新引入时必须同时补上 preset 白名单校验。

## 同步时的检查顺序

1. 先看 `package.json` 的 `upstream.cloakbrowser.syncedCommit` 与目标上游 commit 之间改动了哪些文档段落。
2. 对照下表逐条确认：上游是否已经改变了默认值或语义？若上游已经变成我们想要的行为，删除该行；
   若上游新增了相关约束，补到"原因"里。
3. 再看 [CBPanel 扩展](#cbpanel-扩展不属于上游语义)一节：上游是否已经原生提供，若已提供则删除我们的实现或改写为复用。
4. 最后核对实现位置（每行末尾的代码锚点），确认文档描述与当前代码一致。

## 有意偏离

| 项 | 上游默认 | CBPanel | 原因 | 实现位置 |
| --- | --- | --- | --- | --- |
| `CLOAKBROWSER_AUTO_UPDATE` | `true` | `false` | 面板接管内核的安装、更新与回滚；允许 wrapper 自行更新会让版本与面板记录不一致。显式发起更新时会临时置回 `true`。 | `server/services/binaryService.ts` |
| `CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS` | `5` | `20` | 住宅代理首次 GeoIP 探测常超过 5 秒；可在浏览器内核设置的自定义环境变量中调回。 | `server/services/binaryService.ts`、`src/shared/settings.ts` |
| 启动方式 | `headless: true` | 可见窗口，且无绕过入口 | 面板没有 CDP/截图入口，无头会话既不可见也不可操作；上游反检测推荐配置本身也是 `headless=False`。`launchOptions` 不再接受 `headless`（见下方白名单一行），编辑器里已没有任何途径让启动变成无头。 | `src/shared/profile.ts`（`defaultProfile`） |
| `launchOptions` / `contextOptions` | wrapper 原样转发的自由对象 | `launchOptions` 改为白名单（`timeout`、`slowMo`、`downloadsPath`、`tracesDir`）；`contextOptions` 拒绝面板或 wrapper 已接管的五个键 | `launchOptions` 的键是**替换**而非补充——`args` 会把整份生成的指纹参数换掉——且每个键面板都有对应控件。`contextOptions` 的 `viewport`/`userAgent`/`colorScheme` 由面板字段写入，`locale`/`timezoneId` 会被 wrapper 剥离。两者在解析阶段即报错，启动形状不会与编辑器显示不一致。 | `src/shared/profile.ts`（`parseOptionalJsonObject`、`LAUNCH_OPTION_ALLOWED_KEYS`、`CONTEXT_OPTION_PANEL_OWNED_KEYS`） |
| 运行器 | 三个 launch API | `launchPersistentContext` / `launchContext` | 面板模型是一个环境对应一个 profile 会话，只需要 BrowserContext；持久模式的扩展加载与登录保持依赖真实 user data dir。 | `src/shared/profile.ts`（`buildLaunchPreview`） |
| `humanize` | `false` | 每次启动都为 `true`，使用上游 `default` 预设且不传覆盖值 | 面板只打开、导航与注入，从不驱动拟人化层所补丁的元素交互；因此 preset 与 `humanConfig` 只会去调一段本次启动根本不执行的代码。两者都不再暴露——此外未知 preset 会让 wrapper 在浏览器进程已存在之后抛错。 | `src/shared/profile.ts`（`buildLaunchPreview`） |
| Stealth args | 有开关 | 无开关，恒为缺省开启 | 面板内不存在需要关闭默认隐身参数的场景；关闭会连带停用 `.cloakbrowser-seed` 的读写，使持久环境每次启动都变成新身份，而这正是面板要避免的状态。 | `src/shared/profile.ts`（`buildLaunchPreview`） |
| `--license-route` | `auto` | 派生值：环境经代理启动时为 `proxy`，否则为 `direct` | `auto` 的语义是"先直连，失败后经 `--proxy-server` 重试一次"，对已经走代理的启动描述不准，无代理时那个重试也不存在。路由按启动实际使用的代理（含 Xray 的本地回环入站）计算，不再需要单独的控件同步。 | `src/shared/profile.ts`（`licenseRouteFor`） |
| `--fingerprint-transparent-proxy-dns` | 可填 `local` 或自定义 DoH | 不暴露，固定为文档缺省（经代理的 Cloudflare DoH） | 该缺省正是"增强代理"这一模式的意义所在；把解析方式改成 `local` 等于退回普通代理，暴露它只会制造与开关语义矛盾的组合。 | `src/shared/profile.ts`（`ENHANCED_PROXY_FLAG`） |
| 扩展加载 | `extensionPaths` 选项，wrapper 自行拼 `--load-extension` / `--disable-extensions-except` | 面板自己把两个开关写进 `args`（`--load-extension=…` + `--disable-extensions-except=…`，逗号拼接），不再传 `extensionPaths` | Chromium 137 移除了 `--load-extension` 原生开关，实测所配内核（156.0.8078.47）单给该参数完全不加载，连 `--disable-features=DisableLoadExtensionCommandLineSwitch` 这个旧逃生口也已不存在；真正生效的是 143+ 的 `--disable-extensions-except` 显式允许清单。把这一对放进面板生成的 args，是为了让实际启动形状出现在"有效参数"预览里、不再依赖 wrapper 内部恰好也写了后者；同时与预检的逗号路径拦截、`assertExtensionsLaunchable` 使用同一套语义。 | `src/shared/profile.ts`（`extensionLoaderArgs`、`buildFingerprintArgs`）、`server/services/sessionService.ts`（`assertExtensionsLaunchable`） |
| 临时模式的扩展 | 无约束（wrapper 都接受 `extensionPaths`） | 临时模式一律拒绝启动带扩展的环境（预检 fail + 会话侧 409 `EXTENSION_EPHEMERAL_UNSUPPORTED`） | 实测 `launchContext`（临时上下文）即使命令行带齐两个开关也不加载扩展：service worker 与内容脚本都没有起来，只在 `Target.getTargets` 留一个孤立 SW target。原先把这种情况记为"数据不持久"的 warn 会让人误以为扩展能用；改为拒绝后，只有持久模式（真实 user data dir）可以绑定扩展。 | `src/shared/profile.ts`（`preflightProfile`）、`server/services/sessionService.ts`、`src/components/profiles/ProfileEditorAdvancedPanels.tsx` |

## CBPanel 扩展（不属于上游语义）

以下能力不在 CloakBrowser 文档范围内，**不要**与上游语义混用：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 环境水印（`watermark`） | 关闭 | 在每个页面注入一个可检测的 DOM 节点，用于区分多开窗口；`banner` / `enhanced` 两种样式都会留下可被关联的信号。 |
| 语音列表裁剪（`voices`） | 开启 | 把 `speechSynthesis.getVoices()` 裁剪为宿主列表的稳定子集；否则每个环境都返回同一份语音表，声明 macos/linux 的环境出现 Windows 语音会穿帮。与内核自带的语音表可能重叠。 |
| 无代理时的 GeoIP | 跟随本机出口 | 上游的 `geoip` 面向代理场景；未配置代理时面板仍走一次出口探测，跟随本机公网出口推导时区与语言。 |
| 身份回显与重置 | — | Seed 是只读回显（位于编辑器左侧 tabs 底部，跨页常驻），不是可输入项；`重置身份` 删除用户数据目录中的 `.cloakbrowser-seed`，下次启动生成新身份。 |
| 面板自更新检查 | 启动时检查一次（24h TTL），结果落 `appUpdate.lastUpdateCheck` | 只检查与提示，不下载、不安装：读取 Release 资产 `app-update-manifest.json`，与 `package.json#version` 比对；有更新时侧边栏设置齿轮显示圆点，关于页提供安装包直链。检查无开关，24h TTL 即上限。 | `server/services/appUpdateService.ts`、`src/shared/appUpdate.ts` |
| 授权路由派生 | — | 见上表 `--license-route` 一行。 |
| 手动扩展路径列表 | 无此概念（扩展目录由 `extensionPaths` 选项传入） | 不提供；扩展目录只来自扩展库绑定 | 该列表是扩展库落地前的过渡入口，与扩展库的 `local-directory` 导入完全重叠且优先级被静默覆盖（绑定了任何库扩展时整表丢弃）。去除后扩展来源只剩一条路径：环境绑定 → `extensionService` 解析 → 启动开关，预览/快照/导出共用同一套解析规则。存量 profile 中的该字段在归一化时丢弃。 | `src/shared/profile.ts`（`mergeProfile`、`buildFingerprintArgs`）、`server/services/sessionService.ts`（`resolveRuntimeProfile`）、`src/shared/extensionDisplay.ts`（`launchExtensionPaths`） |
| WebRTC 出口取值的优先级 | wrapper 先解析 `--fingerprint-webrtc-ip=auto`（无代理则删除），再由 `geoip` 追加解析到的出口 IP | 编辑器把"实际生效的出口"折叠成四态只读推导（`effectiveWebrtcIpMode`）：`custom` > `geoip` > `auto` > `off` | `custom` 存在时 wrapper 不再追加；`geoip` 的追加发生在 `auto` 解析之后，所以 GeoIP 生效时 auto 到不了自己的查询；`auto` 只在 GeoIP 不注入出口时才独立生效，而它只认代理出口，无代理即被删。编辑器因此只保留三个存储档位，派生状态用提示文案说明，不再用一个假的「跟随 GeoIP」档位冒充存储值。 | `src/shared/profile.ts`（`effectiveWebrtcIpMode`、`geoipInjectsWebrtcExitIp`）、`src/components/profiles/ProfileEditorFingerprintFields.tsx` |

## 相关取舍与排障

### Linux 字体

上游文档把 emoji / CJK / Windows 字体缺失列为代理、GeoIP 和可见窗口都正确之后最常见的被拦原因。
运行前检查会读取 `fc-list`，缺少字体时给出 warn；需要时安装 `fonts-noto-color-emoji`、`fonts-noto-cjk`
与 Windows 兼容字体，或设置 `CLOAKBROWSER_SUPPRESS_FONT_WARNING=1`（仅在已接受该取舍时）。

### 版本门槛

指纹参数按 Chromium 版本分档，代码里按"首个支持的版本"判断，不要把它们当作固定能力：

| 参数 | 最低版本 |
| --- | --- |
| `--fingerprint-search-engine` | Linux `155.0.8059.39.2+`；其余平台 `156+` |
| `--fingerprint-max-touch-points` | `156+` |
| `--fingerprint-transparent-proxy-dns` | 仅 Linux 与 Windows（面板不暴露，见上表） |

Chromium 侧的版本门槛另有一条：`--load-extension` 在 137 起不再加载 unpacked 目录，
`--disable-extensions-except` 从 143 起是官方允许清单。面板始终同时写这两个开关（见上表"扩展加载"一行），
因此跨版本都成立；单独依赖 `--load-extension` 的旧写法在 137+ 上会静默失效。

### 变更记录

改动本文件时，在同一份提交里同步更新两种语言；若某条偏离被撤销，直接删除该行并在提交信息里写明
原因，不要留下"曾经偏离"的历史条目——`git log` 已经承担了那部分职责。
