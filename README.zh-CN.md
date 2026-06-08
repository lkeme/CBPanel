# CBPanel

[English](README.md)

CBPanel 是 [CloakBrowser](https://github.com/CloakHQ/CloakBrowser/) 的本地 Web + Desktop 管理壳程序。

![CBPanel workbench](.github/assets/cbpanel-workbench.png)

## 快速开始

```bash
npm install
npm run dev
```

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
npm run release:windows
npm run release:linux
```

## 下载

| 平台 | 产物 |
| --- | --- |
| Windows | 安装版 `.exe` 或便携版 `.zip` |
| Linux | x64 `.AppImage` |

Linux：

```bash
chmod +x CBPanel-linux-x64.AppImage
./CBPanel-linux-x64.AppImage
```

## 许可证

- **CBPanel** — MIT。见 [LICENSE](LICENSE)。
- **CloakBrowser wrapper 代码** — MIT。见 [CloakBrowser LICENSE](https://github.com/CloakHQ/CloakBrowser/blob/main/LICENSE)。
- **CloakBrowser binary**（编译后的 Chromium）— 可免费使用，不可再分发。见 [BINARY-LICENSE.md](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md)。
