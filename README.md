# CBPanel

[中文说明](README.zh-CN.md)

CBPanel is a local Web + Desktop management shell for [CloakBrowser](https://github.com/CloakHQ/CloakBrowser/).

![CBPanel workbench](.github/assets/cbpanel-workbench.png)

## Compatibility Note

The development and CI toolchain requires Node.js 26 or newer (with npm 11 or newer) and Rust 1.88.0 or newer for the Tauri desktop shell. Only the Windows portable build has been tested. Other artifacts are provided as-is and are not guaranteed to work.

## Quick Start

```bash
npm install
npm run dev
```

For a clean, lockfile-respecting install, use `npm ci`.

The development server runs at:

```text
http://127.0.0.1:4173
```

Useful checks:

```bash
npm run typecheck
npm test
npm run build
```

Desktop commands:

```bash
npm run desktop:dev
npm run desktop:portable
npm run release:windows
npm run release:linux
npm run release:mac
```

## Xray engine (universal proxy support)

CloakBrowser itself only speaks HTTP, HTTPS and SOCKS5. CBPanel bundles an **Xray engine** that
turns everything else into a local SOCKS5 proxy at launch, so a profile can run through any node
you would otherwise use in v2rayN or Clash:

- **Protocols**: VMess, VLESS, Trojan, Shadowsocks (including SS-2022), SOCKS5, HTTP — pasted as
  `vmess://`, `vless://`, `trojan://`, `ss://`, `socks://`, `http://` share links, or imported in bulk
  from a subscription URL / base64 subscription body (Proxies → Import nodes).
- **Transports**: REALITY, XHTTP, gRPC, mKCP, WebSocket, HTTP/2, HTTPUpgrade, QUIC, TCP with HTTP
  camouflage; uTLS fingerprints follow the profile's browser brand unless the link pins its own.
- **Chained proxies**: any proxy (a plain socks5/http one included) can name a *front proxy* from the
  library, giving `[this machine] → [front proxy] → [proxy] → [website]` — the layout used to hide the
  real IP behind a residential exit.
- **Dual stack**: an IPv4/IPv6 strategy per proxy (auto, IPv4/IPv6 first, IPv4/IPv6 only) decides
  how the engine resolves the node address.
- **Library tooling**: the proxy list is paged and supports multi-select with batch availability
  checks, batch *real latency* probes (one round trip through the proxy to a small always-on
  endpoint) and batch delete; the last result of both probes is shown on every row and in the
  environment editor's proxy picker.
- **Remembered subscriptions**: a subscription URL can be kept (tick *Remember this subscription*
  when importing, or add one in the Subscriptions area of the proxy registry) and refreshed by hand
  or on a schedule (every 1–168 h while the panel runs). A refresh makes the subscription's nodes
  match what the address lists now — new nodes are added, vanished nodes removed, renamed nodes
  renamed in place. A node an environment already uses (or another proxy chains through) is never
  deleted: it leaves the subscription and stays as a standalone proxy, and standalone proxies are
  never touched by a refresh. Deleting a subscription keeps its nodes by default.

How it works: each launch that needs the engine starts its own `xray` process on a loopback SOCKS5
port, the exit check runs through that port, CloakBrowser is launched against it, and the process is
stopped with the browser. An engine that dies under a running browser is restarted on the same port.
Xray-core is downloaded on demand from GitHub Releases into `data/xray/` (Settings → Network → Xray
engine; the GitHub mirror setting applies) — or point the panel at your own `xray` binary.

## Downloads

Artifacts are published on the [GitHub Releases](https://github.com/lkeme/CBPanel/releases) page.

| Platform | Artifact |
| --- | --- |
| Windows | Installer `.exe` or portable `.zip` |
| Linux | x64 `.AppImage` |
| macOS | `.dmg` |

Linux:

```bash
chmod +x CBPanel-linux-x64.AppImage
./CBPanel-linux-x64.AppImage
```

## License

- **CBPanel** — MIT. See [LICENSE](LICENSE).
- **CloakBrowser wrapper code** — MIT. See [CloakBrowser LICENSE](https://github.com/CloakHQ/CloakBrowser/blob/main/LICENSE).
- **CloakBrowser binary** (compiled Chromium) — free to use, no redistribution. See [BINARY-LICENSE.md](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md).
