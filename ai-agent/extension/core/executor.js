// Executor runs steps via the ToolRegistry with retry, timeout, and logging.
export class Executor {
  constructor({ tools, logger, maxRetries = 3 }) {
    this.tools = tools;
    this.logger = logger;
    this.maxRetries = maxRetries;
  }

  async runStep(step, { onLog } = {}) {
    let attempt = 0;
    let lastErr = null;
    while (attempt <= this.maxRetries) {
      try {
        this.logger?.info(`exec ${step.action}`, { step });
        const result = await this.tools.run(step);
        if (onLog) onLog({ ok: true, step, result });
        return { ok: true, step, result, attempts: attempt + 1 };
      } catch (e) {
        lastErr = e;
        attempt += 1;
        this.logger?.warn(`step failed (${attempt}/${this.maxRetries + 1}): ${e.message}`, { step });
        if (onLog) onLog({ ok: false, step, error: e.message, attempt });
        if (attempt > this.maxRetries) break;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    return { ok: false, step, error: lastErr?.message || "unknown", attempts: attempt };
  }
}
