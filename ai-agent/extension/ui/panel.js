import { AgentSocket } from "../core/websocket.js";
import { renderUnifiedHTML, renderSideBySideHTML } from "../core/diffViewer.js";
import { logger } from "../core/logger.js";

const $ = (id) => document.getElementById(id);

let CONFIG = null;
let SOCKET = null;
let CURRENT_PLAN = null;
let CURRENT_DIFF = { path: "", oldText: "", newText: "", mode: "unified" };

const FILTERS = { DEBUG: false, INFO: true, WARN: true, ERROR: true };
const APPROVALS = new Map(); // id -> { kind, step, path, oldContent, newContent, cmd }
let AUTO_APPROVE = false;

async function loadConfig() {
  CONFIG = await fetch(chrome.runtime.getURL("config.json")).then((r) => r.json());
  const stored = await chrome.storage.local.get(["backendUrl", "wsUrl"]);
  if (stored.backendUrl) CONFIG.backendUrl = stored.backendUrl;
  if (stored.wsUrl) CONFIG.wsUrl = stored.wsUrl;
}

async function api(path, body, method = "POST") {
  const init = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(CONFIG.backendUrl + path, init);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(data.detail || data.raw || `HTTP ${r.status}`);
  return data;
}

function appendChat(text, kind = "agent") {
  const div = document.createElement("div");
  div.className = "msg " + kind;
  div.textContent = text;
  $("chat-log").appendChild(div);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

function appendLog(entry) {
  if (!FILTERS[entry.level]) return;
  const div = document.createElement("div");
  div.className = "log-row " + entry.level;
  const t = new Date(entry.timestamp).toLocaleTimeString();
  div.textContent = `[${t}] ${entry.source}: ${entry.message}`;
  $("log-view").appendChild(div);
  $("log-view").scrollTop = $("log-view").scrollHeight;
}

function renderPlan(plan) {
  CURRENT_PLAN = plan;
  $("plan-view").textContent = JSON.stringify(plan, null, 2);
  const tree = $("task-tree");
  tree.innerHTML = "";
  for (const task of plan.tasks || []) {
    const ti = document.createElement("li");
    ti.className = "task";
    ti.textContent = task.name || "(unnamed)";
    tree.appendChild(ti);
    for (const step of task.steps || []) {
      const si = document.createElement("li");
      si.className = "step";
      si.textContent = `• ${step.action} ${step.path || step.cmd || ""}`;
      tree.appendChild(si);
    }
  }
}

async function refreshFiles(path = "") {
  try {
    const data = await api("/list_files", { path });
    $("cwd").textContent = "/" + (path || "");
    const ul = $("file-tree");
    ul.innerHTML = "";
    if (path) {
      const up = document.createElement("li");
      up.className = "dir";
      up.textContent = "../";
      const parent = path.split("/").slice(0, -1).join("/");
      up.onclick = () => refreshFiles(parent);
      ul.appendChild(up);
    }
    for (const e of data.entries) {
      const li = document.createElement("li");
      li.textContent = e.is_dir ? "📁 " + e.name : "📄 " + e.name;
      if (e.is_dir) {
        li.className = "dir";
        li.onclick = () => refreshFiles((path ? path + "/" : "") + e.name);
      } else {
        li.onclick = async () => {
          try {
            const r = await api("/read_file", { path: (path ? path + "/" : "") + e.name });
            CURRENT_DIFF = { path: r.path, oldText: r.content, newText: r.content, mode: "unified" };
            $("diff-path").textContent = r.path;
            renderDiff();
            switchTab("diff");
          } catch (err) { logger.error(err.message); }
        };
      }
      ul.appendChild(li);
    }
  } catch (e) {
    $("cwd").textContent = "(no project selected) — " + e.message;
  }
}

function renderDiff() {
  const html = CURRENT_DIFF.mode === "side"
    ? renderSideBySideHTML(CURRENT_DIFF.oldText, CURRENT_DIFF.newText, CURRENT_DIFF.path)
    : renderUnifiedHTML(CURRENT_DIFF.oldText, CURRENT_DIFF.newText, CURRENT_DIFF.path);
  $("diff-view").innerHTML = html;
}

function switchTab(name) {
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of document.querySelectorAll(".pane")) p.classList.toggle("hidden", p.id !== "pane-" + name);
}

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

document.querySelectorAll(".log-filters input").forEach((cb) =>
  cb.addEventListener("change", () => { FILTERS[cb.dataset.level] = cb.checked; }),
);

$("diff-mode-unified").onclick = () => { CURRENT_DIFF.mode = "unified"; $("diff-mode-unified").classList.add("active"); $("diff-mode-side").classList.remove("active"); renderDiff(); };
$("diff-mode-side").onclick = () => { CURRENT_DIFF.mode = "side"; $("diff-mode-side").classList.add("active"); $("diff-mode-unified").classList.remove("active"); renderDiff(); };

$("diff-approve").onclick = async () => {
  if (!CURRENT_DIFF.path) return;
  try {
    await api("/write_file", { path: CURRENT_DIFF.path, content: CURRENT_DIFF.newText });
    appendChat("Wrote " + CURRENT_DIFF.path, "system");
  } catch (e) { logger.error(e.message); }
};
$("diff-reject").onclick = () => appendChat("Rejected diff for " + CURRENT_DIFF.path, "system");

// ---------- Approval queue ----------
function updateApprovalBadge() {
  const n = APPROVALS.size;
  const badge = $("approval-badge");
  badge.textContent = String(n);
  badge.classList.toggle("hidden", n === 0);
}

function escapeHTML(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderApprovals() {
  const list = $("approvals-list");
  list.innerHTML = "";
  if (APPROVALS.size === 0) {
    list.innerHTML = '<div class="empty">No pending approvals.</div>';
    updateApprovalBadge();
    return;
  }
  for (const [id, a] of APPROVALS) {
    const card = document.createElement("div");
    card.className = "approval-card " + a.kind;
    let body = "";
    if (a.kind === "plan_batch") {
      const writes = a.writes || [];
      const cmds = a.cmds || [];
      const writesHTML = writes.map((w, i) => {
        const diff = renderUnifiedHTML(w.oldContent || "", w.newContent || "", w.path);
        const prior = w.previous && w.previous.total > 0
          ? `<span class="ap-prior-tag ${w.previous.last && w.previous.last.decision === "reject" ? "warn" : "info"}">prev: ${escapeHTML(w.previous.last.decision)}</span>`
          : "";
        return `<details ${i < 3 ? "open" : ""} class="batch-item">
          <summary><b>${escapeHTML(w.task || "")}</b> — write <code>${escapeHTML(w.path)}</code> ${prior}</summary>
          <div class="ap-diff">${diff}</div>
        </details>`;
      }).join("");
      const cmdsHTML = cmds.map((c) => {
        const prior = c.previous && c.previous.total > 0
          ? `<span class="ap-prior-tag ${c.previous.last && c.previous.last.decision === "reject" ? "warn" : "info"}">prev: ${escapeHTML(c.previous.last.decision)}</span>`
          : "";
        return `<div class="batch-cmd"><b>${escapeHTML(c.task || "")}</b> ${prior}<pre class="ap-cmd">$ ${escapeHTML(c.cmd)}</pre></div>`;
      }).join("");
      body = `<div class="ap-meta"><b>Approve full plan</b> — ${writes.length} write(s), ${cmds.length} command(s)</div>
              <div class="batch-goal">Goal: ${escapeHTML(a.goal || "")}</div>
              ${writesHTML}
              ${cmdsHTML}`;
    } else if (a.kind === "write_file") {
      const diffHTML = renderUnifiedHTML(a.oldContent || "", a.newContent || "", a.path);
      body = `<div class="ap-meta"><b>Write file</b> <code>${escapeHTML(a.path)}</code></div>
              <div class="ap-diff">${diffHTML}</div>`;
    } else if (a.kind === "execute_command") {
      body = `<div class="ap-meta"><b>Execute command</b></div>
              <pre class="ap-cmd">$ ${escapeHTML(a.cmd)}</pre>`;
    }

    // Prior decisions banner
    let banner = "";
    const p = a.previous;
    if (p && p.total > 0) {
      const lastWhen = p.last && p.last.timestamp ? new Date(p.last.timestamp).toLocaleString() : "?";
      const lastDec = (p.last && p.last.decision) || "?";
      const cls = p.rejected > 0 && lastDec === "reject" ? "warn" : "info";
      banner = `<div class="ap-prior ${cls}">
        Seen before — approved ${p.approved}× / rejected ${p.rejected}×.
        Last: <b>${escapeHTML(lastDec)}</b> at ${escapeHTML(lastWhen)}.
      </div>`;
    }

    card.innerHTML = `
      ${banner}
      <div class="ap-body">${body}</div>
      <div class="ap-actions">
        <button class="primary" data-act="approve">Approve</button>
        <button class="danger" data-act="reject">Reject</button>
      </div>`;
    card.querySelector('[data-act="approve"]').onclick = () => respondApproval(id, "approve");
    card.querySelector('[data-act="reject"]').onclick = () => respondApproval(id, "reject");
    list.appendChild(card);
  }
  updateApprovalBadge();
}

function respondApproval(id, decision) {
  chrome.runtime.sendMessage({ type: "AGENT_APPROVAL_RESPONSE", id, decision }).catch(() => {});
  APPROVALS.delete(id);
  renderApprovals();
  appendChat(`${decision === "approve" ? "Approved" : "Rejected"} ${id}`, "system");
}

function addApproval(payload) {
  APPROVALS.set(payload.id, payload);
  renderApprovals();
  appendChat(
    payload.kind === "write_file"
      ? `Approval needed: write_file ${payload.path}`
      : `Approval needed: execute_command "${payload.cmd}"`,
    "system",
  );
  // Auto-flip to approvals tab on first one if no other approvals were pending
  if (APPROVALS.size === 1) switchTab("approvals");
  if (AUTO_APPROVE) respondApproval(payload.id, "approve");
}

$("auto-approve").addEventListener("change", (e) => {
  AUTO_APPROVE = e.target.checked;
  if (AUTO_APPROVE) {
    for (const id of Array.from(APPROVALS.keys())) respondApproval(id, "approve");
  }
});

$("chat-send").onclick = async () => {
  const text = $("chat-text").value.trim();
  if (!text) return;
  appendChat(text, "user");
  $("chat-text").value = "";
  // route a free-form prompt via background using "coding" task kind
  try {
    const resp = await chrome.runtime.sendMessage({ type: "AGENT_RUN_PROMPT", taskKind: "coding", prompt: text });
    if (resp && resp.ok) appendChat(resp.text || "(empty)", "agent");
    else appendChat("Error: " + (resp && resp.error), "system");
  } catch (e) { appendChat("Error: " + e.message, "system"); }
};

$("btn-pause").onclick = () => chrome.runtime.sendMessage({ type: "AGENT_PAUSE" });
$("btn-resume").onclick = () => chrome.runtime.sendMessage({ type: "AGENT_RESUME" });
$("btn-stop").onclick = async () => {
  try { await api("/cancel"); } catch {}
  chrome.runtime.sendMessage({ type: "AGENT_STOP" });
};

// route runtime messages from background
chrome.runtime.onMessage.addListener((msg) => {
  const type = msg.type;
  const payload = msg.payload || {};
  if (type === "status") $("state").textContent = payload.state || "?";
  else if (type === "ws_status") $("ws-dot").classList.toggle("ok", !!payload.connected);
  else if (type === "plan") renderPlan(payload);
  else if (type === "log") appendLog({ timestamp: msg.timestamp || Date.now(), level: payload.level || "INFO", source: payload.source || "agent", message: payload.message || JSON.stringify(payload) });
  else if (type === "error") appendLog({ timestamp: Date.now(), level: "ERROR", source: payload.source || "agent", message: payload.message || JSON.stringify(payload) });
  else if (type === "command_output") appendLog({ timestamp: Date.now(), level: "INFO", source: "cmd", message: payload.line });
  else if (type === "command_started") appendChat("$ " + payload.cmd, "system");
  else if (type === "command_finished") appendChat("(exit " + payload.code + ")", "system");
  else if (type === "approval_request") addApproval(payload);
  else if (type === "approval_resolved") { APPROVALS.delete(payload.id); renderApprovals(); }
  else if (type === "file_external_update") appendLog({ timestamp: Date.now(), level: "INFO", source: "watcher", message: `${payload.event}: ${payload.path}` });
  else if (type === "file_written") refreshFiles($("cwd").textContent.replace(/^\//, "").replace(/\/$/, ""));
  else if (type === "test_result") appendLog({ timestamp: Date.now(), level: payload.ok ? "INFO" : "ERROR", source: "tests", message: `tests ${payload.ok ? "passed" : "failed"} (code ${payload.code})` });
});

logger.subscribe(appendLog);

(async () => {
  await loadConfig();
  SOCKET = new AgentSocket(CONFIG.wsUrl);
  SOCKET.on((msg) => {
    chrome.runtime.sendMessage(msg).catch(() => {});
  });
  SOCKET.connect();
  // initial status
  try {
    const s = await api("/status", undefined, "GET");
    $("state").textContent = s.agent_state || "IDLE";
    appendChat(`Active project: ${s.active_project || "(none — pick one in the popup)"}`, "system");
    refreshFiles("");
  } catch (e) {
    appendChat("Backend offline: " + e.message, "system");
  }
})();
