// JSON cleanup helpers shared by background and panel.
export function stripFences(text) {
  if (!text) return "";
  return String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
}

export function extractJSON(text) {
  if (!text) throw new Error("empty response");
  let t = stripFences(text);
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  if (i >= 0 && j > i) t = t.slice(i, j + 1);
  return JSON.parse(t);
}

export function safeExtractJSON(text, fallback = null) {
  try { return extractJSON(text); } catch { return fallback; }
}

// crude unified diff renderer
export function unifiedDiff(oldText, newText, path = "file") {
  const oldLines = (oldText || "").split("\n");
  const newLines = (newText || "").split("\n");
  const out = [`--- a/${path}`, `+++ b/${path}`];
  // simple line-by-line; not LCS, but stable for previews
  const max = Math.max(oldLines.length, newLines.length);
  let i = 0;
  while (i < max) {
    const a = oldLines[i] ?? "";
    const b = newLines[i] ?? "";
    if (a === b) {
      out.push(" " + a);
    } else {
      if (i < oldLines.length) out.push("-" + a);
      if (i < newLines.length) out.push("+" + b);
    }
    i++;
  }
  return out.join("\n");
}
