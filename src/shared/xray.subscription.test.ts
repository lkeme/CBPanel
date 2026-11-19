import assert from "node:assert/strict";
import test from "node:test";
import { classifySubscriptionText, extractXrayShareLinks } from "./xray";

const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";
const LINKS = [`vless://${UUID}@a.example.com:443`, "trojan://pw@b.example.com:443#B"];

test("classifySubscriptionText recognises a plain or base64 node list", () => {
  const plain = classifySubscriptionText(`${LINKS[0]}\n# comment\n\n${LINKS[1]}\n`);
  assert.equal(plain.kind, "links");
  assert.deepEqual(plain.links, LINKS);
  assert.equal(plain.decodedFromBase64, false);

  const encoded = classifySubscriptionText(Buffer.from(LINKS.join("\n")).toString("base64"));
  assert.equal(encoded.kind, "links");
  assert.deepEqual(encoded.links, LINKS);
  assert.equal(encoded.decodedFromBase64, true);
  assert.deepEqual(extractXrayShareLinks(Buffer.from(LINKS.join("\r\n")).toString("base64url")), LINKS);
});

test("classifySubscriptionText names a web page, a Clash YAML and a JSON body instead of failing per line", () => {
  assert.equal(classifySubscriptionText("<!DOCTYPE html><html><head><title>Login</title></head><body>Sign in</body></html>").kind, "html");
  assert.equal(classifySubscriptionText("   <html lang=\"en\"><body>blocked</body></html>").kind, "html");
  const clash = ["port: 7890", "mixed-port: 7891", "proxies:", "  - name: HK", "    type: vmess", "    server: hk.example.com", "proxy-groups:", "  - name: auto"].join("\n");
  assert.equal(classifySubscriptionText(clash).kind, "clash-yaml");
  // A Clash file shipped base64-encoded is still a Clash file.
  assert.equal(classifySubscriptionText(Buffer.from(clash).toString("base64")).kind, "clash-yaml");
  assert.equal(classifySubscriptionText(JSON.stringify({ outbounds: [{ type: "vless", server: "x" }] })).kind, "json");
  assert.equal(classifySubscriptionText("[]").kind, "json");
  assert.equal(classifySubscriptionText("").kind, "empty");
  assert.equal(classifySubscriptionText("\n# only comments\n").kind, "empty");
});

test("classifySubscriptionText keeps ordinary lines that merely look like YAML or braces", () => {
  // A share link whose remark contains a colon is not a YAML document.
  const withColons = classifySubscriptionText(`trojan://pw@b.example.com:443#port: 443\n${LINKS[0]}`);
  assert.equal(withColons.kind, "links");
  assert.equal(withColons.links.length, 2);
  // Garbage lines are handed back as links for the importer to judge one by one.
  const garbage = classifySubscriptionText("hello world\nnot a link either");
  assert.equal(garbage.kind, "links");
  assert.equal(garbage.links.length, 2);
  // Letters and digits alone are a valid base64 alphabet; the decode must not win over readable text.
  const words = classifySubscriptionText(Array.from({ length: 40 }, (_, index) => `line ${index} is not a node`).join("\n"));
  assert.equal(words.kind, "links");
  assert.equal(words.decodedFromBase64, false);
  assert.equal(words.links.length, 40);
});
