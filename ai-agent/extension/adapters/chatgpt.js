import AIAdapter from "./baseAdapter.js";

export default class ChatGPTAdapter extends AIAdapter {
  constructor(utils) {
    super(utils);
    this.name = "chatgpt";
    this.selectors = {
      input: [
        "div#prompt-textarea[contenteditable='true']",
        "textarea#prompt-textarea",
        "textarea[data-id='root']",
        "div[contenteditable='true'][data-virtualkeyboard]",
        "main form textarea",
      ],
      sendButton: [
        "button[data-testid='send-button']",
        "button[aria-label*='Send' i]",
        "form button[type='submit']",
      ],
      responseContainer: [
        "main [data-message-author-role='assistant']",
      ],
      lastResponse: [
        "main [data-message-author-role='assistant']:last-of-type .markdown",
        "main [data-message-author-role='assistant']:last-of-type",
      ],
      spinner: [
        "button[data-testid='stop-button']",
        "[aria-label='Stop generating']",
        ".result-streaming",
      ],
      loginIndicator: [
        "button[data-testid='login-button']",
        "a[href*='/auth/login']",
      ],
      captcha: [
        "iframe[src*='captcha']",
        "div#challenge-stage",
      ],
      rateLimit: [
        "div[role='alert']",
      ],
    };
  }

  async isLoggedIn() {
    if (this.utils.findFirst(this.selectors.loginIndicator)) return false;
    return !!this.utils.findFirst(this.selectors.input);
  }
}
