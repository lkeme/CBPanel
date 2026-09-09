import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { WATERMARK_STYLES, buildWatermarkScript, sanitizeWatermarkLabel } from "./watermark";
import { defaultProfile, mergeProfile, normalizeProfile, type BrowserProfile } from "./profile";

test("watermark styles stay limited to the three documented modes", () => {
  assert.deepEqual([...WATERMARK_STYLES], ["off", "banner", "enhanced"]);
});

test("off builds no script so callers can skip the injection API entirely", () => {
  assert.equal(buildWatermarkScript("QA", "off"), "");
  assert.equal(buildWatermarkScript("<script>alert(1)</script>", "off"), "");
});

test("sanitizeWatermarkLabel strips characters that could escape the textContent write", () => {
  assert.equal(sanitizeWatermarkLabel('<img src=x onerror="alert(1)">'), "img src=x onerror=alert(1)");
  assert.equal(sanitizeWatermarkLabel("A & B"), "A  B");
  assert.equal(sanitizeWatermarkLabel("  padded  "), "padded");
  assert.equal(sanitizeWatermarkLabel(""), "");
});

test("the script guards sub-frames and the three Google auth paths", () => {
  const script = buildWatermarkScript("QA", "banner");

  assert.match(script, /window\.self !== window\.top/);
  assert.match(script, /accounts\.google\.com/);
  assert.match(script, /accounts\.youtube\.com/);
  assert.match(script, /\/recaptcha\//);
  assert.match(script, /ancestorOrigins/);
  assert.match(script, /document\.referrer/);
  assert.match(script, /MutationObserver/);
});

// The assertions above only prove the generated text *contains* the guards. These run the script
// against a minimal DOM, so a guard that is present but inverted, a host suffix that also matches
// lookalikes, or an observer that never re-mounts still fails the suite.

type WatermarkNode = {
  id: string;
  attrs: Record<string, string>;
  children: WatermarkNode[];
  isConnected: boolean;
  textContent: string;
  style: { cssText: string };
  parentNode: WatermarkNode | null;
  handlers: Record<string, Array<() => void>>;
  setAttribute: (name: string, value: string) => void;
  appendChild: (child: WatermarkNode) => void;
  addEventListener: (name: string, handler: () => void) => void;
  removeChild: (child: WatermarkNode) => void;
};

type WatermarkDom = {
  body: WatermarkNode;
  /** One entry per installed MutationObserver; calling it plays that observer's callback. */
  observers: Array<() => void>;
  domReady: Array<() => void>;
  showBody: () => void;
};

function runWatermarkScript(
  script: string,
  page: {
    href: string;
    referrer?: string;
    ancestorOrigins?: string[];
    topFrame?: boolean;
    readyState?: string;
    body?: boolean;
  },
): WatermarkDom {
  const makeNode = (): WatermarkNode => {
    const node: WatermarkNode = {
      id: "",
      attrs: {},
      children: [],
      isConnected: false,
      textContent: "",
      style: { cssText: "" },
      parentNode: null,
      handlers: {},
      setAttribute(name, value) {
        node.attrs[name] = value;
        if (name === "id") node.id = value;
      },
      appendChild(child) {
        node.children.push(child);
        child.parentNode = node;
        if (node === body) child.isConnected = true;
      },
      addEventListener(name, handler) {
        (node.handlers[name] ??= []).push(handler);
      },
      removeChild(child) {
        node.children = node.children.filter((candidate) => candidate !== child);
        child.parentNode = null;
        child.isConnected = false;
      },
    };
    return node;
  };
  const body = makeNode();
  const state = { body: page.body ?? true };
  const observers: Array<() => void> = [];
  const domReady: Array<() => void> = [];
  const selfWindow = {};
  const sandbox = {
    window: { self: selfWindow, top: page.topFrame === false ? {} : selfWindow },
    location: { href: page.href, ancestorOrigins: page.ancestorOrigins ?? [] },
    document: {
      readyState: page.readyState ?? "complete",
      get body() {
        return state.body ? body : null;
      },
      referrer: page.referrer ?? "",
      createElement: () => makeNode(),
      getElementById: (id: string) => body.children.find((child) => child.id === id) ?? null,
      addEventListener: (name: string, handler: () => void) => {
        if (name === "DOMContentLoaded") domReady.push(handler);
      },
    },
    URL,
    MutationObserver: class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
    },
  };
  vm.runInNewContext(script, sandbox);
  return {
    body,
    observers,
    domReady,
    showBody: () => {
      state.body = true;
    },
  };
}

test("the running script labels an ordinary page with the sanitized environment name", () => {
  const dom = runWatermarkScript(buildWatermarkScript("QA <one>", "banner"), { href: "https://example.com/app" });

  assert.equal(dom.body.children.length, 1);
  const container = dom.body.children[0];
  assert.equal(container.id, "cbpanel-watermark");
  assert.equal(container.attrs["data-cbpanel-watermark"], "banner");
  assert.equal(container.children.find((child) => child.id === "cbpanel-watermark-label")?.textContent, "QA one");
});

test("the running script skips the auth pages and only those", () => {
  const mounts = (href: string) => runWatermarkScript(buildWatermarkScript("QA", "banner"), { href }).body.children.length;

  for (const href of [
    "https://accounts.google.com/signin",
    "https://x.accounts.google.com/signin",
    "https://accounts.youtube.com/",
    "https://www.google.com/recaptcha/api.js",
    "https://google.com/recaptcha",
  ]) {
    assert.equal(mounts(href), 0, href);
  }
  // A suffix check that used endsWith(blocked) or includes(blocked) would mount on these.
  for (const href of [
    "https://notgoogle.com/",
    "https://evil-accounts.google.com/",
    "https://accounts.google.com.evil.com/",
    "https://google.com/recaptchaX",
    "https://myaccount.google.com/",
    "https://example.com/",
  ]) {
    assert.equal(mounts(href), 1, href);
  }
});

test("the running script also skips referrer hits, ancestor hits and sub-frames", () => {
  const options = { href: "https://example.com/", referrer: "https://accounts.google.com/o/oauth2" };
  assert.equal(runWatermarkScript(buildWatermarkScript("QA", "banner"), options).body.children.length, 0);
  assert.equal(
    runWatermarkScript(buildWatermarkScript("QA", "banner"), {
      href: "https://example.com/",
      ancestorOrigins: ["https://accounts.google.com"],
    }).body.children.length,
    0,
  );
  assert.equal(
    runWatermarkScript(buildWatermarkScript("QA", "banner"), { href: "https://example.com/", topFrame: false }).body.children
      .length,
    0,
  );
});

test("the running script mounts through the observer and rebuilds a removed node without thrashing", () => {
  const deferred = runWatermarkScript(buildWatermarkScript("QA", "enhanced"), {
    href: "https://example.com/",
    body: false,
    readyState: "loading",
  });
  assert.equal(deferred.observers.length, 1, "the observer must be installed before <body> exists");
  assert.equal(deferred.domReady.length, 1, "the DOMContentLoaded fallback must be registered");
  assert.equal(deferred.body.children.length, 0);
  deferred.showBody();
  deferred.observers[0]();
  assert.equal(deferred.body.children.length, 1);

  const dom = runWatermarkScript(buildWatermarkScript("QA", "enhanced"), { href: "https://example.com/" });
  const first = dom.body.children[0];
  dom.body.removeChild(first);
  dom.observers[0]();
  assert.equal(dom.body.children.length, 1, "an SPA that drops the node must get it back");
  assert.notEqual(dom.body.children[0], first);
  const rebuilt = dom.body.children[0];
  for (let index = 0; index < 50; index += 1) dom.observers[0]();
  assert.equal(dom.body.children.length, 1, "a connected node must not be re-created per mutation");
  assert.equal(dom.body.children[0], rebuilt);
});

test("the running banner dismisses permanently, the badge cannot be dismissed", () => {
  const dom = runWatermarkScript(buildWatermarkScript("QA", "banner"), { href: "https://example.com/" });
  const container = dom.body.children[0];
  const close = container.children.find((child) => child.attrs["data-cbpanel-watermark-close"] === "1");
  assert.ok(close, "banner must render a close button");
  close.handlers.click[0]();
  assert.equal(dom.body.children.length, 0, "the close button removes the node");
  dom.observers[0]();
  assert.equal(dom.body.children.length, 0, "a dismissed banner must not come back on the next mutation");

  const badge = runWatermarkScript(buildWatermarkScript("QA", "enhanced"), { href: "https://example.com/" });
  assert.equal(
    badge.body.children[0].children.some((child) => child.attrs["data-cbpanel-watermark-close"] === "1"),
    false,
  );
});

test("banner renders a dismissible bar and enhanced a non-interactive badge", () => {
  const banner = buildWatermarkScript("QA", "banner");
  const enhanced = buildWatermarkScript("QA", "enhanced");

  assert.match(banner, /data-cbpanel-watermark-close/);
  assert.doesNotMatch(enhanced, /data-cbpanel-watermark-close/);
  assert.match(enhanced, /pointer-events:none/);
  assert.doesNotMatch(banner, /pointer-events:none/);
  assert.match(banner, /bottom:0/);
  assert.match(enhanced, /bottom:12px/);
});

test("the label is embedded as a JSON string literal, never as markup", () => {
  const script = buildWatermarkScript('<img src=x onerror="alert(1)">', "enhanced");

  assert.ok(script.includes(JSON.stringify("img src=x onerror=alert(1)")));
  assert.doesNotMatch(script, /<img/);
});

test("backslashes in a profile name stay inside the string literal", () => {
  const script = buildWatermarkScript("a\\b\"c", "banner");

  assert.ok(script.includes(JSON.stringify(sanitizeWatermarkLabel("a\\b\"c"))));
});

test("profiles default to the off watermark and normalize unknown values back to off", () => {
  assert.equal(defaultProfile().runtime.watermark, "off");

  const stored = defaultProfile();
  stored.runtime.watermark = "banner";
  assert.equal(normalizeProfile(stored).runtime.watermark, "banner");
  assert.equal(mergeProfile(stored, { name: "Renamed" }).runtime.watermark, "banner");

  // A stored row written before this field existed keeps working: mergeProfile fills the default.
  const legacyRuntime: Record<string, unknown> = { ...defaultProfile().runtime };
  delete legacyRuntime.watermark;
  const legacy = { ...defaultProfile(), runtime: legacyRuntime } as unknown as BrowserProfile;
  assert.equal(normalizeProfile(legacy).runtime.watermark, "off");

  const tampered = defaultProfile();
  (tampered.runtime as { watermark: string }).watermark = "fullscreen";
  assert.equal(normalizeProfile(tampered).runtime.watermark, "off");
});
