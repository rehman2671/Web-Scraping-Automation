// WebSocket client used by panel.js. Auto-reconnect with exponential backoff.
export class AgentSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.subs = new Set();
    this.connected = false;
    this.backoff = 1000;
    this.shouldRun = true;
  }
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  _emit(msg) { for (const s of this.subs) try { s(msg); } catch {} }

  connect() {
    if (!this.shouldRun) return;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => { this.connected = true; this.backoff = 1000; this._emit({ type: "ws_status", payload: { connected: true } }); };
      this.ws.onclose = () => {
        this.connected = false;
        this._emit({ type: "ws_status", payload: { connected: false } });
        if (this.shouldRun) setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 15000);
      };
      this.ws.onerror = () => {};
      this.ws.onmessage = (e) => {
        try { this._emit(JSON.parse(e.data)); } catch { this._emit({ type: "log", payload: { message: e.data } }); }
      };
    } catch {
      setTimeout(() => this.connect(), this.backoff);
    }
  }

  send(type, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload, timestamp: Date.now() }));
    }
  }

  close() { this.shouldRun = false; try { this.ws && this.ws.close(); } catch {} }
}
