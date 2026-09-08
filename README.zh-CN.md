# CBPanel

[English](README.md)

CBPanel 是 [CloakBrowser](https://github.com/CloakHQ/CloakBrowser/) 的本地 Web + Desktop 管理壳程序。

![CBPanel workbench](.github/assets/cbpanel-workbench.png)

## 兼容性说明

开发和 CI 工具链要求 Node.js 26 或更高版本（npm 11 或更高版本），Tauri 桌面壳要求 Rust 1.88.0 或更高版本。目前只测试过 Windows 便携版；其他产物按当前状态提供，不保证可用。

## 快速开始

```bash
npm install
npm run dev
```

如需严格按锁文件安装依赖，请使用 `npm ci`。

开发服务默认运行在：

```text
http://127.0.0.1:4173
```

常用检查：

```bash
npm run typecheck
npm test
npm run build
```

桌面端命令：

```bash
npm run desktop:dev
npm run desktop:portable
npm run release:windows
npm run release:linux
npm run release:mac
```

## Xray 引擎（全能网络支持）

CloakBrowser 自身只支持 HTTP、HTTPS 和 SOCKS5。CBPanel 内置了 **Xray 引擎**，在启动时把其他协议
转换成本地 SOCKS5 代理，因此任何在 v2rayN / Clash 里能用的节点都可以直接给环境使用：

- **协议**：VMess、VLESS、Trojan、Shadowsocks（含 SS-2022）、SOCKS5、HTTP —— 直接粘贴
  `vmess://`、`vless://`、`trojan://`、`ss://`、`socks://`、`http://` 分享链接，或在“代理 → 导入节点”
  中通过订阅地址 / base64 订阅内容批量导入。
- **传输层**：REALITY、XHTTP、gRPC、mKCP、WebSocket、HTTP/2、HTTPUpgrade、QUIC、TCP HTTP 伪装；
  uTLS 指纹默认跟随环境指纹的浏览器品牌，链接自带 `fp` 参数时以链接为准。
- **前置代理（链式代理）**：任意代理（包括普通 socks5/http）都可以指定代理库中的另一条记录作为
  前置代理，形成 `[本机] → [前置代理] → [当前代理] → [网站]`，用于隐藏真实 IP。
- **双栈支持**：每个代理可单独设置 IPv4/IPv6 策略（自动、IPv4/IPv6 优先、仅 IPv4/IPv6），决定
  引擎解析节点地址的方式。
- **代理库工具**：代理列表支持分页与多选，可批量检测可用性、批量检测真延迟（经代理访问轻量
  端点的一次往返耗时）和批量删除；两种检测的最近结果会显示在每一行以及环境编辑器的代理库下拉中。
- **记住订阅**：导入时勾选“记住此订阅”，或在代理管理的“订阅”区域新建，即可保存订阅地址并随时手动
  刷新，也可以设置自动刷新（面板运行期间每 1–168 小时一次）。刷新会让该订阅的节点与地址当前内容
  一致：新增的节点会加入，消失的节点会删除，仅改了备注的节点原地改名。已被环境使用（或被其他代理
  作为前置代理）的节点不会被删除，而是脱离订阅、作为单个代理保留；单个代理不受任何刷新影响。删除
  订阅时默认保留它的节点。

工作方式：每个需要引擎的启动都会拉起独立的 `xray` 进程监听一个回环 SOCKS5 端口，出口检测经该端口
进行，CloakBrowser 以该端口作为代理启动，浏览器关闭时进程一并结束；会话运行期间进程意外退出会在同一
端口自动重启。Xray-core 按需从 GitHub Releases 下载到 `data/xray/`（设置 → 网络 → Xray 引擎，
GitHub 加速镜像设置同样生效），也可以指定自己的 `xray` 可执行文件。

## 下载

产物发布在 [GitHub Releases](https://github.com/lkeme/CBPanel/releases) 页面。

| 平台 | 产物 |
| --- | --- |
| Windows | 安装版 `.exe` 或便携版 `.zip` |
| Linux | x64 `.AppImage` |
| macOS | `.dmg` |

Linux：

```bash
chmod +x CBPanel-linux-x64.AppImage
./CBPanel-linux-x64.AppImage
```

## 许可证

- **CBPanel** — MIT。见 [LICENSE](LICENSE)。
- **CloakBrowser wrapper 代码** — MIT。见 [CloakBrowser LICENSE](https://github.com/CloakHQ/CloakBrowser/blob/main/LICENSE)。
- **CloakBrowser binary**（编译后的 Chromium）— 可免费使用，不可再分发。见 [BINARY-LICENSE.md](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md)。
