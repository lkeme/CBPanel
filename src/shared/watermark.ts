export const WATERMARK_STYLES = ["off", "banner", "enhanced"] as const;
export type WatermarkStyle = (typeof WATERMARK_STYLES)[number];

const BANNER_CONTAINER_STYLE =
  "position:fixed;z-index:2147483647;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
  + "font-size:12px;line-height:1.4;color:#ffffff;background:rgba(17,24,39,0.92);left:0;right:0;bottom:0;padding:6px 12px;"
  + "display:flex;align-items:center;gap:10px;";

const ENHANCED_CONTAINER_STYLE =
  "position:fixed;z-index:2147483647;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
  + "font-size:12px;line-height:1.4;color:#ffffff;background:rgba(17,24,39,0.92);right:12px;bottom:12px;max-width:40vw;"
  + "padding:4px 10px;border-radius:6px;pointer-events:none;";

// Written into the page through textContent only; the id exists so a probe can assert the label text.
const CLOSE_BUTTON_SCRIPT = `      var close = document.createElement("button");
      close.type = "button";
      close.setAttribute("data-cbpanel-watermark-close", "1");
      close.setAttribute("aria-label", "Hide watermark");
      close.textContent = "\\u00d7";
      close.style.cssText = "flex:0 0 auto;cursor:pointer;border:0;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:1;padding:2px 6px;";
      close.addEventListener("click", function () {
        dismissed = true;
        if (container && container.parentNode) container.parentNode.removeChild(container);
        container = null;
      });
      container.appendChild(close);
`;

/**
 * Strips characters that could let a profile name escape the `textContent` write into an HTML or
 * attribute context. The label is never concatenated into markup, so this is defence in depth.
 */
export function sanitizeWatermarkLabel(name: string): string {
  return name.replace(/[<>"'&]/g, "").trim();
}

/**
 * Builds the init script for a watermark style. Returns "" for `off`; callers must then skip the
 * injection API entirely, because even an empty init script would add an observable surface.
 *
 * The script bails in sub-frames, on Google sign-in / reCAPTCHA pages (direct hit, ancestor origin,
 * or referrer), and rebuilds the node after SPA route changes; every failure is swallowed so the
 * page it labels is never broken by it.
 */
export function buildWatermarkScript(profileName: string, style: WatermarkStyle): string {
  if (style === "off") return "";

  const label = JSON.stringify(sanitizeWatermarkLabel(profileName));
  const containerStyle = style === "banner" ? BANNER_CONTAINER_STYLE : ENHANCED_CONTAINER_STYLE;
  const closeButton = style === "banner" ? CLOSE_BUTTON_SCRIPT : "";

  return `(function () {
  try {
    if (window.self !== window.top) return;
    var BLOCKED_HOSTS = ["accounts.google.com", "accounts.youtube.com"];
    var isBlockedUrl = function (raw) {
      if (!raw) return false;
      var url;
      try {
        url = new URL(raw, location.href);
      } catch (error) {
        return false;
      }
      var host = url.hostname.toLowerCase();
      for (var index = 0; index < BLOCKED_HOSTS.length; index += 1) {
        var blocked = BLOCKED_HOSTS[index];
        if (host === blocked || host.slice(-(blocked.length + 1)) === "." + blocked) return true;
      }
      var googleHost = host === "google.com" || host.slice(-11) === ".google.com";
      if (!googleHost) return false;
      return url.pathname.indexOf("/recaptcha/") === 0 || url.pathname === "/recaptcha";
    };
    if (isBlockedUrl(location.href)) return;
    var ancestors = location.ancestorOrigins;
    if (ancestors) {
      for (var ancestorIndex = 0; ancestorIndex < ancestors.length; ancestorIndex += 1) {
        if (isBlockedUrl(ancestors[ancestorIndex])) return;
      }
    }
    if (isBlockedUrl(document.referrer)) return;

    var CONTAINER_ID = "cbpanel-watermark";
    var LABEL_ID = "cbpanel-watermark-label";
    var LABEL = ${label};
    var dismissed = false;
    var container = null;

    var mount = function () {
      if (dismissed) return;
      if (container && container.isConnected) return;
      // An init script runs before the parser has built <body>; the observer below mounts as soon as
      // it exists. Mounting under <html> instead would place the node outside the body.
      var root = document.body;
      if (!root) return;
      var previous = document.getElementById(CONTAINER_ID);
      if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
      container = document.createElement("div");
      container.id = CONTAINER_ID;
      container.setAttribute("data-cbpanel-watermark", "${style}");
      container.style.cssText = "${containerStyle}";
      var label = document.createElement("span");
      label.id = LABEL_ID;
      label.textContent = LABEL;
      label.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      container.appendChild(label);
${closeButton}      root.appendChild(container);
    };

    // Observe the document, not documentElement: at init-script time documentElement does not exist yet,
    // so an observer bound to it would never be installed and SPA route changes would drop the label.
    if (typeof MutationObserver === "function") {
      var observer = new MutationObserver(function () { mount(); });
      observer.observe(document, { childList: true, subtree: true });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
    mount();
  } catch (error) {
    /* A watermark must never break the page it labels. */
  }
})();`;
}
