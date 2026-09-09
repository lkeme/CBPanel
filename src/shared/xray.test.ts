import assert from "node:assert/strict";
import test from "node:test";
import {
  XRAY_MAIN_OUTBOUND_TAG,
  XRAY_PRE_OUTBOUND_TAG,
  XRAY_UTLS_FINGERPRINTS,
  XRAY_UTLS_PREFERENCES,
  XrayShareLinkError,
  buildXrayConfig,
  decodeBase64Content,
  deriveUtlsFingerprint,
  describeXrayNode,
  detectXrayShareLinkProtocol,
  extractXrayShareLinks,
  hasUnsupportedInsecureParam,
  isMaskedXrayShareLink,
  maskXrayShareLink,
  parseXrayShareLink,
  sockoptDomainStrategy,
  tryParseXrayShareLink,
  xrayOutboundFromProxy,
  xrayShareLinkRemark,
} from "./xray";

const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";

function vmessLink(payload: Record<string, unknown>): string {
  return `vmess://${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`;
}

test("detectXrayShareLinkProtocol recognises every supported scheme and plain host:port", () => {
  assert.equal(detectXrayShareLinkProtocol("vmess://abc"), "vmess");
  assert.equal(detectXrayShareLinkProtocol("VLESS://abc"), "vless");
  assert.equal(detectXrayShareLinkProtocol("trojan://abc"), "trojan");
  assert.equal(detectXrayShareLinkProtocol("ss://abc"), "shadowsocks");
  assert.equal(detectXrayShareLinkProtocol("socks5://abc"), "socks");
  assert.equal(detectXrayShareLinkProtocol("socks5h://abc"), "socks");
  assert.equal(detectXrayShareLinkProtocol("http://abc"), "http");
  assert.equal(detectXrayShareLinkProtocol("https://abc"), "http");
  assert.equal(detectXrayShareLinkProtocol("10.0.0.1:1080"), "socks");
  assert.equal(detectXrayShareLinkProtocol("10.0.0.1:1080:user:pass"), "socks");
  assert.equal(detectXrayShareLinkProtocol("ftp://abc"), undefined);
  assert.equal(detectXrayShareLinkProtocol("just words"), undefined);
  assert.equal(detectXrayShareLinkProtocol(""), undefined);
});

test("parseXrayShareLink builds a VMess outbound with WebSocket + TLS stream settings", () => {
  const link = vmessLink({
    v: "2",
    ps: "US 节点",
    add: "vm.example.com",
    port: "443",
    id: UUID,
    aid: "0",
    scy: "auto",
    net: "ws",
    type: "none",
    host: "cdn.example.com",
    path: "/ws",
    tls: "tls",
    sni: "sni.example.com",
    alpn: "h2,http/1.1",
  });
  const parsed = parseXrayShareLink(link);
  assert.equal(parsed.outbound.tag, XRAY_MAIN_OUTBOUND_TAG);
  assert.equal(parsed.outbound.protocol, "vmess");
  assert.deepEqual(parsed.outbound.settings, {
    vnext: [{ address: "vm.example.com", port: 443, users: [{ id: UUID, alterId: 0, security: "auto" }] }],
  });
  assert.equal(parsed.outbound.streamSettings?.network, "ws");
  assert.equal(parsed.outbound.streamSettings?.security, "tls");
  assert.deepEqual(parsed.outbound.streamSettings?.wsSettings, { path: "/ws", host: "cdn.example.com", headers: { Host: "cdn.example.com" } });
  assert.deepEqual(parsed.outbound.streamSettings?.tlsSettings, { serverName: "sni.example.com", alpn: ["h2", "http/1.1"] });
  assert.equal(parsed.summary.remark, "US 节点");
  assert.equal(parsed.summary.address, "vm.example.com");
  assert.equal(parsed.summary.port, 443);
  assert.equal(parsed.summary.transportDetail, "ws /ws · tls sni.example.com");
  assert.equal(xrayShareLinkRemark(link), "US 节点");
});

test("parseXrayShareLink maps VMess gRPC and the Shadowrocket legacy VMess form", () => {
  const grpc = parseXrayShareLink(vmessLink({ add: "1.2.3.4", port: 8443, id: UUID, net: "grpc", path: "svc", type: "multi", tls: "tls" }));
  assert.equal(grpc.outbound.streamSettings?.network, "grpc");
  assert.deepEqual(grpc.outbound.streamSettings?.grpcSettings, { serviceName: "svc", multiMode: true });
  assert.equal(grpc.outbound.streamSettings?.tlsSettings?.serverName, "1.2.3.4");

  const legacy = `vmess://${Buffer.from(`auto:${UUID}@legacy.example.com:10086`).toString("base64")}?remarks=Legacy%20Node&obfs=websocket&path=/legacy&tls=1&obfsParam=host.example.com`;
  const parsed = parseXrayShareLink(legacy);
  assert.equal(parsed.outbound.protocol, "vmess");
  assert.equal(parsed.summary.address, "legacy.example.com");
  assert.equal(parsed.summary.port, 10086);
  assert.equal(parsed.summary.remark, "Legacy Node");
  assert.equal(parsed.outbound.streamSettings?.network, "ws");
  assert.equal(parsed.outbound.streamSettings?.security, "tls");
  assert.equal(xrayShareLinkRemark(legacy), "Legacy Node");
});

test("parseXrayShareLink builds a VLESS REALITY + XHTTP outbound with flow and fingerprint", () => {
  const link = `vless://${UUID}@reality.example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=firefox&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sid=abcd&spx=%2F&type=xhttp&path=%2Fxh&host=front.example.com&mode=packet-up#Reality%20Node`;
  const parsed = parseXrayShareLink(link);
  assert.equal(parsed.outbound.protocol, "vless");
  assert.deepEqual(parsed.outbound.settings, {
    vnext: [{ address: "reality.example.com", port: 443, users: [{ id: UUID, encryption: "none", flow: "xtls-rprx-vision" }] }],
  });
  assert.equal(parsed.outbound.streamSettings?.network, "xhttp");
  assert.equal(parsed.outbound.streamSettings?.security, "reality");
  assert.deepEqual(parsed.outbound.streamSettings?.xhttpSettings, { path: "/xh", mode: "packet-up", host: "front.example.com" });
  assert.deepEqual(parsed.outbound.streamSettings?.realitySettings, {
    show: false,
    serverName: "www.microsoft.com",
    fingerprint: "firefox",
    publicKey: "SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc",
    shortId: "abcd",
    spiderX: "/",
  });
  assert.equal(parsed.summary.remark, "Reality Node");
  assert.equal(describeXrayNode(parsed.summary), "vless · xhttp+reality · xhttp packet-up · reality www.microsoft.com");
});

test("parseXrayShareLink covers mKCP, HTTP/2, HTTPUpgrade and QUIC transports", () => {
  const kcp = parseXrayShareLink(`vless://${UUID}@kcp.example.com:2000?type=kcp&headerType=wechat-video&seed=secret`);
  assert.deepEqual(kcp.outbound.streamSettings?.kcpSettings, { header: { type: "wechat-video" }, seed: "secret" });
  assert.equal(kcp.summary.transportDetail, "mkcp wechat-video");

  const h2 = parseXrayShareLink(`vless://${UUID}@h2.example.com:443?type=h2&host=a.example.com,b.example.com&path=/h2&security=tls`);
  assert.deepEqual(h2.outbound.streamSettings?.httpSettings, { path: "/h2", host: ["a.example.com", "b.example.com"] });
  assert.equal(h2.outbound.streamSettings?.tlsSettings?.serverName, "a.example.com");

  const upgrade = parseXrayShareLink(`vless://${UUID}@up.example.com:80?type=httpupgrade&path=/up&host=up.example.com`);
  assert.deepEqual(upgrade.outbound.streamSettings?.httpupgradeSettings, { path: "/up", host: "up.example.com" });

  const quic = parseXrayShareLink(`vless://${UUID}@quic.example.com:443?type=quic&quicSecurity=aes-128-gcm&key=k&headerType=srtp`);
  assert.deepEqual(quic.outbound.streamSettings?.quicSettings, { security: "aes-128-gcm", key: "k", header: { type: "srtp" } });

  const tcpHttp = parseXrayShareLink(`vless://${UUID}@tcp.example.com:80?type=tcp&headerType=http&host=camouflage.example.com&path=/index`);
  const header = tcpHttp.outbound.streamSettings?.tcpSettings?.header as { type: string; request: { path: string[]; headers: { Host: string[] } } };
  assert.equal(header.type, "http");
  assert.deepEqual(header.request.path, ["/index"]);
  assert.deepEqual(header.request.headers.Host, ["camouflage.example.com"]);
});

test("parseXrayShareLink defaults Trojan to TLS and keeps an explicit security", () => {
  const plain = parseXrayShareLink("trojan://pa%3Ass@trojan.example.com:443?type=ws&path=%2Ftj&host=tj.example.com#TJ");
  assert.equal(plain.outbound.protocol, "trojan");
  assert.deepEqual(plain.outbound.settings, { servers: [{ address: "trojan.example.com", port: 443, password: "pa:ss" }] });
  assert.equal(plain.outbound.streamSettings?.security, "tls");
  assert.equal(plain.outbound.streamSettings?.tlsSettings?.serverName, "tj.example.com");
  assert.equal(plain.summary.remark, "TJ");

  const none = parseXrayShareLink("trojan://secret@trojan.example.com:80?security=none&type=tcp");
  assert.equal(none.outbound.streamSettings?.security, "none");
  assert.equal(none.outbound.streamSettings?.tlsSettings, undefined);
});

test("parseXrayShareLink reads SIP002, legacy and Shadowsocks-2022 links", () => {
  const sip002 = parseXrayShareLink(`ss://${Buffer.from("aes-256-gcm:pass").toString("base64")}@ss.example.com:8388#SS%20One`);
  assert.equal(sip002.outbound.protocol, "shadowsocks");
  assert.deepEqual(sip002.outbound.settings, { servers: [{ address: "ss.example.com", port: 8388, method: "aes-256-gcm", password: "pass" }] });
  assert.deepEqual(sip002.outbound.mux, { enabled: false, concurrency: -1 });
  assert.equal(sip002.summary.remark, "SS One");

  const legacy = parseXrayShareLink(`ss://${Buffer.from("chacha20-ietf-poly1305:pw@[2001:db8::1]:9000").toString("base64")}`);
  assert.deepEqual(legacy.outbound.settings, { servers: [{ address: "2001:db8::1", port: 9000, method: "chacha20-ietf-poly1305", password: "pw" }] });

  const ss2022 = parseXrayShareLink("ss://2022-blake3-aes-128-gcm:YctPZ6U7xPPcU%2Bgp3u%2B0tx%2FtRizJN9K8y%2BuKlW2qjlI%3D:extra@[2001:db8::2]:8443?uot=1#2022");
  const server = (ss2022.outbound.settings as { servers: Array<Record<string, unknown>> }).servers[0];
  assert.equal(server.method, "2022-blake3-aes-128-gcm");
  assert.equal(server.password, "YctPZ6U7xPPcU+gp3u+0tx/tRizJN9K8y+uKlW2qjlI=:extra");
  assert.equal(server.address, "2001:db8::2");
  assert.equal(server.port, 8443);
  assert.equal(server.uot, true);
});

test("parseXrayShareLink maps Shadowsocks plugins and warns about unsupported ones", () => {
  const obfsHttp = parseXrayShareLink(`ss://${Buffer.from("aes-128-gcm:x").toString("base64")}@ss.example.com:80?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dwww.bing.com`);
  const header = obfsHttp.outbound.streamSettings?.tcpSettings?.header as { type: string; request: { headers: { Host: string[] } } };
  assert.equal(header.type, "http");
  assert.deepEqual(header.request.headers.Host, ["www.bing.com"]);
  assert.deepEqual(obfsHttp.summary.warnings, []);

  const obfsTls = parseXrayShareLink(`ss://${Buffer.from("aes-128-gcm:x").toString("base64")}@ss.example.com:443?plugin=obfs-local%3Bobfs%3Dtls%3Bobfs-host%3Dwww.bing.com`);
  assert.equal(obfsTls.outbound.streamSettings, undefined);
  assert.equal(obfsTls.summary.warnings.length, 1);

  const v2rayPlugin = parseXrayShareLink(`ss://${Buffer.from("aes-128-gcm:x").toString("base64")}@ss.example.com:443?plugin=v2ray-plugin%3Btls%3Bhost%3Dcdn.example.com%3Bpath%3D%2Fv2`);
  assert.equal(v2rayPlugin.outbound.streamSettings?.network, "ws");
  assert.equal(v2rayPlugin.outbound.streamSettings?.security, "tls");
  assert.deepEqual(v2rayPlugin.outbound.streamSettings?.wsSettings, { path: "/v2", host: "cdn.example.com", headers: { Host: "cdn.example.com" } });
});

test("parseXrayShareLink handles SOCKS and HTTP links in every common shape", () => {
  const v2rayN = parseXrayShareLink(`socks://${Buffer.from("alice:s3cret").toString("base64")}@socks.example.com:1080#S5`);
  assert.deepEqual(v2rayN.outbound.settings, { servers: [{ address: "socks.example.com", port: 1080, users: [{ user: "alice", pass: "s3cret" }] }] });
  assert.equal(v2rayN.summary.remark, "S5");

  const plainAuth = parseXrayShareLink("socks5://bob:p%40ss@10.1.1.1:1081");
  assert.deepEqual(plainAuth.outbound.settings, { servers: [{ address: "10.1.1.1", port: 1081, users: [{ user: "bob", pass: "p@ss" }] }] });

  const noAuth = parseXrayShareLink("socks5h://[::1]");
  assert.deepEqual(noAuth.outbound.settings, { servers: [{ address: "::1", port: 1080, users: [] }] });

  const colonForm = parseXrayShareLink("107.150.98.193:1536:user:pass");
  assert.deepEqual(colonForm.outbound.settings, { servers: [{ address: "107.150.98.193", port: 1536, users: [{ user: "user", pass: "pass" }] }] });
  assert.deepEqual(parseXrayShareLink("107.150.98.193:1536").outbound.settings, { servers: [{ address: "107.150.98.193", port: 1536, users: [] }] });

  const http = parseXrayShareLink("http://carol:pw@proxy.example.com:8080");
  assert.equal(http.outbound.protocol, "http");
  assert.deepEqual(http.outbound.settings, { servers: [{ address: "proxy.example.com", port: 8080, users: [{ user: "carol", pass: "pw" }] }] });
  assert.equal(http.outbound.streamSettings, undefined);

  const https = parseXrayShareLink("https://proxy.example.com");
  assert.equal(https.summary.port, 443);
  assert.equal(https.outbound.streamSettings?.security, "tls");
  assert.equal(https.outbound.streamSettings?.tlsSettings?.serverName, "proxy.example.com");
});

test("parseXrayShareLink rejects malformed input with a coded error", () => {
  assert.throws(() => parseXrayShareLink(""), (error: unknown) => error instanceof XrayShareLinkError && error.code === "EMPTY");
  assert.throws(() => parseXrayShareLink("ftp://x"), (error: unknown) => error instanceof XrayShareLinkError && error.code === "UNSUPPORTED_PROTOCOL");
  assert.throws(() => parseXrayShareLink("vmess://%%%"), (error: unknown) => error instanceof XrayShareLinkError && error.code === "MALFORMED");
  // WHATWG URL already refuses ports above 65535; port 0 is the malformed port that reaches the parser.
  assert.throws(() => parseXrayShareLink(`vless://${UUID}@host:0`), (error: unknown) => error instanceof XrayShareLinkError && error.code === "INVALID_PORT");
  assert.throws(() => parseXrayShareLink(`vless://${UUID}@host:99999`), (error: unknown) => error instanceof XrayShareLinkError && error.code === "MALFORMED");
  assert.throws(() => parseXrayShareLink(`vless://${UUID}@host:443?type=warp`), (error: unknown) => error instanceof XrayShareLinkError && error.code === "UNSUPPORTED_TRANSPORT");
  assert.throws(() => parseXrayShareLink(`vless://${UUID}@host:443?security=reality`), (error: unknown) => error instanceof XrayShareLinkError && error.code === "MALFORMED");
  assert.throws(
    () => parseXrayShareLink(`vless://${UUID}@host:443?security=reality&pbk=PUBLIC`),
    (error: unknown) => error instanceof XrayShareLinkError && error.code === "MALFORMED" && /pbk/.test(error.message),
  );
  assert.throws(() => parseXrayShareLink("1.2.3.4:80:only-user"), (error: unknown) => error instanceof XrayShareLinkError && error.code === "MALFORMED");
  assert.equal(tryParseXrayShareLink("nonsense"), undefined);
});

test("insecure parameters are reported as a warning rather than a failure", () => {
  const link = `vless://${UUID}@host.example.com:443?security=tls&allowInsecure=1`;
  assert.equal(hasUnsupportedInsecureParam(link), true);
  assert.equal(hasUnsupportedInsecureParam(`vless://${UUID}@host.example.com:443?security=tls&allowInsecure=0`), false);
  assert.equal(hasUnsupportedInsecureParam("vmess://abc"), false);
  const parsed = parseXrayShareLink(link);
  assert.equal(parsed.summary.warnings.length, 1);
});

test("maskXrayShareLink hides everything that authenticates and is idempotent", () => {
  const link = `vless://${UUID}@reality.example.com:443?security=reality&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sni=x#My%20Node`;
  const masked = maskXrayShareLink(link);
  assert.equal(masked, "vless://****@reality.example.com:443#My%20Node");
  assert.equal(masked.includes(UUID), false);
  assert.equal(isMaskedXrayShareLink(masked), true);
  assert.equal(maskXrayShareLink(masked), masked);
  assert.equal(maskXrayShareLink(`ss://${Buffer.from("aes-128-gcm:x").toString("base64")}@[2001:db8::1]:443`), "shadowsocks://****@[2001:db8::1]:443");
  assert.equal(maskXrayShareLink("garbage"), "****");
  assert.equal(maskXrayShareLink(""), "");
  assert.equal(isMaskedXrayShareLink(link), false);
});

test("extractXrayShareLinks splits pasted lists and decodes base64 subscription bodies", () => {
  const lines = [`vless://${UUID}@a.example.com:443`, "# comment", "", "trojan://pw@b.example.com:443"];
  assert.deepEqual(extractXrayShareLinks(lines.join("\r\n")), [lines[0], lines[3]]);
  const subscription = Buffer.from(lines.join("\n")).toString("base64");
  assert.deepEqual(extractXrayShareLinks(subscription), [lines[0], lines[3]]);
  assert.deepEqual(extractXrayShareLinks("   "), []);
  assert.equal(decodeBase64Content(Buffer.from("中文 remark").toString("base64url")), "中文 remark");
});

test("xrayOutboundFromProxy wraps the native schemes and delegates share links", () => {
  const socks = xrayOutboundFromProxy({ scheme: "socks5", host: "10.0.0.2", port: "1080", username: "u", password: "p", shareLink: "" }, "custom");
  assert.equal(socks.outbound.tag, "custom");
  assert.deepEqual(socks.outbound.settings, { servers: [{ address: "10.0.0.2", port: 1080, users: [{ user: "u", pass: "p" }] }] });

  const https = xrayOutboundFromProxy({ scheme: "https", host: "proxy.example.com", port: "443", username: "", password: "", shareLink: "" });
  assert.equal(https.outbound.protocol, "http");
  assert.equal(https.outbound.streamSettings?.security, "tls");
  assert.deepEqual(https.outbound.settings, { servers: [{ address: "proxy.example.com", port: 443, users: [] }] });

  const xray = xrayOutboundFromProxy({ scheme: "xray", host: "", port: "", username: "", password: "", shareLink: `vless://${UUID}@x.example.com:443` });
  assert.equal(xray.outbound.protocol, "vless");
  assert.throws(() => xrayOutboundFromProxy({ scheme: "http", host: "", port: "80", username: "", password: "", shareLink: "" }), XrayShareLinkError);
});

test("buildXrayConfig exposes one loopback SOCKS inbound routed to the main outbound", () => {
  const main = parseXrayShareLink(`vless://${UUID}@main.example.com:443?security=tls&type=ws&path=/m`).outbound;
  const config = buildXrayConfig({ localPort: 34567, main, logLevel: "error" });
  assert.deepEqual(config.log, { loglevel: "error" });
  assert.equal(config.inbounds.length, 1);
  assert.equal(config.inbounds[0].listen, "127.0.0.1");
  assert.equal(config.inbounds[0].port, 34567);
  assert.equal(config.inbounds[0].protocol, "socks");
  assert.deepEqual(config.inbounds[0].settings, { auth: "noauth", udp: true });
  assert.deepEqual(config.outbounds.map((outbound) => (outbound as { tag: string }).tag), [XRAY_MAIN_OUTBOUND_TAG, "direct", "block"]);
  assert.deepEqual(config.routing, {
    domainStrategy: "AsIs",
    rules: [{ type: "field", inboundTag: ["socks-in"], outboundTag: XRAY_MAIN_OUTBOUND_TAG }],
  });
  const mainOutbound = config.outbounds[0] as { proxySettings?: unknown; streamSettings: { tlsSettings: { fingerprint?: string } } };
  assert.equal(mainOutbound.proxySettings, undefined);
  assert.equal(mainOutbound.streamSettings.tlsSettings.fingerprint, undefined);
  // The caller's outbound is never mutated.
  assert.equal(main.tag, XRAY_MAIN_OUTBOUND_TAG);
  assert.equal(main.proxySettings, undefined);
});

test("buildXrayConfig chains the main node through the front proxy at the transport layer", () => {
  const main = parseXrayShareLink(`vless://${UUID}@main.example.com:443?security=reality&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sni=s`).outbound;
  const pre = parseXrayShareLink("socks5://u:p@front.example.com:1080").outbound;
  const config = buildXrayConfig({ localPort: 1, main, pre, ipStrategy: "ipv4-first", utlsFingerprint: { main: "chrome" } });
  const [mainOut, preOut] = config.outbounds as Array<{ tag: string; proxySettings?: unknown; streamSettings?: { sockopt?: unknown; realitySettings?: { fingerprint?: string } } }>;
  assert.equal(mainOut.tag, XRAY_MAIN_OUTBOUND_TAG);
  assert.equal(preOut.tag, XRAY_PRE_OUTBOUND_TAG);
  assert.deepEqual(mainOut.proxySettings, { tag: XRAY_PRE_OUTBOUND_TAG, transportLayer: true });
  assert.equal(mainOut.streamSettings?.realitySettings?.fingerprint, "chrome");
  // Only the dialing outbound — the front proxy — resolves names locally.
  assert.equal(mainOut.streamSettings?.sockopt, undefined);
  assert.deepEqual(preOut.streamSettings?.sockopt, { domainStrategy: "UseIPv4v6" });
  const direct = config.outbounds[2] as { settings: Record<string, unknown> };
  assert.deepEqual(direct.settings, { domainStrategy: "UseIPv4v6" });
});

test("buildXrayConfig keeps a link's own uTLS fingerprint ahead of the panel default", () => {
  const main = parseXrayShareLink(`trojan://pw@t.example.com:443?fp=safari`).outbound;
  const config = buildXrayConfig({ localPort: 1, main, utlsFingerprint: { main: "chrome" }, ipStrategy: "ipv6-only" });
  const mainOut = config.outbounds[0] as { streamSettings: { tlsSettings: { fingerprint?: string }; sockopt?: { domainStrategy?: string } } };
  assert.equal(mainOut.streamSettings.tlsSettings.fingerprint, "safari");
  assert.deepEqual(mainOut.streamSettings.sockopt, { domainStrategy: "UseIPv6" });
});

test("buildXrayConfig applies the uTLS fingerprint per outbound", () => {
  const main = parseXrayShareLink(`vless://${UUID}@main.example.com:443?security=reality&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sni=s`).outbound;
  const pre = parseXrayShareLink(`vless://${UUID}@front.example.com:443?security=reality&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sni=f`).outbound;
  const config = buildXrayConfig({ localPort: 1, main, pre, utlsFingerprint: { main: "chrome", pre: "firefox" } });
  const [mainOut, preOut] = config.outbounds as Array<{ tag: string; streamSettings?: { realitySettings?: { fingerprint?: string } } }>;
  assert.equal(mainOut.streamSettings?.realitySettings?.fingerprint, "chrome");
  assert.equal(preOut.streamSettings?.realitySettings?.fingerprint, "firefox");

  // Omitting the pre entry leaves the front proxy without a panel default, and the main one untouched.
  const partial = buildXrayConfig({ localPort: 1, main, pre, utlsFingerprint: { main: "edge" } });
  const [partialMain, partialPre] = partial.outbounds as Array<{ streamSettings?: { realitySettings?: { fingerprint?: string } } }>;
  assert.equal(partialMain.streamSettings?.realitySettings?.fingerprint, "edge");
  assert.equal(partialPre.streamSettings?.realitySettings?.fingerprint, undefined);

  // A plain https proxy hop is security "tls", so a per-proxy override has to land there as well.
  const https = xrayOutboundFromProxy({ scheme: "https", host: "proxy.example.com", port: "443", username: "", password: "", shareLink: "" }).outbound;
  const httpsConfig = buildXrayConfig({ localPort: 1, main: https, utlsFingerprint: { main: "360" } });
  const httpsMain = httpsConfig.outbounds[0] as { streamSettings?: { tlsSettings?: { fingerprint?: string } } };
  assert.equal(httpsMain.streamSettings?.tlsSettings?.fingerprint, "360");
});

test("the uTLS value lists carry the panel's own choices plus the inherit sentinel", () => {
  for (const fingerprint of ["qq", "360", "hellorandomizednoalpn"] as const) {
    assert.equal(XRAY_UTLS_FINGERPRINTS.includes(fingerprint), true);
  }
  assert.deepEqual(XRAY_UTLS_PREFERENCES, ["", ...XRAY_UTLS_FINGERPRINTS]);
  assert.equal(XRAY_UTLS_PREFERENCES[0], "");
});

test("IP strategy and uTLS helpers map to Xray vocabulary", () => {
  assert.equal(sockoptDomainStrategy("auto"), undefined);
  assert.equal(sockoptDomainStrategy(undefined), undefined);
  assert.equal(sockoptDomainStrategy("ipv4-first"), "UseIPv4v6");
  assert.equal(sockoptDomainStrategy("ipv6-first"), "UseIPv6v4");
  assert.equal(sockoptDomainStrategy("ipv4-only"), "UseIPv4");
  assert.equal(sockoptDomainStrategy("ipv6-only"), "UseIPv6");
  assert.equal(deriveUtlsFingerprint("firefox", { brand: "Microsoft Edge" }), "firefox");
  assert.equal(deriveUtlsFingerprint("auto", { brand: "Microsoft Edge" }), "edge");
  assert.equal(deriveUtlsFingerprint("auto", { brand: "Firefox" }), "firefox");
  assert.equal(deriveUtlsFingerprint("auto", { brand: "Safari" }), "safari");
  assert.equal(deriveUtlsFingerprint("auto", { brand: "Google Chrome" }), "chrome");
  assert.equal(deriveUtlsFingerprint("auto"), "chrome");
});
