# Browser-Based Multi-AI Autonomous Coding Agent (NO API MODE)

A simplified Cursor / Devin / Windsurf–style autonomous coding agent that uses
the **web UIs** of ChatGPT, DeepSeek, Qwen and Gemini through a Chrome
extension, paired with a **local FastAPI backend** that owns the file system,
shell, tests, and git. No API keys are required.

```
Chrome Extension  ⇄  Local FastAPI Backend  ⇄  OS / FS / Terminal
```

## Project layout

```
ai-agent/
├── extension/        Chrome MV3 extension (content scripts + adapters + IDE panel)
├── backend/          FastAPI server (port 8765)
├── memory/           Persisted long-term, session, and error memory
├── logs/             Backend log files (rotated)
├── projects/         Working projects the agent operates on
└── README.md
```

## 1. Install & run the backend

```bash
cd ai-agent/backend
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# from the ai-agent/ directory (the parent), so the package import works:
cd ..
python -m uvicorn backend.server:app --host 127.0.0.1 --port 8765
```

Verify: `curl http://127.0.0.1:8765/` should return `{"ok": true, ...}`.

## 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select `ai-agent/extension/`.
4. Pin the extension. Click its icon to open the popup.
5. In the popup, type a project name and click **+** to create it. Select it.
6. Click **Open IDE Panel** for the full IDE-style view.

## 3. Log in to the AI providers

In normal Chrome tabs, log in to the providers you want to use:

- https://chatgpt.com
- https://chat.deepseek.com
- https://gemini.google.com/app
- https://chat.qwen.ai

Keep these tabs open. The extension reuses your existing browser sessions —
it never asks for API keys.

## 4. Start the agent

1. In the popup, type a goal: e.g. *"Create a Python script that prints fizzbuzz"*.
2. Click **Start**.
3. The background service worker:
   - sends the planning prompt to the routed provider (ChatGPT by default),
   - parses the JSON plan,
   - executes each step against the backend,
   - streams logs/diffs/progress over WebSocket to the IDE panel.

## 5. IDE panel features

- **File explorer** — browse the active project; click a file to load it into the diff viewer.
- **Chat** — free-form prompts dispatched through the routing matrix.
- **Plan** — live view of the generated plan + task tree.
- **Diff viewer** — unified or side-by-side; approve writes per file.
- **Logs** — INFO / DEBUG / WARN / ERROR filters, tailing in real time.
- **Controls** — Pause / Resume / Stop.

## Routing matrix (configurable in `extension/config.json`)

| Task        | Default provider |
|-------------|------------------|
| planning    | ChatGPT          |
| coding      | DeepSeek         |
| debugging   | Qwen             |
| long context| Gemini           |

Fallback order: `deepseek → chatgpt → gemini → qwen`.

## Backend endpoints

```
GET  /                  health
GET  /status            agent state + active project + projects list
GET  /routing           current routing matrix

GET  /project/list
POST /project/create     {name}
POST /project/select     {name}
GET  /project/index
POST /project/summary    {path}

POST /read_file          {path}
POST /write_file         {path, content, create_dirs}
POST /list_files         {path}

POST /execute            {cmd, timeout, task_id}
POST /cancel
POST /run_tests

POST /git/commit         {message}
POST /git/rollback       {sha?}
GET  /git/log?n=20

GET  /memory/{long_term_memory|session_memory|error_memory}
POST /memory/save        {file, data}

POST /state/{NEW_STATE}
WS   /ws                 push channel
```

WebSocket message schema:

```json
{ "type": "log|progress|diff|status|error|command_output|file_external_update",
  "payload": {}, "timestamp": 0 }
```

## Security

- Shell commands are passed through `backend/security.py`'s allow-list:
  `npm, npx, node, yarn, pnpm, python, pip, pytest, git, cargo, go, mvn, gradle, java, make, ls, cat, echo, pwd`.
- Forbidden: `&&`, `||`, `;`, `|`, redirections, backticks, `$()`, `sudo`,
  `rm -rf`, `mkfs`, `--privileged`, `--no-preserve-root`, etc.
- All file operations are resolved against the active project root with
  traversal protection; paths escaping the project root are rejected.
- Default per-command timeout is 60 seconds.

## File watcher

`watchdog` watches the active project recursively (excluding `node_modules`,
`dist`, `build`, `.git`, etc.) and emits `file_external_update` over WebSocket
whenever a file changes outside the agent — so the IDE panel stays in sync.

## Crash recovery

- Background service worker checkpoints `STATE` to `chrome.storage.local`
  every 5 seconds, plus mirrors session memory to `memory/session_memory.json`
  on the backend.
- On startup, the snapshot is restored.

## Testing engine

`POST /run_tests` auto-detects the framework:

| File present                | Command         |
|-----------------------------|-----------------|
| `package.json`              | `npm test`      |
| `pytest.ini` / `pyproject.toml` / `test_*.py` | `pytest -q` |
| `Cargo.toml`                | `cargo test`    |
| `go.mod`                    | `go test ./...` |
| `pom.xml`                   | `mvn -q test`   |
| `build.gradle[.kts]`        | `gradle test`   |

You can override per-project by adding `.agent-test-config.json`:

```json
{ "command": "make test", "framework": "make" }
```

The test runner parses pytest/jest-style failures and stack traces and pushes a
`test_result` event over the WebSocket.

## Troubleshooting

**Extension popup says "BACKEND OFFLINE"**
Make sure `python -m uvicorn backend.server:app --port 8765` is running
and that http://127.0.0.1:8765/ responds.

**Provider says "not logged in" or "captcha detected"**
Open the provider URL in a normal tab, complete the login / captcha, then
retry. The agent will automatically fall back to the next provider in the
fallback order.

**Selectors stopped matching (provider redesigned the page)**
Update the relevant adapter under `extension/adapters/<provider>.js`. Each
adapter exposes a `selectors` map with arrays of CSS / aria-label / data-testid
options — add new ones to the front of each array. Then reload the extension
in `chrome://extensions`.

**`InputEvent` does not register for a contenteditable provider**
The base adapter falls back through three strategies in order:
1. clipboard paste (`navigator.clipboard.writeText` + `execCommand("paste")`)
2. `execCommand("insertText")` for contenteditable
3. native value setter + `InputEvent` for textareas

Tweak `extension/content.js` `_typeIntoInput` if needed.

## Selector-update guide

Each adapter under `extension/adapters/` has the same shape:

```js
this.selectors = {
  input:        [ /* CSS, aria-label, data-testid options */ ],
  sendButton:   [ /* ... */ ],
  responseContainer: [ /* ... */ ],
  lastResponse: [ /* ... */ ],
  spinner:      [ /* ... */ ],
  loginIndicator: [ /* ... */ ],
  captcha:      [ /* ... */ ],
  rateLimit:    [ /* ... */ ],
};
```

Keep the most specific / current selectors at the top; the helper
`findFirst()` returns the first match.

## Contributing

PRs welcome. Style:

- Backend: PEP 8, type hints where reasonable, no global state outside `STATE`.
- Extension: ES modules, no bundler required, no external runtime deps.

## Security warnings

- This agent **executes shell commands** in the active project directory.
  Only run it on projects you trust, in a user account that does not have
  privileged write access to the rest of your system.
- The Chrome extension talks to `localhost:8765` over plain HTTP. Do not expose
  this port to your network. Bind to `127.0.0.1` (the default) and run behind a
  user-only firewall.
- The extension automates third-party AI websites. This may violate those
  sites' Terms of Service. Use at your own risk.
