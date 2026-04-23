# Deployment Guide — AI Autonomous Coding Agent

End-to-end guide to take this project from a Git repository and run it on any
fresh system (Linux / macOS / Windows). The product is a **two-part system**:

1. **Local FastAPI backend** (Python) on `http://localhost:8765`
2. **Chrome MV3 extension** loaded as an unpacked extension in your browser

There is **no cloud component** and **no API key** for any AI provider. The
extension drives the official ChatGPT, DeepSeek, Qwen, and Gemini web UIs
inside your own browser session.

---

## 1. Prerequisites

| Tool                       | Minimum version | Notes                                          |
| -------------------------- | --------------- | ---------------------------------------------- |
| Git                        | 2.30+           | To clone the repo                              |
| Python                     | 3.10+           | Backend runtime                                |
| pip                        | latest          | Comes with Python                              |
| Google Chrome / Chromium / Edge | 120+        | Required for MV3 extension                     |
| Logged-in accounts         | —               | ChatGPT, DeepSeek, Qwen, Gemini in the browser |

Optional but recommended on the deployment machine:

- `git` configured globally (`user.name`, `user.email`) — used by the agent's
  commit/rollback features.
- A test framework already installed for the projects you will work on
  (`pytest`, `npm`, `cargo`, `go`, `mvn`, `gradle`).

---

## 2. Clone the repository

```bash
git clone <YOUR_GIT_REMOTE_URL> ai-agent-deploy
cd ai-agent-deploy/ai-agent
```

Project layout you should see:

```
ai-agent/
├── backend/             # FastAPI server (port 8765)
│   ├── server.py
│   ├── ai_router.py
│   ├── security.py
│   ├── git_manager.py
│   ├── test_runner.py
│   ├── project_manager.py
│   ├── file_indexer.py
│   ├── websocket_manager.py
│   ├── logger.py
│   └── requirements.txt
├── extension/           # Chrome MV3 extension
│   ├── manifest.json
│   ├── background.js    # service worker
│   ├── content.js       # injected into AI provider tabs
│   ├── popup.html / popup.js
│   ├── config.json      # backend URL, routing matrix
│   ├── adapters/        # per-provider scrapers
│   ├── core/            # planner, executor, router, memory, ...
│   └── ui/              # panel.html / panel.js / styles.css
├── memory/              # JSON persistence (created/used at runtime)
└── README.md
```

---

## 3. Backend — install & run

### 3.1 Create a virtual environment

```bash
cd backend
python -m venv .venv
source .venv/bin/activate              # macOS / Linux
# .\.venv\Scripts\activate             # Windows PowerShell
```

### 3.2 Install Python dependencies

```bash
pip install -r requirements.txt
```

`requirements.txt` pins:

- `fastapi==0.115.5`
- `uvicorn[standard]==0.32.1`
- `pydantic==2.10.3`
- `watchdog==6.0.0`
- `websockets==14.1`
- `python-multipart==0.0.20`

### 3.3 Run the server

From the **`ai-agent/`** directory (one level up from `backend/`) run:

```bash
python -m uvicorn backend.server:app --host 127.0.0.1 --port 8765 --reload
```

You should see:

```
INFO:     Uvicorn running on http://127.0.0.1:8765
INFO:     Application startup complete.
```

Sanity check:

```bash
curl http://localhost:8765/        # → {"ok": true, ...}
curl http://localhost:8765/status  # → {"agent_state": "IDLE", ...}
```

### 3.4 Run as a background service (optional)

**Linux (systemd, user unit)** — create `~/.config/systemd/user/ai-agent.service`:

```ini
[Unit]
Description=AI Autonomous Coding Agent backend
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/ai-agent-deploy/ai-agent
ExecStart=%h/ai-agent-deploy/ai-agent/backend/.venv/bin/python -m uvicorn backend.server:app --host 127.0.0.1 --port 8765
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ai-agent
journalctl --user -u ai-agent -f
```

**macOS (launchd)** — create `~/Library/LaunchAgents/com.local.aiagent.plist`
with the equivalent ProgramArguments, then `launchctl load`.

**Windows** — use `nssm` or Task Scheduler to run the same `uvicorn` command at
login.

---

## 4. Extension — load into the browser

> The extension is intentionally **unpacked** — it is not on the Chrome Web
> Store. Each developer / operator loads it locally.

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the **`ai-agent/extension/`** directory.
5. Pin the **AI Coding Agent** icon in your toolbar.

### 4.1 Sign in to the AI providers in the same browser profile

Open these tabs once and complete login:

- https://chatgpt.com/
- https://chat.deepseek.com/
- https://chat.qwen.ai/
- https://gemini.google.com/

Sessions are reused via your normal browser cookies. **No API keys are stored
or required.**

### 4.2 Verify the extension can reach the backend

1. Click the extension icon → the **popup** should show backend status as
   reachable.
2. Open the **IDE panel** (the panel.html page launched from the popup).
3. The `WS` indicator in the topbar should turn green when the WebSocket is
   connected to `ws://localhost:8765/ws`.

If `WS` stays red, the extension cannot reach `localhost:8765`. Check:

- Backend process is running.
- `extension/config.json` `backendUrl` and `wsUrl` point to
  `http://localhost:8765` / `ws://localhost:8765/ws`.
- No corporate proxy is blocking loopback.

---

## 5. First run — pick a project

The backend executes filesystem and shell operations under one **active
project** directory. Nothing runs outside it.

1. In the popup → **Select project folder** → pick or create a directory on
   the deployment machine.
2. The backend stores this in `memory/session_memory.json` and indexes the
   tree.
3. The IDE panel **Files** sidebar should populate.

Optional: drop a `.agent-test-config.json` at the project root to override the
auto-detected test command:

```json
{ "framework": "custom", "command": "make test" }
```

---

## 6. Migrating to another machine

Because the system is local-first, "deployment" is just repeating §3 + §4 on
the new machine. To preserve agent memory across machines:

```bash
# On source machine
cd ai-agent
tar czf ai-agent-memory.tgz memory/

# On target machine (after clone + install)
cd ai-agent
tar xzf ai-agent-memory.tgz
```

Files inside `memory/`:

| File                      | Purpose                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `long_term_memory.json`   | Stable facts the agent learned across sessions             |
| `session_memory.json`     | Active project, last cursor, in-flight plan                |
| `error_memory.json`       | Past errors and recovery patterns                          |
| `approval_history.json`   | Approve/reject decisions (capped at 500, 30-day window)    |

---

## 7. Updating to a newer version

```bash
cd ai-agent-deploy
git pull --ff-only
cd ai-agent/backend
source .venv/bin/activate
pip install -r requirements.txt    # picks up any new deps
# restart uvicorn
```

For the extension, click the **Reload** icon on the
`chrome://extensions` card after a `git pull` — there is no build step.

---

## 8. Operational checks

| Check                | How                                                      |
| -------------------- | -------------------------------------------------------- |
| Backend health       | `curl http://localhost:8765/`                            |
| Active project       | `curl http://localhost:8765/status`                      |
| Provider reachable   | Manually open each provider URL in a logged-in tab       |
| WS live              | Green dot in the IDE panel topbar                        |
| Approvals queue      | "Approvals" tab in panel                                 |
| Past rejections      | "Rejections" tab — Forgive / Forgive all                 |
| Test runner          | "Run tests" button in topbar                             |
| Auto-fix loop        | Toggle "Auto-fix on failure" (cap = 3 iterations)        |
| Git history          | "Git" tab — commit log, tags, rollback, inline diff      |

---

## 9. Security & safety notes

- The backend listens **only on `127.0.0.1`** by default. Never expose port
  8765 to a public network.
- All filesystem writes are confined to the active project directory via
  `backend/security.py` (path-traversal protection, allow-list memory files).
- Every `write_file` and `execute_command` step requires explicit human
  approval in the **Approvals** tab unless **Auto-approve** is checked
  (use with care; intended for sandboxed VMs).
- Rejected actions are remembered for 30 days and become **planning
  constraints** so the agent learns to avoid them. Use **Forgive** in the
  Rejections tab to lift a constraint.
- The auto-fix loop is hard-capped at 3 iterations and tags successful
  outcomes as `agent-autofix-<timestamp>` so every fix is one-click revertable
  from the Git tab.

---

## 10. Troubleshooting

| Symptom                                       | Likely cause / fix                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `WS` dot stays red                            | Backend not running, wrong port, or browser blocking `ws://localhost`              |
| Extension fails to import adapters            | `manifest.json` `web_accessible_resources` missing — ensure `adapters/*.js`, `core/*.js`, `config.json` are listed (already configured in repo) |
| AI provider returns nothing                   | Re-login to the provider in the same browser profile; provider may have changed DOM — update its file under `extension/adapters/` |
| `tests not detected`                          | Add `.agent-test-config.json` with a `command` field at project root               |
| `git log unavailable`                         | Project directory is not a git repo — click **Commit current state** in the Git tab to initialize |
| `port 8765 already in use`                    | Stop the other process or change the port in both uvicorn launch and `extension/config.json` |
| Auto-fix loop runs forever                    | It cannot — capped at 3 iterations; cancel mid-flight via the Stop button or `AGENT_AUTOFIX_CANCEL` |

---

## 11. Uninstall

1. `chrome://extensions` → **Remove** the extension.
2. Stop the backend service (`systemctl --user stop ai-agent` or kill uvicorn).
3. Delete the cloned directory.
4. (Optional) Revoke any third-party cookies for the AI providers.
