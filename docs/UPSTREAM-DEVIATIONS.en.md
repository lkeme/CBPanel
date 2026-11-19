# CBPanel deviations from the upstream docs

This file records CBPanel's **deliberate deviations** from the
[CloakBrowser docs](https://github.com/CloakHQ/CloakBrowser/).
It does not belong in the README: the README answers "what is this, how do I install and run it" for
someone meeting the project for the first time; this file answers "where do we intentionally differ
from upstream, why, and should that change on the next sync" for maintainers.

- English: this file
- 中文: [UPSTREAM-DEVIATIONS.zh-CN.md](UPSTREAM-DEVIATIONS.zh-CN.md)
- Reference point: the synced upstream revision lives in `package.json` under
  `upstream.cloakbrowser` (`syncedCommit` / `npmPackage`).
- Maintenance rule: **adding or removing a deviation means editing both languages.** A behavioural
  difference with no row here is a defect, not a deviation.
- Re-introduction trigger: `humanPreset` and `humanConfig` only start to matter once the panel scripts
  element interactions itself (auto-click, selector reads, form prefill). Re-introducing them requires a
  preset allowlist at the same time.

## Check order when syncing upstream

1. Diff the docs between `package.json`'s `upstream.cloakbrowser.syncedCommit` and the target upstream
   commit.
2. Walk the table below row by row: did upstream change the default or the semantics? If upstream now
   behaves the way we want, delete the row; if upstream added a constraint that bears on the row, extend
   the "Why".
3. Then read [CBPanel extensions](#cbpanel-extensions-outside-upstream-semantics): did upstream ship
   the capability natively? If so, delete our implementation or switch to reusing theirs.
4. Finally verify each implementation anchor, so the document and the code still agree.

## Deliberate deviations

| Item | Upstream default | CBPanel | Why | Implementation |
| --- | --- | --- | --- | --- |
| `CLOAKBROWSER_AUTO_UPDATE` | `true` | `false` | The panel owns core install, update and rollback; letting the wrapper update itself would desync the version from the panel's record. An explicit update flips it back to `true` for the duration. | `server/services/binaryService.ts` |
| `CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS` | `5` | `20` | A residential proxy's first GeoIP probe often exceeds 5 seconds; set it back in the browser-core custom environment variables. | `server/services/binaryService.ts`, `src/shared/settings.ts` |
| Launch mode | `headless: true` | Visible window, with no bypass | The panel has no CDP/screenshot entry, so a headless session is neither visible nor operable; upstream's anti-detection recommendations are headed too. `launchOptions` no longer accepts `headless` (see the allowlist row below), so nothing in the editor can make a launch invisible. | `src/shared/profile.ts` (`defaultProfile`) |
| `launchOptions` / `contextOptions` | free objects forwarded by the wrapper | `launchOptions` is an allowlist (`timeout`, `slowMo`, `downloadsPath`, `tracesDir`); `contextOptions` rejects the five keys the panel or the wrapper owns | `launchOptions` keys replace what the panel computed rather than refining it — `args` swaps out the whole generated fingerprint list — and the panel owns a control for each of them. `contextOptions` keys `viewport`/`userAgent`/`colorScheme` are written from panel fields, and the wrapper strips `locale`/`timezoneId`. Both are refused at parse time so the launch shape cannot differ from the editor. | `src/shared/profile.ts` (`parseOptionalJsonObject`, `LAUNCH_OPTION_ALLOWED_KEYS`, `CONTEXT_OPTION_PANEL_OWNED_KEYS`) |
| Launcher | three launch APIs | `launchPersistentContext` / `launchContext` | The panel model is one environment = one profile session, which only needs a BrowserContext; extension loading and login persistence in persistent mode need a real user data dir. | `src/shared/profile.ts` (`buildLaunchPreview`) |
| `humanize` | `false` | `true` on every launch, wrapper `default` preset, no overrides | The panel opens, navigates and injects; it never drives the element interactions the humanize layer patches, so a preset or a `humanConfig` object would tune code paths this launch does not run. `humanPreset` and `humanConfig` are therefore not exposed — an unknown preset would also throw inside the wrapper after the browser process already exists. | `src/shared/profile.ts` (`buildLaunchPreview`) |
| Stealth args | has an off switch | no switch; always the wrapper default | The panel has no scenario that wants the default stealth flags off. Turning them off also stops `.cloakbrowser-seed` from being read or written, so a persistent environment would get a new identity on every launch — exactly the state the panel exists to avoid. | `src/shared/profile.ts` (`buildLaunchPreview`) |
| `--license-route` | `auto` | Derived: `proxy` when the profile launches through a proxy, `direct` otherwise | `auto` means "direct first, one retry through `--proxy-server`", which misdescribes a proxied launch and names a retry that cannot happen without one. The route is computed from the proxy the launch actually uses, including the Xray loopback inbound, so there is no separate control to keep in sync. | `src/shared/profile.ts` (`licenseRouteFor`) |
| `--fingerprint-transparent-proxy-dns` | accepts `local` or a custom DoH URL | not exposed; fixed at the documented default (Cloudflare DoH through the proxy) | That default is the entire point of the enhanced-proxy mode; resolving `local` is just an ordinary proxy again, so exposing the choice only creates combinations that contradict the switch. | `src/shared/profile.ts` (`ENHANCED_PROXY_FLAG`) |
| Extension loading | the `extensionPaths` option; the wrapper writes `--load-extension` / `--disable-extensions-except` itself | the panel writes both switches into `args` (`--load-extension=…` + `--disable-extensions-except=…`, comma-joined) and no longer passes `extensionPaths` | Chromium 137 removed the `--load-extension` switch. On the shipped kernel (156.0.8078.47) that flag alone loads nothing, and the old `--disable-features=DisableLoadExtensionCommandLineSwitch` escape hatch no longer exists in that build. What works is the 143+ `--disable-extensions-except` explicit allow-list. Emitting the pair from the panel puts the real launch shape into the effective-argv preview instead of depending on the wrapper happening to write the allow-list too, and keeps one meaning shared with the comma-path preflight block and `assertExtensionsLaunchable`. | `src/shared/profile.ts` (`extensionLoaderArgs`, `buildFingerprintArgs`), `server/services/sessionService.ts` (`assertExtensionsLaunchable`) |
| Extensions in ephemeral mode | unconstrained (the wrapper accepts `extensionPaths` either way) | an ephemeral environment with extensions is refused (preflight `fail` plus a 409 `EXTENSION_EPHEMERAL_UNSUPPORTED` in the session) | The ephemeral launcher (`launchContext`) was measured not to load extensions even with both switches on the command line: neither the service worker nor the content scripts ran, leaving only an orphaned SW target in `Target.getTargets`. The old `warn` called this "data does not persist", which implied the extension worked; refusing instead means only a persistent profile with a real user data dir can bind extensions. | `src/shared/profile.ts` (`preflightProfile`), `server/services/sessionService.ts`, `src/components/profiles/ProfileEditorAdvancedPanels.tsx` |

## CBPanel extensions (outside upstream semantics)

These capabilities are not part of the CloakBrowser docs; **do not** mix them with upstream semantics:

| Item | Default | Notes |
| --- | --- | --- |
| Environment watermark (`watermark`) | Off | Injects a detectable DOM node into every page so parallel windows can be told apart; both `banner` and `enhanced` leave a signal that can be correlated across environments. |
| Voice-list shaping (`voices`) | On | Trims `speechSynthesis.getVoices()` to a stable subset of the host list. Otherwise every environment reports the same voice table, and a profile claiming macos/linux leaks through Windows voices. May overlap the core's own voice table. |
| GeoIP without a proxy | Follows the local exit | Upstream's `geoip` targets proxied launches; with no proxy configured the panel still probes the exit once and derives timezone and locale from this machine's public exit. |
| Identity read-out and rotation | — | The seed read-out sits at the foot of the editor tab column (visible on every tab) and is never an input; `Reset identity` deletes `.cloakbrowser-seed` from the user data directory so the next launch gets a fresh identity. |
| Derived license route | — | See the `--license-route` row above. |
| Panel self-update check | checked once on startup (24h TTL), stored in `appUpdate.lastUpdateCheck` | Check and notify only; nothing is downloaded or installed. Reads the release asset `app-update-manifest.json`, compares it with `package.json#version`, shows a dot on the sidebar settings button, and offers the installer link on the About page. The check has no toggle; the 24h TTL is the cap. | `server/services/appUpdateService.ts`, `src/shared/appUpdate.ts` |
| Manual extension path list | Not a concept (directories travel through the `extensionPaths` option) | Not offered; directories come from the extension library bindings alone | It was the stopgap before the library existed, fully overlapped by the library's `local-directory` import, and its precedence was silently overridden (the whole list was dropped whenever any library extension was bound). Removing it leaves one path for extension sources: binding → `extensionService` resolution → launch switches, with the preview, snapshot and exports sharing the same rule. The field is dropped from a stored profile during normalization. | `src/shared/profile.ts` (`mergeProfile`, `buildFingerprintArgs`), `server/services/sessionService.ts` (`resolveRuntimeProfile`), `src/shared/extensionDisplay.ts` (`launchExtensionPaths`) |
| WebRTC exit precedence | The wrapper resolves `--fingerprint-webrtc-ip=auto` first (dropping it without a proxy), then `geoip` appends the exit IP it resolved | The editor folds "the exit a launch actually applies" into one four-state derivation (`effectiveWebrtcIpMode`): `custom` > `geoip` > `auto` > `off` | A stored literal stops the append entirely; the `geoip` append runs after `auto` has been resolved, so a stored `auto` never reaches its own lookup while GeoIP is injecting; `auto` only stands alone when GeoIP injects nothing, and even then it resolves the proxy exit only, so the wrapper drops it without a proxy. The editor therefore keeps three stored segments and explains the derived states in notices instead of showing a fake "Follow GeoIP" segment that pretends to be a stored value. | `src/shared/profile.ts` (`effectiveWebrtcIpMode`, `geoipInjectsWebrtcExitIp`), `src/components/profiles/ProfileEditorFingerprintFields.tsx` |

## Related trade-offs and troubleshooting

### Linux fonts

Upstream calls missing emoji / CJK / Windows fonts the most common block cause once proxy, GeoIP and
headed mode are correct. The preflight runs `fc-list` and warns when families are missing; install
`fonts-noto-color-emoji`, `fonts-noto-cjk` and a Windows-compatible set, or set
`CLOAKBROWSER_SUPPRESS_FONT_WARNING=1` (only if you accept the trade-off).

### Version gates

Fingerprint flags are gated by Chromium version; the code checks "first supported version", so treat
these as capabilities rather than constants:

| Flag | Minimum |
| --- | --- |
| `--fingerprint-search-engine` | Linux `155.0.8059.39.2+`; `156+` elsewhere |
| `--fingerprint-max-touch-points` | `156+` |
| `--fingerprint-transparent-proxy-dns` | Linux and Windows only (not exposed by the panel; see the table above) |

Chromium has its own gate worth naming: `--load-extension` stopped loading unpacked directories in 137, and
`--disable-extensions-except` has been the official allow-list since 143. The panel always writes both (see the
"Extension loading" row above), so it holds across versions; a launch that relies on `--load-extension` alone
silently loses the extension on 137+.

### Change log

When editing this file, update both languages in the same commit. When a deviation is withdrawn,
delete the row and say why in the commit message instead of keeping a "used to deviate" note — `git log`
already carries that history.
