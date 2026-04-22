// Planner generates a hierarchical plan: { goal, tasks: [{ name, steps: [...] }] }
// It asks the routed planning model and parses JSON.
import { extractJSON } from "./parser.js";

export class Planner {
  constructor({ runPrompt }) {
    this.runPrompt = runPrompt; // (taskKind, prompt) => Promise<{provider,text}>
  }

  buildPrompt(goal, projectContext = "") {
    return [
      "You are an autonomous coding agent planner.",
      "Respond ONLY in valid JSON. No prose, no markdown.",
      'Schema: {"goal":"...", "tasks":[{"name":"...", "steps":[{"action":"read_file|write_file|list_files|execute_command|install_package|run_tests|git_commit|git_rollback","path":"","content":"","cmd":""}]}]}',
      "Allowed actions: read_file, write_file, list_files, execute_command, install_package, run_tests, git_commit, git_rollback.",
      "Order steps so dependencies come first. Keep steps small and verifiable.",
      `GOAL:\n${goal}`,
      projectContext ? `PROJECT CONTEXT:\n${projectContext}` : "",
    ].filter(Boolean).join("\n\n");
  }

  async plan(goal, projectContext = "") {
    const { text } = await this.runPrompt("planning", this.buildPrompt(goal, projectContext));
    const plan = extractJSON(text);
    if (!plan || !Array.isArray(plan.tasks)) throw new Error("planner produced invalid plan");
    return plan;
  }
}
