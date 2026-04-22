// Memory engine that talks to the backend memory store + chrome.storage.local cache.
export class Memory {
  constructor(backendUrl) {
    this.backendUrl = backendUrl;
  }

  async _api(path, body, method = "POST") {
    const init = { method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(this.backendUrl + path, init);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  async load(name) {
    const { data } = await this._api("/memory/" + name, undefined, "GET");
    return data;
  }
  async save(name, data) {
    return this._api("/memory/save", { file: name, data });
  }

  // Normalize a stack trace before hashing, removes line numbers + file paths
  normalizeError(text) {
    if (!text) return "";
    return String(text)
      .replace(/[A-Za-z0-9_\-./\\]+:\d+(:\d+)?/g, "<loc>")
      .replace(/0x[0-9a-fA-F]+/g, "<hex>")
      .replace(/\d+/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
  }
  async hashError(text) {
    const norm = this.normalizeError(text);
    const buf = new TextEncoder().encode(norm);
    const h = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async recordError(errorMessage, fixApplied, success) {
    const list = (await this.load("error_memory")) || [];
    const error_hash = await this.hashError(errorMessage);
    list.push({ error_hash, error_message: errorMessage, fix_applied: fixApplied, success, ts: Date.now() });
    await this.save("error_memory", list);
  }

  async findFix(errorMessage) {
    const list = (await this.load("error_memory")) || [];
    const target = await this.hashError(errorMessage);
    const match = list.find((r) => r.error_hash === target && r.success);
    return match ? match.fix_applied : null;
  }
}
