// Provider router with weighted routing matrix and fallback order.
export class Router {
  constructor(config) {
    this.routes = config.routing || {};
    this.fallback = config.fallbackOrder || [];
  }
  pick(taskKind) {
    const primary = this.routes[taskKind] || this.fallback[0];
    return [primary, ...this.fallback.filter((p) => p !== primary)];
  }
}
