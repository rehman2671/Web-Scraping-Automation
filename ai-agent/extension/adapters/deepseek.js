import AIAdapter from "./baseAdapter.js";

export default class DeepSeekAdapter extends AIAdapter {
  constructor(utils) {
    super(utils);
    this.name = "deepseek";
    this.selectors = {
      input: [
        "textarea#chat-input",
        "textarea[placeholder*='Message' i]",
        "div[contenteditable='true']",
      ],
      sendButton: [
        "div[role='button'][aria-label*='Send' i]",
        "button[aria-label*='Send' i]",
        "button._7436e9",
        "form button[type='submit']",
      ],
      responseContainer: [
        "div._4f9bf79",
        ".chat-message-assistant",
      ],
      lastResponse: [
        "div._4f9bf79:last-of-type",
        ".chat-message-assistant:last-of-type .markdown",
        "div[class*='message']:last-of-type",
      ],
      spinner: [
        "div[aria-label='Stop' i]",
        "button[aria-label='Stop' i]",
        ".thinking-indicator",
      ],
      loginIndicator: [
        "a[href*='/sign_in']",
        "button:has-text('Log in')",
      ],
      captcha: [
        "iframe[src*='captcha']",
      ],
      rateLimit: [
        "div[role='alert']",
        ".error-message",
      ],
    };
  }
}
