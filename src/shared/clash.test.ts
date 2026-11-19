import assert from "node:assert/strict";
import test from "node:test";

import { clashYamlToShareLinks } from "./clash";
import { classifySubscriptionText, parseXrayShareLink } from "./xray";

const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";

// A provider URL contains "://", which used to defeat the YAML check and made the whole file parse
// line by line; the top-level `proxies:` key is what identifies it now.
const CLASH_YAML = `
mixed-port: 7890
proxy-providers:
  provider1:
    type: http
    url: https://example.com/sub?token=abc
    interval: 3600
proxies:
  - name: HK-01
    type: vmess
    server: hk.example.com
    port: 443
    uuid: ${UUID}
    alterId: 0
    cipher: auto
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: hk.example.com
    tls: true
    servername: hk.example.com
  - name: JP-02
    type: hysteria2
    server: jp.example.com
    port: 443
    password: secret
    sni: jp.example.com
    skip-cert-verify: true
    obfs: salamander
    obfs-password: obfs-secret
    up: "100 Mbps"
    down: "200 Mbps"
    ports: 20000-50000
  - name: TUIC-03
    type: tuic
    server: tuic.example.com
    port: 443
proxy-groups:
  - name: Proxy
    type: select
    proxies:
      - HK-01
      - JP-02
`;

test("a Clash YAML with provider URLs and rule text is still classified as YAML", () => {
  const classification = classifySubscriptionText(CLASH_YAML);
  assert.equal(classification.kind, "clash-yaml");
});

test("Clash proxies become share links the common parsers accept", () => {
  const result = clashYamlToShareLinks(CLASH_YAML);
  assert.equal(result.total, 3);
  assert.equal(result.providerCount, 1);
  assert.equal(result.links.length, 2);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].link, /clash:tuic:TUIC-03/);
  assert.match(result.failures[0].error, /tuic/);

  const vmess = parseXrayShareLink(result.links[0]);
  assert.equal(vmess.summary.protocol, "vmess");
  assert.equal(vmess.summary.network, "ws");
  assert.equal(vmess.summary.security, "tls");
  assert.equal(vmess.summary.remark, "HK-01");

  const hysteria = parseXrayShareLink(result.links[1]);
  assert.equal(hysteria.summary.protocol, "hysteria");
  assert.equal(hysteria.summary.remark, "JP-02");
  assert.equal(hysteria.outbound.streamSettings?.hysteriaSettings?.auth, "secret");
  assert.equal(hysteria.outbound.streamSettings?.tlsSettings?.allowInsecure, true);
  assert.deepEqual(hysteria.outbound.streamSettings?.finalmask?.udp, [{ type: "salamander", settings: { password: "obfs-secret" } }]);
  const quicParams = hysteria.outbound.streamSettings?.finalmask?.quicParams as Record<string, unknown>;
  assert.equal(quicParams.brutalUp, "100 Mbps");
  assert.equal(quicParams.brutalDown, "200 Mbps");
  assert.deepEqual(quicParams.udpHop, { ports: "20000-50000", interval: 30 });
});

test("a Clash document without proxies reports its providers instead of failing per line", () => {
  const result = clashYamlToShareLinks("proxy-providers:\n  a:\n    type: http\n    url: https://example.com/sub\n");
  assert.equal(result.total, 0);
  assert.equal(result.providerCount, 1);
  assert.deepEqual(result.links, []);
});
