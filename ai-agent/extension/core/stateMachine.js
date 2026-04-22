export const STATES = ["IDLE", "PLANNING", "EXECUTING", "WAITING_APPROVAL", "FIXING", "PAUSED", "DONE", "FAILED"];

const TRANSITIONS = {
  IDLE: ["PLANNING"],
  PLANNING: ["EXECUTING", "FAILED", "PAUSED"],
  EXECUTING: ["WAITING_APPROVAL", "FIXING", "PAUSED", "DONE", "FAILED"],
  WAITING_APPROVAL: ["EXECUTING", "PAUSED", "FAILED"],
  FIXING: ["EXECUTING", "FAILED", "PAUSED"],
  PAUSED: ["EXECUTING", "PLANNING", "FAILED", "DONE"],
  DONE: ["IDLE", "PLANNING"],
  FAILED: ["IDLE", "PLANNING"],
};

export class StateMachine {
  constructor(initial = "IDLE") {
    this.state = initial;
    this.subs = new Set();
  }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  can(next) { return (TRANSITIONS[this.state] || []).includes(next); }
  to(next) {
    if (!STATES.includes(next)) throw new Error("invalid state " + next);
    if (!this.can(next)) throw new Error(`illegal transition ${this.state} -> ${next}`);
    this.state = next;
    for (const fn of this.subs) try { fn(next); } catch {}
    return next;
  }
  force(next) {
    this.state = next;
    for (const fn of this.subs) try { fn(next); } catch {}
  }
}
