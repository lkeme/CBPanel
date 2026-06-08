import { type BrowserProfile, defaultProfile } from "../../src/shared/profile";

export function seedProfiles(): BrowserProfile[] {
  const base = defaultProfile({
    name: "本地 QA 配置",
    group: "默认",
    tags: ["local", "headed"],
    notes: "默认启用持久化、人类化和可见窗口，适合先验证 CloakBrowser 是否能正常启动。",
    startUrl: "https://browserleaks.com/canvas",
    fingerprint: {
      ...defaultProfile().fingerprint,
      seed: "42069",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    },
  });

  const proxyReady = defaultProfile({
    name: "代理联动模板",
    group: "代理",
    tags: ["proxy", "geoip"],
    notes: "填入住宅代理后启用 GeoIP，让时区、语言和 WebRTC 出口 IP 跟代理一致。",
    startUrl: "https://browserleaks.com/webrtc",
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      raw: "",
      host: "proxy.example.com",
      port: "8080",
    },
    runtime: {
      ...defaultProfile().runtime,
      geoip: true,
      humanPreset: "careful",
    },
    fingerprint: {
      ...defaultProfile().fingerprint,
      seed: "99887",
      webrtcIp: "auto",
    },
  });

  return [base, proxyReady];
}
