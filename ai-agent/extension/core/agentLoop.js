// High-level agent loop. Drives planner -> executor -> fixer -> tests.
import { Planner } from "./planner.js";
import { Executor } from "./executor.js";
import { extractJSON } from "./parser.js";

export class AgentLoop {
  constructor({ tools, logger, runPrompt, memory, stateMachine, maxIterations = 25, maxRetries = 3 }) {
    this.tools = tools;
    this.logger = logger;
    this.runPrompt = runPrompt;
    this.memory = memory;
    this.sm = stateMachine;
    this.planner = new Planner({ runPrompt });
    this.executor = new Executor({ tools, logger, maxRetries });
    this.maxIterations = maxIterations;
    this.cancel = false;
    this.pause = false;
    this.iterations = 0;
  }

  stop() { this.cancel = true; }
  setPause(v) { this.pause = !!v; }

  async _waitIfPaused() {
    while (this.pause && !this.cancel) await new Promise((r) => setTimeout(r, 250));
  }

  async _askFix(step, errorMessage) {
    // Memory lookup first
    const known = await this.memory.findFix(errorMessage).catch(() => null);
    if (known) return known;
    const prompt = [
      "You are an autonomous debugger.",
      "Respond ONLY in valid JSON. No prose.",
      'Schema: {"action":"...","path":"","content":"","cmd":""}',
      `Failed step: ${JSON.stringify(step)}`,
      `Error: ${errorMessage}`,
    ].join("\n");
    const { text } = await this.runPrompt("debugging", prompt);
    return extractJSON(text);
  }

  async run(goal, projectContext = "") {
    this.cancel = false;
    this.pause = false;
    this.iterations = 0;

    this.sm.force("PLANNING");
    let plan;
    try {
      plan = await this.planner.plan(goal, projectContext);
    } catch (e) {
      this.logger.error("planner failed: " + e.message);
      this.sm.force("FAILED");
      return { ok: false, error: e.message };
    }

    this.sm.force("EXECUTING");
    const tasks = plan.tasks || [];
    for (let ti = 0; ti < tasks.length; ti++) {
      if (this.cancel) break;
      await this._waitIfPaused();
      const task = tasks[ti];
      for (let si = 0; si < (task.steps || []).length; si++) {
        if (this.cancel) break;
        await this._waitIfPaused();

        this.iterations += 1;
        if (this.iterations > this.maxIterations) {
          this.logger.error("max iterations reached");
          this.sm.force("FAILED");
          return { ok: false, error: "max_iterations" };
        }

        const step = task.steps[si];
        const r = await this.executor.runStep(step);
        if (!r.ok) {
          this.sm.force("FIXING");
          try {
            const fix = await this._askFix(step, r.error);
            const r2 = await this.executor.runStep(fix);
            await this.memory.recordError(r.error, fix, r2.ok).catch(() => {});
            if (!r2.ok) {
              this.logger.error("fix failed: " + r2.error);
            }
          } catch (e) {
            this.logger.error("fixer failed: " + e.message);
          }
          this.sm.force("EXECUTING");
        }
      }
    }
    this.sm.force(this.cancel ? "PAUSED" : "DONE");
    return { ok: !this.cancel, plan };
  }
}
