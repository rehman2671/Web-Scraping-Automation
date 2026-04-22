const $ = (id) => document.getElementById(id);

async function loadConfig() {
  const cfg = await fetch(chrome.runtime.getURL("config.json")).then((r) => r.json());
  const stored = await chrome.storage.local.get(["backendUrl"]);
  $("backend-url").value = stored.backendUrl || cfg.backendUrl;
  return cfg;
}

async function api(path, opts = {}) {
  const base = $("backend-url").value.replace(/\/+$/, "");
  const res = await fetch(base + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshProjects() {
  try {
    const { projects } = await api("/project/list");
    const sel = $("project-select");
    sel.innerHTML = "";
    for (const p of projects) {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = p;
      sel.appendChild(o);
    }
    const status = await api("/status");
    $("state").textContent = status.agent_state || "IDLE";
    $("conn-dot").classList.add("ok");
  } catch (e) {
    $("conn-dot").classList.remove("ok");
    $("state").textContent = "BACKEND OFFLINE";
  }
}

$("refresh-projects").addEventListener("click", refreshProjects);

$("create-project").addEventListener("click", async () => {
  const name = $("new-project").value.trim();
  if (!name) return;
  await api("/project/create", { method: "POST", body: JSON.stringify({ name }) });
  $("new-project").value = "";
  await refreshProjects();
});

$("backend-url").addEventListener("change", async () => {
  await chrome.storage.local.set({ backendUrl: $("backend-url").value });
  refreshProjects();
});

$("open-panel").addEventListener("click", async () => {
  const url = chrome.runtime.getURL("ui/panel.html");
  await chrome.tabs.create({ url });
});

async function selectProject() {
  const name = $("project-select").value;
  if (!name) throw new Error("pick a project first");
  await api("/project/select", { method: "POST", body: JSON.stringify({ name }) });
  return name;
}

$("start-agent").addEventListener("click", async () => {
  try {
    const project = await selectProject();
    const goal = $("goal").value.trim();
    if (!goal) {
      alert("Enter a goal first.");
      return;
    }
    await chrome.runtime.sendMessage({ type: "AGENT_START", goal, project });
    $("state").textContent = "PLANNING";
  } catch (e) {
    alert(e.message);
  }
});

$("pause-agent").addEventListener("click", () =>
  chrome.runtime.sendMessage({ type: "AGENT_PAUSE" })
);
$("resume-agent").addEventListener("click", () =>
  chrome.runtime.sendMessage({ type: "AGENT_RESUME" })
);
$("stop-agent").addEventListener("click", async () => {
  try { await api("/cancel", { method: "POST" }); } catch {}
  chrome.runtime.sendMessage({ type: "AGENT_STOP" });
});

(async () => {
  await loadConfig();
  await refreshProjects();
})();
