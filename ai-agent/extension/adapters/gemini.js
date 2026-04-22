import AIAdapter from "./baseAdapter.js";

export default class GeminiAdapter extends AIAdapter {
  constructor(utils) {
    super(utils);
    this.name = "gemini";
    this.selectors = {
      input: [
        "rich-textarea div[contenteditable='true']",
        "div.ql-editor[contenteditable='true']",
        "textarea[aria-label*='prompt' i]",
        "div[contenteditable='true'][role='textbox']",
      ],
      sendButton: [
        "button[aria-label*='Send' i]",
        "button.send-button",
        "button[mat-icon-button][aria-label*='Send' i]",
      ],
      responseContainer: [
        "model-response",
        "div.model-response-text",
      ],
      lastResponse: [
        "model-response:last-of-type .markdown",
        "model-response:last-of-type",
        "div.model-response-text:last-of-type",
      ],
      spinner: [
        "button[aria-label*='Stop' i]",
        ".loading-indicator",
        "mat-progress-bar",
      ],
      loginIndicator: [
        "a[href*='accounts.google.com']",
      ],
      captcha: [
        "iframe[src*='recaptcha']",
        "iframe[src*='captcha']",
      ],
      rateLimit: [
        "div[role='alert']",
      ],
    };
  }
}
