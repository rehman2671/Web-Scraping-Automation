// Structured logger usable in panel/popup. Mirrors backend log shape.
const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];

export class Logger {
  constructor(source = "extension") {
    this.source = source;
    this.buffer = [];
    this.subscribers = new Set();
    this.maxBuffer = 2000;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  log(level, message, extra = {}) {
    if (!LEVELS.includes(level)) level = "INFO";
    const entry = {
      timestamp: Date.now(),
      level,
      source: this.source,
      task_id: extra.task_id || "",
      message: typeof message === "string" ? message : JSON.stringify(message),
      ...extra,
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    for (const fn of this.subscribers) {
      try { fn(entry); } catch {}
    }
    if (typeof console !== "undefined") {
      const fn = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
      fn(`[${level}] ${this.source}: ${entry.message}`);
    }
    return entry;
  }

  debug(m, e) { return this.log("DEBUG", m, e); }
  info(m, e) { return this.log("INFO", m, e); }
  warn(m, e) { return this.log("WARN", m, e); }
  error(m, e) { return this.log("ERROR", m, e); }
}

export const logger = new Logger("agent");
