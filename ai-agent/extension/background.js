// Service worker. Coordinates the agent loop, websocket connection,
// state checkpointing, and message routing between popup/panel/content scripts.

let CONFIG = null;
let WS = null;
let WS_RECONNECT_TIMER = null;
let CHECKPOINT_TIMER = null;

const STATE = {
  agentState: "IDLE",
  goal: "",
  project: "",
  plan: null,
  cursor: { taskIdx: 0, stepIdx: 0 },
  pause: false,
  cancel: false,
  iterations: 0,
  history: [],
};

async function loadConfig() {
  if (CONFIG) return CONFIG;
  CONFIG = await fetch(chrome.runtime.getURL("config.json")).then((r) => r.json());
  const stored = await chrome.storage.local.get(["backendUrl", "wsUrl", "agentSnapshot"]);
  if (stored.backendUrl) CONFIG.backendUrl = stored.backendUrl;
  if (stored.wsUrl) CONFIG.wsUrl = stored.wsUrl;
  if (stored.agentSnapshot) Object.assign(STATE, stored.agentSnapshot);
  return CONFIG;
}

async function api(path, body, method = "POST") {
  const cfg = await loadConfig();
  const init = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(cfg.backendUrl + path, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.detail || data.raw || `HTTP ${res.status}`);
  return data;
}

function broadcast(type, payload) {
  const msg = { type, payload, timestamp: Date.now() };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ------- WebSocket -------
async function connectWS() {
  const cfg = await loadConfig();
  if (WS && WS.readyState === WebSocket.OPEN) return;
  try {
    WS = new WebSocket(cfg.wsUrl);
    WS.onopen = () => broadcast("ws_status", { connected: true });
    WS.onclose = () => {
      broadcast("ws_status", { connected: false });
      clearTimeout(WS_RECONNECT_TIMER);
      WS_RECONNECT_TIMER = setTimeout(connectWS, 2000);
    };
    WS.onerror = () => {};
    WS.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        broadcast(data.type || "log", data.payload || {});
      } catch {}
    };
  } catch {
    WS_RECONNECT_TIMER = setTimeout(connectWS, 2000);
  }
}

function wsSend(type, payload) {
  if (WS && WS.readyState === WebSocket.OPEN) {
    WS.send(JSON.stringify({ type, payload, timestamp: Date.now() }));
  }
}

// ------- Checkpointing (every 5s) -------
function startCheckpointing() {
  clearInterval(CHECKPOINT_TIMER);
  CHECKPOINT_TIMER = setInterval(async () => {
    try {
      await chrome.storage.local.set({ agentSnapshot: STATE });
      await api("/memory/save", {
        file: "session_memory",
        data: {
          current_goal: STATE.goal,
          completed_steps: STATE.history.map((h) => h.step),
          modified_files: STATE.history.filter((h) => h.action === "write_file").map((h) => h.path),
        },
      }).catch(() => {});
    } catch {}
  }, 5000);
}

// ------- Provider dispatch via content script -------
const PROVIDER_URLS = {
  chatgpt: ["https://chatgpt.com/", "https://chat.openai.com/"],
  deepseek: ["https://chat.deepseek.com/"],
  qwen: ["https://chat.qwen.ai/"],
  gemini: ["https://gemini.google.com/app", "https://gemini.google.com/"],
};

async function findOrOpenProviderTab(provider) {
  const urls = PROVIDER_URLS[provider] || [];
  for (const u of urls) {
    const tabs = await chrome.tabs.query({ url: u + "*" });
    if (tabs.length > 0) return tabs[0];
  }
  const tab = await chrome.tabs.create({ url: urls[0], active: false });
  await new Promise((r) => setTimeout(r, 4000));
  return tab;
}

async function sendPromptToProvider(provider, prompt, timeoutMs = 120000) {
  const tab = await findOrOpenProviderTab(provider);
  // Ensure content script is alive (it auto-injects via manifest)
  return new Promise(async (resolve, reject) => {
    const requestId = "r" + Date.now() + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(handler);
      reject(new Error(`provider ${provider} timeout`));
    }, timeoutMs);
    function handler(msg) {
      if (msg && msg.type === "AI_RESPONSE" && msg.requestId === requestId) {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(handler);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.text || "");
      }
    }
    chrome.runtime.onMessage.addListener(handler);
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "AI_SEND",
        provider,
        prompt,
        requestId,
      });
    } catch (e) {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(handler);
      reject(e);
    }
  });
}

// ------- Routing with fallback -------
function pickModel(taskKind) {
  const route = (CONFIG && CONFIG.routing) || {};
  return route[taskKind] || "deepseek";
}

async function routedPrompt(taskKind, prompt) {
  const primary = pickModel(taskKind);
  const order = [primary, ...((CONFIG.fallbackOrder || []).filter((m) => m !== primary))];
  let lastErr;
  for (const provider of order) {
    try {
      broadcast("log", { source: "router", message: `try ${provider} (${taskKind})` });
      const text = await sendPromptToProvider(provider, prompt);
      return { provider, text };
    } catch (e) {
      lastErr = e;
      broadcast("error", { source: "router", message: `${provider}: ${e.message}` });
    }
  }
  throw lastErr || new Error("all providers failed");
}

// ------- JSON cleanup -------
function extractJSON(text) {
  if (!text) throw new Error("empty response");
  let t = text.trim();
  // strip code fences
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  // find first { ... last }
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  if (i >= 0 && j > i) t = t.slice(i, j + 1);
  return JSON.parse(t);
}

// ------- Agent loop -------
async function buildRejectionConstraints() {
  // Pull recent rejections from approval history so the planner can avoid them.
  let history = [];
  try {
    const r = await api("/memory/approval_history", undefined, "GET");
    history = Array.isArray(r.data) ? r.data : [];
  } catch {
    return { paths: [], cmds: [], lines: [] };
  }
  // Bucket: most-recent decision per key wins
  const lastByKey = new Map();
  for (const e of history) {
    const prev = lastByKey.get(e.key);
    if (!prev || (e.timestamp || 0) > (prev.timestamp || 0)) lastByKey.set(e.key, e);
  }
  const recentMs = 1000 * 60 * 60 * 24 * 30; // 30 days
  const cutoff = Date.now() - recentMs;
  const rejectedPaths = new Set();
  const rejectedCmds = new Set();
  for (const e of lastByKey.values()) {
    if (e.decision !== "reject") continue;
    if ((e.timestamp || 0) < cutoff) continue;
    if (e.kind === "write_file" && e.path) rejectedPaths.add(e.path);
    if (e.kind === "execute_command" && e.cmd) rejectedCmds.add(e.cmd);
  }
  const paths = Array.from(rejectedPaths).slice(0, 50);
  const cmds = Array.from(rejectedCmds).slice(0, 50);
  const lines = [];
  if (paths.length) lines.push("Avoid writing to these files (previously rejected by user): " + JSON.stringify(paths));
  if (cmds.length) lines.push("Avoid these commands (previously rejected by user): " + JSON.stringify(cmds));
  if (lines.length) lines.push("If you must touch a rejected target, choose a clearly different path or a safer command.");
  return { paths, cmds, lines };
}

async function planGoal(goal) {
  const constraints = await buildRejectionConstraints();
  if (constraints.lines.length) {
    broadcast("log", {
      source: "planner",
      level: "INFO",
      message: `applying ${constraints.paths.length} path + ${constraints.cmds.length} command rejection constraints`,
    });
  }
  const promptParts = [
    "You are an autonomous coding agent planner.",
    "Respond ONLY in valid JSON. No explanation. No markdown.",
    "Schema:",
    `{"goal":"...", "tasks":[{"name":"...", "steps":[{"action":"read_file|write_file|list_files|execute_command|install_package|run_tests|git_commit|git_rollback","path":"","content":"","cmd":""}]}]}`,
  ];
  if (constraints.lines.length) {
    promptParts.push("CONSTRAINTS:");
    promptParts.push(...constraints.lines);
  }
  promptParts.push(`Goal: ${goal}`);
  const { text } = await routedPrompt("planning", promptParts.join("\n"));
  return extractJSON(text);
}

// ------- Approval queue -------
const PENDING_APPROVALS = new Map(); // id -> { resolve, key, kind, step, extras }

async function _sha256(text) {
  const buf = new TextEncoder().encode(text || "");
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function approvalKey(kind, step, extras = {}) {
  if (kind === "write_file") {
    const hash = await _sha256(extras.newContent || "");
    return `write:${step.path}:${hash.slice(0, 16)}`;
  }
  if (kind === "execute_command") {
    return `cmd:${(step.cmd || "").trim()}`;
  }
  return `${kind}:${JSON.stringify(step)}`;
}

async function loadApprovalHistory() {
  try {
    const r = await api("/memory/approval_history", undefined, "GET");
    return Array.isArray(r.data) ? r.data : [];
  } catch {
    return [];
  }
}

async function appendApprovalHistory(entry) {
  try {
    const list = await loadApprovalHistory();
    list.push(entry);
    // cap at 500 most-recent
    const trimmed = list.slice(-500);
    await api("/memory/save", { file: "approval_history", data: trimmed });
  } catch (e) {
    broadcast("log", { source: "approval", level: "WARN", message: "history save failed: " + e.message });
  }
}

async function findPriorDecisions(key) {
  const list = await loadApprovalHistory();
  const matches = list.filter((e) => e.key === key);
  if (matches.length === 0) return null;
  let approved = 0, rejected = 0, last = null;
  for (const m of matches) {
    if (m.decision === "approve") approved += 1;
    else if (m.decision === "reject") rejected += 1;
    if (!last || (m.timestamp || 0) > (last.timestamp || 0)) last = m;
  }
  return { approved, rejected, total: matches.length, last };
}

async function requestApproval(kind, step, extras = {}) {
  const id = "ap_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const key = await approvalKey(kind, step, extras);
  const previous = await findPriorDecisions(key);
  const payload = { id, kind, step, key, previous, ...extras };
  broadcast("approval_request", payload);
  return new Promise((resolve) => {
    PENDING_APPROVALS.set(id, { resolve, key, kind, step, extras, payload });
  });
}

function resolveApproval(id, decision) {
  const entry = PENDING_APPROVALS.get(id);
  if (!entry) return false;
  const approved = decision === "approve";
  entry.resolve(approved);
  PENDING_APPROVALS.delete(id);
  broadcast("approval_resolved", { id, decision });
  // Persist (fire-and-forget)
  appendApprovalHistory({
    timestamp: Date.now(),
    key: entry.key,
    kind: entry.kind,
    decision,
    path: entry.extras.path || null,
    cmd: entry.extras.cmd || null,
    project: STATE.project || null,
  });
  return true;
}

async function gateWriteFile(step) {
  if (!CONFIG.approval || !CONFIG.approval.requireForWrites) return true;
  let oldContent = "";
  try {
    const r = await api("/read_file", { path: step.path });
    oldContent = r.content || "";
  } catch {
    oldContent = ""; // file does not exist yet
  }
  const ok = await requestApproval("write_file", step, {
    path: step.path,
    oldContent,
    newContent: step.content || "",
  });
  return ok;
}

async function gateExecuteCommand(step) {
  if (!CONFIG.approval || !CONFIG.approval.requireForCommands) return true;
  return requestApproval("execute_command", step, { cmd: step.cmd });
}

async function executeStep(step) {
  const action = step.action;
  switch (action) {
    case "read_file":
      return api("/read_file", { path: step.path });
    case "write_file": {
      const ok = await gateWriteFile(step);
      if (!ok) {
        broadcast("log", { source: "approval", level: "WARN", message: `write_file ${step.path} rejected by user` });
        return { ok: false, rejected: true, path: step.path };
      }
      return api("/write_file", { path: step.path, content: step.content || "" });
    }
    case "list_files":
      return api("/list_files", { path: step.path || "" });
    case "execute_command":
    case "install_package": {
      const ok = await gateExecuteCommand(step);
      if (!ok) {
        broadcast("log", { source: "approval", level: "WARN", message: `command rejected by user: ${step.cmd}` });
        return { ok: false, rejected: true, cmd: step.cmd };
      }
      return api("/execute", { cmd: step.cmd, timeout: 120 });
    }
    case "run_tests":
      return api("/run_tests", {});
    case "git_commit":
      return api("/git/commit", { message: step.message || "agent commit" });
    case "git_rollback":
      return api("/git/rollback", { sha: step.sha || null });
    default:
      throw new Error("unknown action: " + action);
  }
}

async function runAgentLoop() {
  const cfg = await loadConfig();
  STATE.iterations = 0;
  STATE.cancel = false;
  STATE.pause = false;
  startCheckpointing();

  await api("/state/PLANNING").catch(() => {});
  STATE.agentState = "PLANNING";
  broadcast("status", { state: "PLANNING" });

  try {
    if (!STATE.plan) STATE.plan = await planGoal(STATE.goal);
    broadcast("plan", STATE.plan);
  } catch (e) {
    broadcast("error", { source: "planner", message: e.message });
    STATE.agentState = "FAILED";
    await api("/state/FAILED").catch(() => {});
    return;
  }

  STATE.agentState = "EXECUTING";
  await api("/state/EXECUTING").catch(() => {});
  broadcast("status", { state: "EXECUTING" });

  const tasks = STATE.plan.tasks || [];
  while (STATE.cursor.taskIdx < tasks.length) {
    if (STATE.cancel) break;
    while (STATE.pause && !STATE.cancel) await new Promise((r) => setTimeout(r, 500));

    const task = tasks[STATE.cursor.taskIdx];
    const steps = task.steps || [];
    while (STATE.cursor.stepIdx < steps.length) {
      if (STATE.cancel) break;
      while (STATE.pause && !STATE.cancel) await new Promise((r) => setTimeout(r, 500));

      STATE.iterations += 1;
      if (STATE.iterations > cfg.loop.maxIterations) {
        broadcast("error", { source: "loop", message: "max iterations reached" });
        STATE.agentState = "FAILED";
        await api("/state/FAILED").catch(() => {});
        return;
      }

      const step = steps[STATE.cursor.stepIdx];
      broadcast("progress", {
        task: task.name,
        step,
        taskIdx: STATE.cursor.taskIdx,
        stepIdx: STATE.cursor.stepIdx,
      });

      let attempt = 0;
      let lastErr = null;
      while (attempt <= cfg.loop.maxRetries) {
        try {
          const result = await executeStep(step);
          STATE.history.push({ step: step.action, path: step.path || step.cmd, action: step.action, ok: true });
          broadcast("log", { source: "executor", message: `ok: ${step.action}`, result });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          attempt += 1;
          broadcast("error", { source: "executor", message: e.message, step });
          if (attempt > cfg.loop.maxRetries) break;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
      if (lastErr) {
        // ask debugger model for a fix suggestion
        try {
          const fixPrompt = [
            "You are an autonomous debugger.",
            "Respond ONLY in valid JSON. No explanation.",
            'Schema: {"action":"...","path":"","content":"","cmd":""}',
            `Failed step: ${JSON.stringify(step)}`,
            `Error: ${lastErr.message}`,
          ].join("\n");
          const { text } = await routedPrompt("debugging", fixPrompt);
          const fixStep = extractJSON(text);
          broadcast("log", { source: "fixer", message: "applying fix", fixStep });
          await executeStep(fixStep);
        } catch (e2) {
          broadcast("error", { source: "fixer", message: e2.message });
        }
      }
      STATE.cursor.stepIdx += 1;
    }
    STATE.cursor.taskIdx += 1;
    STATE.cursor.stepIdx = 0;
  }

  STATE.agentState = STATE.cancel ? "PAUSED" : "DONE";
  await api(`/state/${STATE.agentState}`).catch(() => {});
  broadcast("status", { state: STATE.agentState });
}

// ------- Message handlers -------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "AGENT_START") {
      STATE.goal = msg.goal;
      STATE.project = msg.project;
      STATE.plan = null;
      STATE.cursor = { taskIdx: 0, stepIdx: 0 };
      STATE.history = [];
      runAgentLoop();
      sendResponse({ ok: true });
    } else if (msg.type === "AGENT_PAUSE") {
      STATE.pause = true;
      await api("/state/PAUSED").catch(() => {});
      sendResponse({ ok: true });
    } else if (msg.type === "AGENT_RESUME") {
      STATE.pause = false;
      await api("/state/EXECUTING").catch(() => {});
      sendResponse({ ok: true });
    } else if (msg.type === "AGENT_STOP") {
      STATE.cancel = true;
      sendResponse({ ok: true });
    } else if (msg.type === "AGENT_GET_STATE") {
      sendResponse({ state: STATE });
    } else if (msg.type === "AGENT_APPROVAL_RESPONSE") {
      const ok = resolveApproval(msg.id, msg.decision);
      sendResponse({ ok });
    } else if (msg.type === "AGENT_LIST_APPROVALS") {
      const items = [];
      for (const [, v] of PENDING_APPROVALS) if (v.payload) items.push(v.payload);
      sendResponse({ items });
    } else if (msg.type === "AGENT_RUN_PROMPT") {
      try {
        const out = await routedPrompt(msg.taskKind || "coding", msg.prompt);
        sendResponse({ ok: true, ...out });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  loadConfig().then(() => connectWS());
});
chrome.runtime.onStartup.addListener(() => {
  loadConfig().then(() => connectWS());
});
loadConfig().then(() => connectWS());
