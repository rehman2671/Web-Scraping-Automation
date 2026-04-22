import AIAdapter from "./baseAdapter.js";

export default class QwenAdapter extends AIAdapter {
  constructor(utils) {
    super(utils);
    this.name = "qwen";
    this.selectors = {
      input: [
        "textarea#chat-input",
        "textarea[placeholder*='Ask' i]",
        "textarea[placeholder*='Message' i]",
        "div[contenteditable='true']",
      ],
      sendButton: [
        "button[aria-label*='Send' i]",
        "button[data-testid='send']",
        "form button[type='submit']",
        "div[role='button'][aria-label*='send' i]",
      ],
      responseContainer: [
        ".chat-message-assistant",
        "div[data-role='assistant']",
      ],
      lastResponse: [
        "div[data-role='assistant']:last-of-type .markdown-body",
        ".chat-message-assistant:last-of-type",
        "div[class*='assistant']:last-of-type",
      ],
      spinner: [
        "button[aria-label='Stop' i]",
        ".typing-indicator",
        ".loading",
      ],
      loginIndicator: [
        "a[href*='login']",
      ],
      captcha: [
        "iframe[src*='captcha']",
      ],
      rateLimit: [
        ".error-toast",
        "div[role='alert']",
      ],
    };
  }
}
