// Abstract base for all AI provider adapters.
// Subclasses must implement sendPrompt / waitForResponse / extractResponse.
export default class AIAdapter {
  constructor(utils) {
    this.utils = utils;
    this.name = "base";
    // selectors should be overridden
    this.selectors = {
      input: [],
      sendButton: [],
      responseContainer: [],
      lastResponse: [],
      spinner: [],
      loginIndicator: [],
      captcha: [],
      rateLimit: [],
    };
  }

  async isLoggedIn() {
    // default: looks for the input box
    return !!this.utils.findFirst(this.selectors.input);
  }

  async detectCaptcha() {
    return !!this.utils.findFirst(this.selectors.captcha || []);
  }

  async detectRateLimit() {
    const sels = this.selectors.rateLimit || [];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && /rate|too many|limit/i.test(el.textContent || "")) return true;
    }
    return false;
  }

  async _typeIntoInput(el, text) {
    const { setNativeValue, setContentEditable, clipboardPaste, sleep } = this.utils;
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      // Try clipboard first (preserves newlines best), then execCommand fallback.
      const ok = await clipboardPaste(el, text);
      if (!ok) setContentEditable(el, text);
    } else {
      setNativeValue(el, text);
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    await sleep(150);
  }

  async sendPrompt(prompt) {
    const { findFirst, sleep } = this.utils;
    const input = findFirst(this.selectors.input);
    if (!input) throw new Error(`${this.name}: input not found`);
    input.focus();
    await this._typeIntoInput(input, prompt);
    await sleep(200);
    const btn = findFirst(this.selectors.sendButton);
    if (btn && !btn.disabled) {
      btn.click();
    } else {
      // Fallback: send Enter key
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true }));
    }
  }

  async waitForResponse() {
    const { waitFor, sleep } = this.utils;
    // Wait until a spinner appears (response started) OR for response container to appear
    await sleep(500);
    // Wait for spinner to go away
    await waitFor(() => {
      const spinner = this.utils.findFirst(this.selectors.spinner || []);
      return !spinner;
    }, { timeout: 180000, interval: 500 }).catch(() => {});
  }

  async extractResponse() {
    const { waitForStable } = this.utils;
    return waitForStable(() => {
      const el = this.utils.findFirst(this.selectors.lastResponse);
      return el ? (el.innerText || el.textContent || "").trim() : "";
    }, { settleMs: 1500, timeout: 180000 });
  }
}
