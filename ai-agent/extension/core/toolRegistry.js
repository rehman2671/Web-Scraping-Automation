// Registry of executable agent actions. Each tool calls a backend endpoint.
export class ToolRegistry {
  constructor(backendUrl) {
    this.backendUrl = backendUrl;
    this.tools = {};
    this._register();
  }

  async _post(path, body) {
    const r = await fetch(this.backendUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    if (!r.ok) throw new Error(data.detail || data.raw || `HTTP ${r.status}`);
    return data;
  }

  _register() {
    this.tools.read_file = (s) => this._post("/read_file", { path: s.path });
    this.tools.write_file = (s) => this._post("/write_file", { path: s.path, content: s.content || "" });
    this.tools.list_files = (s) => this._post("/list_files", { path: s.path || "" });
    this.tools.execute_command = (s) => this._post("/execute", { cmd: s.cmd, timeout: s.timeout || 60 });
    this.tools.install_package = (s) => this._post("/execute", { cmd: s.cmd, timeout: 180 });
    this.tools.run_tests = () => this._post("/run_tests", {});
    this.tools.git_commit = (s) => this._post("/git/commit", { message: s.message || "agent commit" });
    this.tools.git_rollback = (s) => this._post("/git/rollback", { sha: s.sha || null });
  }

  has(name) { return !!this.tools[name]; }
  list() { return Object.keys(this.tools); }
  async run(step) {
    const fn = this.tools[step.action];
    if (!fn) throw new Error("unknown action: " + step.action);
    return fn(step);
  }
}
