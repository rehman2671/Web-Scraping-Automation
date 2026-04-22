// Diff viewer helpers: produces side-by-side and unified renderings as HTML strings.
import { unifiedDiff } from "./parser.js";

export function renderUnifiedHTML(oldText, newText, path = "file") {
  const text = unifiedDiff(oldText || "", newText || "", path);
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = escaped.split("\n").map((l) => {
    const cls = l.startsWith("+") ? "diff-add" : l.startsWith("-") ? "diff-del" : l.startsWith("@@") ? "diff-hunk" : "diff-ctx";
    return `<div class="diff-line ${cls}">${l || "&nbsp;"}</div>`;
  });
  return `<div class="diff unified">${lines.join("")}</div>`;
}

export function renderSideBySideHTML(oldText, newText, path = "file") {
  const a = (oldText || "").split("\n");
  const b = (newText || "").split("\n");
  const max = Math.max(a.length, b.length);
  const rows = [];
  for (let i = 0; i < max; i++) {
    const left = (a[i] ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const right = (b[i] ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const same = a[i] === b[i];
    rows.push(`<tr class="${same ? "same" : "diff"}"><td class="lno">${i + 1}</td><td class="old">${left || "&nbsp;"}</td><td class="lno">${i + 1}</td><td class="new">${right || "&nbsp;"}</td></tr>`);
  }
  return `<table class="diff side"><thead><tr><th colspan="2">a/${path}</th><th colspan="2">b/${path}</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

export class DiffApproval {
  constructor() {
    this.pending = new Map(); // id -> {resolve, reject}
  }
  request(id) {
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  approve(id) {
    const p = this.pending.get(id);
    if (p) { p.resolve(true); this.pending.delete(id); }
  }
  reject(id) {
    const p = this.pending.get(id);
    if (p) { p.resolve(false); this.pending.delete(id); }
  }
}
