// Heuristic token estimation: ~chars/4. Builds a context that fits per-model limits.
export const MODEL_LIMITS = {
  chatgpt: 8000,
  deepseek: 8000,
  qwen: 8000,
  gemini: 32000,
};

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function buildContext({ task, relevantFiles = [], summaries = [], recent = [], older = [] }, model = "chatgpt") {
  const limit = MODEL_LIMITS[model] || 8000;
  const reserved = 1024; // for response
  const budget = limit - reserved;
  const out = [];
  let used = 0;
  const push = (label, text) => {
    if (!text) return false;
    const tokens = estimateTokens(text);
    if (used + tokens > budget) return false;
    out.push(`### ${label}\n${text}`);
    used += tokens;
    return true;
  };
  push("TASK", task || "");
  for (const f of relevantFiles) push(`FILE ${f.path}`, f.content);
  for (const s of summaries) push(`SUMMARY ${s.path}`, JSON.stringify(s));
  for (const h of recent) push("RECENT", typeof h === "string" ? h : JSON.stringify(h));
  for (const h of older) push("OLDER", typeof h === "string" ? h : JSON.stringify(h));
  return { prompt: out.join("\n\n"), tokens: used, budget };
}
