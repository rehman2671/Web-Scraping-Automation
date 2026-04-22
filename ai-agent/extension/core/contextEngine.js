// Asks backend for project index and per-file summaries; ranks files by relevance.
export class ContextEngine {
  constructor(backendUrl) { this.backendUrl = backendUrl; }
  async _api(path, body, method = "POST") {
    const init = { method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(this.backendUrl + path, init);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async index() { return this._api("/project/index", undefined, "GET"); }
  async summary(path) { return this._api("/project/summary", { path }); }
  async readFile(path) { return this._api("/read_file", { path }); }

  // Score files by overlap with query keywords (very lightweight, no embedding model).
  rank(files, query, limit = 12) {
    const q = (query || "").toLowerCase().split(/\W+/).filter(Boolean);
    if (q.length === 0) return files.slice(0, limit);
    const scored = files.map((f) => {
      const p = f.path.toLowerCase();
      let s = 0;
      for (const w of q) if (p.includes(w)) s += 2;
      // prefer source files
      if (/\.(ts|tsx|js|jsx|py|go|rs|java)$/.test(p)) s += 1;
      // small files first as ties
      s -= Math.min(f.size / 50000, 1);
      return { f, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => x.f);
  }
}
