// Content script injected into AI provider sites. Loads the right adapter
// based on the hostname, listens for AI_SEND requests from background.

(function () {
  if (window.__AI_AGENT_CONTENT_LOADED__) return;
  window.__AI_AGENT_CONTENT_LOADED__ = true;

  const host = location.hostname;
  let providerName = "unknown";
  if (host.includes("openai.com") || host.includes("chatgpt.com")) providerName = "chatgpt";
  else if (host.includes("deepseek.com")) providerName = "deepseek";
  else if (host.includes("qwen.ai")) providerName = "qwen";
  else if (host.includes("gemini.google.com")) providerName = "gemini";

  // ---------- shared utilities (mirrors core/parser.js) ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function setContentEditable(el, value) {
    el.focus();
    // select all + delete then insert
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    document.execCommand("insertText", false, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }

  async function clipboardPaste(el, value) {
    try {
      await navigator.clipboard.writeText(value);
      el.focus();
      document.execCommand("paste");
      return true;
    } catch {
      return false;
    }
  }

  function findFirst(selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function waitFor(predicate, { timeout = 60000, interval = 250 } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        try {
          const r = predicate();
          if (r) return resolve(r);
        } catch {}
        if (Date.now() - start > timeout) return reject(new Error("waitFor timeout"));
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function waitForStable(getText, { settleMs = 1500, timeout = 180000 } = {}) {
    return new Promise((resolve, reject) => {
      let last = "";
      let lastChange = Date.now();
      const start = Date.now();
      const iv = setInterval(() => {
        const cur = getText() || "";
        if (cur !== last) {
          last = cur;
          lastChange = Date.now();
        }
        if (cur && Date.now() - lastChange > settleMs) {
          clearInterval(iv);
          resolve(cur);
          return;
        }
        if (Date.now() - start > timeout) {
          clearInterval(iv);
          reject(new Error("response timeout"));
        }
      }, 300);
    });
  }

  // ---------- adapter loading ----------
  // We import the per-provider adapters via dynamic import on extension URL.
  async function loadAdapter() {
    const url = chrome.runtime.getURL(`adapters/${providerName}.js`);
    const mod = await import(url);
    return new mod.default({
      sleep, setNativeValue, setContentEditable, clipboardPaste,
      findFirst, waitFor, waitForStable,
    });
  }

  let adapterPromise = null;
  function getAdapter() {
    if (!adapterPromise) adapterPromise = loadAdapter();
    return adapterPromise;
  }

  // ---------- message handling ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg.type !== "AI_SEND") return;
      try {
        const adapter = await getAdapter();
        const loggedIn = await adapter.isLoggedIn();
        if (!loggedIn) throw new Error(`${providerName} not logged in`);
        const captcha = await adapter.detectCaptcha();
        if (captcha) throw new Error(`${providerName} captcha detected`);
        const rate = await adapter.detectRateLimit();
        if (rate) throw new Error(`${providerName} rate limited`);

        await adapter.sendPrompt(msg.prompt);
        await adapter.waitForResponse();
        const text = await adapter.extractResponse();
        chrome.runtime.sendMessage({ type: "AI_RESPONSE", requestId: msg.requestId, text });
      } catch (e) {
        chrome.runtime.sendMessage({ type: "AI_RESPONSE", requestId: msg.requestId, error: e.message });
      }
    })();
    return false; // we reply via runtime.sendMessage
  });

  // expose for debugging
  window.__AI_AGENT__ = { providerName, getAdapter };
})();
