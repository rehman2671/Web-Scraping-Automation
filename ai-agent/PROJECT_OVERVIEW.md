# AI Autonomous Coding Agent — Complete Project Overview

A **browser-based, multi-AI autonomous coding agent** in the spirit of Cursor /
Devin, but with a critical difference: it consumes **no AI API keys**. Instead,
a Chrome MV3 extension drives the official ChatGPT, DeepSeek, Qwen, and Gemini
**web UIs** inside your own logged-in browser session, while a local FastAPI
backend owns the filesystem, shell, tests, and git for the active project.

---

## 1. High-level architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                         Chrome MV3 Extension                          │
│                                                                       │
│  popup.html ──┐                                                       │
│               │                                                       │
│   IDE panel (panel.html) ◀── chat / plan / diff / approvals / git     │
│               ▲                                                       │
│               │ chrome.runtime messaging                              │
│   background.js  (service worker, state machine, agent loop)          │
│      │     │                                                          │
│      │     └────── content.js → adapters/{chatgpt,deepseek,qwen,gemini}│
│      │            (DOM scrapers in provider tabs — NO API keys)       │
│      ▼                                                                │
│   HTTP + WebSocket on http://localhost:8765                           │
└──────┬────────────────────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────────────────────┐
│   FastAPI backend (uvicorn, port 8765, loopback only)                 │
│                                                                       │
│   server.py     REST + /ws WebSocket                                  │
│   security.py   path-traversal guard, command allow-list              │
│   project_mgr   active project, file watcher (watchdog)               │
│   file_indexer  tree + summaries                                      │
│   git_manager   init / commit / rollback / tag / show                 │
│   test_runner   auto-detect pytest|npm|cargo|go|mvn|gradle            │
│   ai_router     routing matrix config                                 │
│   logger        structured JSON logs                                  │
│                                                                       │
│   ./memory/  ── long_term, session, error, approval_history (JSON)    │
└───────────────────────────────────────────────────────────────────────┘
```

**Key design points**

- Browser session ≡ AI auth. Re-using your logged-in cookies removes the API
  cost and keeps you on each provider's normal usage limits.
- The backend is the only component that touches the filesystem or runs
  shell commands.
- The extension is the only component that talks to the AI providers.
- Communication is JSON over HTTP and a single WebSocket for live events.

---

## 2. Directory map

```
ai-agent/
├── backend/
│   ├── server.py              FastAPI app, all REST + /ws routes
│   ├── ai_router.py           returns routing matrix to the extension
│   ├── security.py            safe_resolve(), validate_command()
│   ├── project_manager.py     active-project lifecycle, watchdog hooks
│   ├── file_indexer.py        index_project(), extract_summary()
│   ├── git_manager.py         init/commit/rollback/tag/show/log
│   ├── test_runner.py         detect_test_command(), parse_failures()
│   ├── websocket_manager.py   pub-sub broadcast hub
│   ├── logger.py              structured logger + tail buffer
│   └── requirements.txt
├── extension/
│   ├── manifest.json          MV3 config, permissions, host_permissions
│   ├── background.js          service worker — agent loop, routing, queue
│   ├── content.js             entry into provider pages, dynamic adapters
│   ├── popup.html / popup.js  pick project, open IDE panel
│   ├── config.json            backend URL, ws URL, routing matrix
│   ├── adapters/
│   │   ├── baseAdapter.js
│   │   ├── chatgpt.js
│   │   ├── deepseek.js
│   │   ├── qwen.js
│   │   └── gemini.js
│   ├── core/
│   │   ├── agentLoop.js       state-machine driver
│   │   ├── stateMachine.js    IDLE / PLANNING / EXECUTING / PAUSED / DONE
│   │   ├── planner.js         JSON-schema planning prompt
│   │   ├── executor.js        per-step dispatcher
│   │   ├── parser.js          robust JSON extraction from chat replies
│   │   ├── router.js          task-kind → provider routing + fallback
│   │   ├── memory.js          long-term / session / error
│   │   ├── contextEngine.js   builds prompt context from index + memory
│   │   ├── tokenManager.js    rough token budgeting
│   │   ├── toolRegistry.js    list of allowed actions
│   │   ├── diffViewer.js      unified + side-by-side renderer
│   │   ├── logger.js          panel-side log subscriber
│   │   └── websocket.js       reconnection helper
│   └── ui/
│       ├── panel.html         IDE-style layout
│       ├── panel.js           tabs, approvals, git, autofix UI
│       └── styles.css         dark theme
└── memory/                    runtime JSON files
```

---

## 3. End-to-end flow (one user request)

```
User types goal in chat ──▶ background.runAgentLoop()
                             │
                             ▼
                       planGoal(goal)
                             │  buildRejectionConstraints()
                             │  routedPrompt("planning")
                             ▼
                       routes to ChatGPT tab via adapters/chatgpt.js
                             │
                       ◀──── JSON plan (tasks → steps)
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
     For each step:                  Broadcast plan over WS
       - read_file
       - write_file        ──▶ requestApproval()  ──▶ Approvals tab
       - list_files                     │
       - execute_command   ──▶ requestApproval()  ──▶ Approvals tab
       - install_package               (approve / reject)
       - run_tests                      │
       - git_commit                     ▼
       - git_rollback         backend executes inside active project
                                        │
                                        ▼
                              status, logs, file_external_update,
                              command_output, test_result over WS
                                        │
                                        ▼
                          panel renders into chat / logs / files / git
```

If a step throws, the executor switches to **debugging** route → Qwen, asks
for a JSON fix step, and applies it (with approval). Failed `run_tests` may
trigger the **auto-fix loop** (§5.7).

---

## 4. Routing matrix (no-API mode)

| Task kind        | Primary provider | Fallback        | Why                          |
| ---------------- | ---------------- | --------------- | ---------------------------- |
| `planning`       | ChatGPT          | Gemini          | strong structured output     |
| `coding`         | DeepSeek         | ChatGPT         | strong code generation       |
| `debugging`      | Qwen             | DeepSeek        | good at stack-trace reasoning|
| `long_context`   | Gemini           | ChatGPT         | large context window         |

Defined in `extension/config.json` and loaded by `core/router.js`. If a tab
is missing or the provider fails, the router automatically retries the
fallback. Adding a new provider = new file under `adapters/` + entry in
`config.json`.

---

## 5. Feature catalogue

### 5.1 Multi-AI orchestration (no API keys)
- 4 first-class providers via DOM adapters.
- Per-task-kind routing with automatic fallback on adapter failure.
- Each adapter exposes the same contract: `sendPrompt(text)` →
  `Promise<{text}>`.

### 5.2 Local FastAPI backend
- REST + WebSocket on `127.0.0.1:8765` (loopback only).
- Single active project; everything is scoped to it.
- File watcher (`watchdog`) broadcasts external edits to the panel.

### 5.3 Active project management
- `POST /projects/active` — set the working directory.
- `GET /status` — current state + active project.
- `GET /list_files`, `POST /read_file`, `POST /write_file` (with safety).

### 5.4 Security & safety
- Path traversal guard (`safe_resolve`) — every write/read is reanchored to
  the active project root.
- Command allow-list / deny patterns (`validate_command`) — destructive ops
  blocked unless explicitly allowed.
- Memory file allow-list (`long_term_memory`, `session_memory`,
  `error_memory`, `approval_history`) — nothing else can be written via the
  memory endpoint.

### 5.5 Approval workflow
- Every `write_file` and `execute_command` step pauses the agent and surfaces
  an **approval card** in the panel.
- Side-by-side / unified diff for writes; literal command preview for shell.
- Approval keys:
  - writes → `write:<path>:<sha256(content)[:16]>`
  - commands → `cmd:<trimmed cmd>`
- Decisions persisted in `memory/approval_history.json` (capped at 500).
- Approvals queue **survives panel reload** — background keeps full payloads
  and the panel rehydrates pending cards on open.
- "Auto-approve all" toggle for sandboxed environments.

### 5.6 Rejection learning loop
- Past rejections (last 30 days, latest decision per key wins) are pulled by
  `buildRejectionConstraints()` and appended as a `CONSTRAINTS:` block to the
  planning prompt — the agent learns to avoid previously rejected paths and
  commands.
- "Rejections" tab lists active constraints with **Forgive** (per entry) and
  **Forgive all**. Re-approving an action also overrides the prior reject.

### 5.7 Test runner & auto-fix
- **Run tests** button auto-detects: `pytest`, `npm test`, `cargo test`,
  `go test`, `mvn test`, `gradle test`, or a custom command from
  `.agent-test-config.json`.
- Output parsed for failures, test paths, stack traces.
- **Auto-fix on failure** toggle: failures + traces are routed to the
  debugging model with a "minimal, surgical edit" instruction; final step is
  always `run_tests` again to verify.
- Hard cap of **3 iterations** per session; on success a git tag
  `agent-autofix-<sessionId>` is created so the fix is one-click revertable.
- `AGENT_AUTOFIX_CANCEL` to abort mid-flight.

### 5.8 Git integration
- `init_repo`, `commit_all`, `rollback_to`, `tag_commit`, `show_commit`,
  decorated `log`.
- **Git tab** in the panel:
  - Commit log with tag badges (autofix tags green, HEAD blue).
  - One-click rollback per autofix tag, or rollback to any commit's SHA.
  - "Commit current state" with custom message.
  - **Show diff** per commit — fetches `git show --stat -p` and renders
    inline with GitHub-like coloring (additions green, deletions red, hunks
    blue, headers purple).
  - "Only show agent-autofix tags" filter for safe revert points.

### 5.9 IDE-style panel UI
- Files sidebar with click-to-open in diff viewer.
- Tabs: **Chat / Plan / Diff / Approvals / Rejections / Git**.
- Logs sidebar with level filters (INFO / WARN / ERROR).
- Topbar: state indicator, WS dot, **Run tests**, **Auto-fix on failure**,
  Pause / Resume / Stop.

### 5.10 State machine
- States: `IDLE → PLANNING → EXECUTING → PAUSED → DONE`.
- Pause / Resume / Stop are first-class; `STATE.cancel` short-circuits the
  loop. Server mirrors via `/state/{name}`.

### 5.11 Memory tiers
| Tier              | Use                                                       |
| ----------------- | --------------------------------------------------------- |
| `long_term`       | facts that survive across projects                        |
| `session`         | active project, current cursor, last plan                 |
| `error`           | recent errors and recovery hints                          |
| `approval_history`| approve/reject decisions feeding the rejection planner    |

### 5.12 Structured logging & WebSocket events
Event types pushed over `/ws`:
`status`, `ws_status`, `plan`, `log`, `error`, `command_started`,
`command_output`, `command_finished`, `approval_request`,
`approval_resolved`, `file_external_update`, `file_written`, `test_result`,
`git`.

---

## 6. Function reference

### 6.1 Backend (`ai-agent/backend/`)

| Module             | Function                              | Purpose                                         |
| ------------------ | ------------------------------------- | ----------------------------------------------- |
| `server.py`        | `_schedule(coro)`                     | Thread-safe broadcast from watchdog threads     |
|                    | `read_file_endpoint`                  | `POST /read_file`                               |
|                    | `write_file_endpoint`                 | `POST /write_file` (path-safe)                  |
|                    | `list_files_endpoint`                 | `POST /list_files`                              |
|                    | `execute_endpoint`                    | `POST /execute` (allow-listed cmds)             |
|                    | `cancel_endpoint`                     | `POST /cancel` (kills running cmd)              |
|                    | `run_tests_endpoint`                  | `POST /run_tests`                               |
|                    | `git_commit / rollback / tag / show / log` | full git surface                          |
|                    | `memory_save / load`                  | allow-listed JSON memory                        |
|                    | `ws_endpoint`                         | `/ws` WebSocket                                 |
| `security.py`      | `safe_resolve(root, rel)`             | path-traversal-safe resolve                     |
|                    | `validate_command(cmd)`               | allow / deny rules                              |
| `project_manager.py`| `set_active(path)` / `get_active()`  | active project                                  |
|                    | watchdog observer setup                | broadcasts external edits                       |
| `file_indexer.py`  | `index_project(root)`                 | file tree + summaries                           |
|                    | `extract_summary(path)`               | per-file headline                               |
| `git_manager.py`   | `init_repo / commit_all / rollback_to` | repo bootstrap + commits                       |
|                    | `tag_commit(name, message)`           | annotated tag                                   |
|                    | `show_commit(sha)`                    | `git show --stat -p` (validated ref)            |
|                    | `log(n)`                              | decorated `git log --oneline`                   |
| `test_runner.py`   | `detect_test_command(cwd)`            | framework auto-detect + override                |
|                    | `parse_failures(out)`                 | extracts failed tests + stack traces            |
|                    | `run_tests(cwd, timeout=120)`         | runs and returns structured result              |
| `websocket_manager.py` | `WSManager.broadcast(type, payload)` | fan-out to all clients                       |
| `logger.py`        | `get_logger(name)`                    | structured JSON logging                         |

### 6.2 Extension — background (`extension/background.js`)

| Function                    | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `connectWS()`               | Backend WebSocket with auto-reconnect + autofix hook     |
| `broadcast(type, payload)`  | Sends to all panel listeners                             |
| `loadConfig()`              | Reads `config.json` (URLs, routing)                      |
| `routedPrompt(kind, text)`  | Picks adapter from routing matrix; fallback on failure   |
| `planGoal(goal)`            | Adds rejection constraints, returns parsed plan          |
| `buildRejectionConstraints()` | 30-day rejection window → planning constraints         |
| `requestApproval(kind, step)` | Pushes approval card; resolves on user decision        |
| `approvalKey(...)`          | sha256-keyed identity for content/command                |
| `findPriorDecisions(key)`   | "Seen before — approved Nx / rejected Mx"                |
| `executeStep(step)`         | Dispatches one plan step to backend                      |
| `runAgentLoop()`            | Drives state machine across the plan                     |
| `startAutofixIteration(r)`  | Builds fix-focused goal and re-enters the loop           |
| `handleAutofixTestResult(r)` | On test_result: tag on success, retry / cap on fail     |
| `autofixReset()`            | Clears autofix state                                     |
| message handlers            | `AGENT_START / PAUSE / RESUME / STOP / GET_STATE`        |
|                             | `AGENT_APPROVAL_RESPONSE / LIST_APPROVALS`               |
|                             | `AGENT_AUTOFIX_TESTS / AGENT_AUTOFIX_CANCEL`             |
|                             | `AGENT_RUN_PROMPT`                                       |

### 6.3 Extension — panel (`extension/ui/panel.js`)

| Function                  | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `appendChat(text, kind, html?)` | Chat log writer (text or sanitized HTML)     |
| `appendLog(entry)`        | Logs sidebar with level filtering                  |
| `refreshFiles(path)`      | Files tree                                         |
| `renderDiff()`            | Unified / side-by-side render of `CURRENT_DIFF`    |
| `renderPlan(plan)`        | Plan tab                                           |
| `addApproval / renderApprovals` | Approvals tab cards + actions               |
| `restorePendingApprovals()` | Rehydrates Approvals on panel open               |
| `loadRejectionHistory / activeRejections / renderRejections` | Rejections tab |
| `renderGit / parseGitLog / toggleCommitDiff / colorizeUnifiedDiff` | Git tab |
| `doRollback(ref)`         | Confirm + `/git/rollback`                          |
| `switchTab(name)`         | Tab visibility                                     |

### 6.4 Adapters (`extension/adapters/`)

Each adapter implements:

- `init(document)`
- `async sendPrompt(text)` → `{ text }`
- DOM selectors per provider; designed to be swap-out targets when a provider
  ships a UI change.

---

## 7. Configuration files

### `extension/config.json`
```json
{
  "backendUrl": "http://localhost:8765",
  "wsUrl": "ws://localhost:8765/ws",
  "loop": { "maxRetries": 2 },
  "routing": {
    "planning":     { "primary": "chatgpt",  "fallback": "gemini"   },
    "coding":       { "primary": "deepseek", "fallback": "chatgpt"  },
    "debugging":    { "primary": "qwen",     "fallback": "deepseek" },
    "long_context": { "primary": "gemini",   "fallback": "chatgpt"  }
  }
}
```

### `<project>/.agent-test-config.json` (optional, per project)
```json
{ "framework": "custom", "command": "make test" }
```

---

## 8. Permissions used by the extension

`storage`, `tabs`, `scripting`, `activeTab`, `webNavigation`,
`clipboardRead`, `clipboardWrite`.

Host permissions limited to: `chat.openai.com`, `chatgpt.com`,
`chat.deepseek.com`, `gemini.google.com`, `chat.qwen.ai`,
`http://localhost:8765/*`, `ws://localhost:8765/*`.

`web_accessible_resources` exposes `adapters/*.js`, `core/*.js`, and
`config.json` so the content script can dynamically import them at runtime.

---

## 9. Extending the system

| You want to…                          | Touch these files                                  |
| ------------------------------------- | -------------------------------------------------- |
| Add a new AI provider                 | `extension/adapters/<new>.js`, `config.json`, `manifest.json` host_permissions |
| Add a new step action                 | `core/toolRegistry.js`, `core/executor.js`, backend endpoint, planner schema in `background.js` |
| Add a new memory tier                 | `ALLOWED_MEMORY` in `server.py`, panel UI usage    |
| Add a new test framework              | `test_runner.detect_test_command()` + `parse_failures()` |
| Tune what counts as destructive       | `security.validate_command`                        |
| Change the rejection window           | `buildRejectionConstraints()` (default 30 days)    |
| Change autofix cap                    | `AUTOFIX.max` in `background.js` (default 3)       |

---

## 10. Glossary

- **Plan** — JSON tree returned by the planner: `{goal, tasks:[{name, steps:[…]}]}`.
- **Step** — single action: `{action, path?, content?, cmd?}`.
- **Approval card** — UI element that pauses the agent until the user decides.
- **Autofix loop** — bounded re-planning loop triggered by failed `run_tests`.
- **Active project** — the only directory the backend is allowed to touch.
- **Rejection constraint** — a planner-side instruction derived from a past
  rejected approval, valid for 30 days.
