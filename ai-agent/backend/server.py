import asyncio
import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .ai_router import get_routing_config
from .file_indexer import extract_summary, index_project
from .git_manager import commit_all, init_repo, log as git_log, rollback_to
from .logger import get_logger
from .project_manager import ProjectManager
from .security import safe_resolve, validate_command
from .test_runner import run_tests
from .websocket_manager import ws_manager

log = get_logger("server")

ROOT = Path(__file__).resolve().parent.parent
PROJECTS_ROOT = ROOT / "projects"
MEMORY_DIR = ROOT / "memory"
MEMORY_DIR.mkdir(parents=True, exist_ok=True)

pm = ProjectManager(str(PROJECTS_ROOT))

app = FastAPI(title="AI Agent Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)

# ----- in-memory job state -----
STATE: Dict[str, Any] = {
    "agent_state": "IDLE",
    "current_task_id": None,
    "cancel_requested": False,
    "started_at": None,
}
RUNNING_PROCS: Dict[str, subprocess.Popen] = {}

# Captured at startup so background threads (watchdog, subprocesses) can
# schedule coroutines on the FastAPI event loop safely.
MAIN_LOOP: Optional[asyncio.AbstractEventLoop] = None


@app.on_event("startup")
async def _capture_main_loop() -> None:
    global MAIN_LOOP
    MAIN_LOOP = asyncio.get_running_loop()


def _schedule(coro) -> None:
    """Schedule a coroutine on the main loop from any thread."""
    loop = MAIN_LOOP
    if loop is None or loop.is_closed():
        return
    try:
        asyncio.run_coroutine_threadsafe(coro, loop)
    except RuntimeError:
        pass


def _set_state(s: str) -> None:
    STATE["agent_state"] = s
    _schedule(ws_manager.broadcast("status", {"state": s}))


# ============== MODELS ==============
class ProjectSelect(BaseModel):
    name: str


class FileRead(BaseModel):
    path: str


class FileWrite(BaseModel):
    path: str
    content: str
    create_dirs: bool = True


class FileList(BaseModel):
    path: Optional[str] = ""


class ExecuteCmd(BaseModel):
    cmd: str
    timeout: int = 60
    task_id: Optional[str] = None


class GitCommit(BaseModel):
    message: str = "agent commit"


class GitRollback(BaseModel):
    sha: Optional[str] = None


class MemoryWrite(BaseModel):
    file: str  # one of long_term_memory|session_memory|error_memory
    data: Any


# ============== HELPERS ==============
def _on_external_change(event_type: str, src_path: str) -> None:
    try:
        rel = str(Path(src_path).resolve().relative_to(pm.get_active()))
    except Exception:
        rel = src_path
    _schedule(ws_manager.broadcast("file_external_update", {"path": rel, "event": event_type}))


# ============== HEALTH / STATUS ==============
@app.get("/")
def root():
    return {"ok": True, "service": "ai-agent-backend", "version": "1.0.0"}


@app.get("/status")
def status():
    return {
        **STATE,
        "active_project": str(pm.active) if pm.active else None,
        "projects": pm.list_projects(),
    }


@app.get("/routing")
def routing():
    return get_routing_config()


# ============== PROJECT ==============
@app.get("/project/list")
def project_list():
    return {"projects": pm.list_projects()}


@app.post("/project/create")
def project_create(p: ProjectSelect):
    target = pm.create_project(p.name)
    return {"ok": True, "path": str(target)}


@app.post("/project/select")
def project_select(p: ProjectSelect):
    target = pm.set_active(p.name, on_change=_on_external_change)
    init_repo(target)
    return {"ok": True, "active": str(target)}


@app.get("/project/index")
def project_index():
    return index_project(pm.get_active())


@app.post("/project/summary")
def project_summary(req: FileRead):
    full = safe_resolve(str(pm.get_active()), req.path)
    if not full.exists():
        raise HTTPException(404, "not found")
    return extract_summary(full)


# ============== FILE OPS ==============
@app.post("/read_file")
def read_file(req: FileRead):
    full = safe_resolve(str(pm.get_active()), req.path)
    if not full.exists() or not full.is_file():
        raise HTTPException(404, "not found")
    try:
        content = full.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise HTTPException(400, "binary file")
    return {"path": req.path, "content": content, "size": full.stat().st_size}


@app.post("/write_file")
async def write_file(req: FileWrite):
    full = safe_resolve(str(pm.get_active()), req.path)
    if req.create_dirs:
        full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(req.content, encoding="utf-8")
    await ws_manager.broadcast("file_written", {"path": req.path, "size": len(req.content)})
    return {"ok": True, "path": req.path, "size": len(req.content)}


@app.post("/list_files")
def list_files(req: FileList):
    base = pm.get_active()
    target = safe_resolve(str(base), req.path or "")
    if not target.exists():
        raise HTTPException(404, "not found")
    entries = []
    for c in sorted(target.iterdir()):
        try:
            entries.append({
                "name": c.name,
                "is_dir": c.is_dir(),
                "size": c.stat().st_size if c.is_file() else 0,
            })
        except OSError:
            continue
    return {"path": req.path or "", "entries": entries}


# ============== EXECUTE ==============
@app.post("/execute")
async def execute(req: ExecuteCmd):
    ok, msg, _parts = validate_command(req.cmd)
    if not ok:
        await ws_manager.broadcast("error", {"source": "execute", "message": msg, "cmd": req.cmd})
        raise HTTPException(400, msg)

    cwd = pm.get_active()
    task_id = req.task_id or uuid.uuid4().hex[:8]
    STATE["current_task_id"] = task_id
    STATE["cancel_requested"] = False
    _set_state("EXECUTING")

    await ws_manager.broadcast("command_started", {"task_id": task_id, "cmd": req.cmd})

    proc = subprocess.Popen(
        req.cmd,
        shell=True,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    RUNNING_PROCS[task_id] = proc

    output_lines = []
    start = time.time()

    try:
        while True:
            if STATE.get("cancel_requested"):
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                await ws_manager.broadcast("command_output", {"task_id": task_id, "line": "[CANCELLED]"})
                break
            if time.time() - start > req.timeout:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                await ws_manager.broadcast("command_output", {"task_id": task_id, "line": "[TIMEOUT]"})
                break
            line = proc.stdout.readline()
            if not line:
                if proc.poll() is not None:
                    break
                await asyncio.sleep(0.05)
                continue
            output_lines.append(line.rstrip("\n"))
            await ws_manager.broadcast("command_output", {"task_id": task_id, "line": line.rstrip("\n")})
    finally:
        RUNNING_PROCS.pop(task_id, None)
        _set_state("IDLE")

    code = proc.returncode if proc.returncode is not None else -1
    await ws_manager.broadcast("command_finished", {"task_id": task_id, "code": code})
    return {"ok": code == 0, "code": code, "task_id": task_id, "output": "\n".join(output_lines)[-50000:]}


@app.post("/cancel")
async def cancel():
    STATE["cancel_requested"] = True
    killed = []
    for tid, proc in list(RUNNING_PROCS.items()):
        try:
            proc.terminate()
            killed.append(tid)
        except Exception:
            pass
    await ws_manager.broadcast("status", {"state": "PAUSED", "cancelled": killed})
    return {"ok": True, "cancelled": killed}


# ============== TESTS ==============
@app.post("/run_tests")
async def run_tests_endpoint():
    cwd = pm.get_active()
    _set_state("EXECUTING")
    result = await asyncio.get_event_loop().run_in_executor(None, lambda: run_tests(cwd))
    _set_state("IDLE")
    await ws_manager.broadcast("test_result", result)
    return result


# ============== GIT ==============
@app.post("/git/commit")
async def git_commit(req: GitCommit):
    ok, info = commit_all(pm.get_active(), req.message)
    await ws_manager.broadcast("git", {"action": "commit", "ok": ok, "info": info})
    if not ok:
        raise HTTPException(500, info)
    return {"ok": True, "sha": info}


@app.post("/git/rollback")
async def git_rollback(req: GitRollback):
    ok, info = rollback_to(pm.get_active(), req.sha)
    await ws_manager.broadcast("git", {"action": "rollback", "ok": ok, "info": info})
    if not ok:
        raise HTTPException(500, info)
    return {"ok": True, "info": info}


@app.get("/git/log")
def git_log_endpoint(n: int = 20):
    ok, info = git_log(pm.get_active(), n)
    if not ok:
        raise HTTPException(500, info)
    return {"ok": True, "log": info}


# ============== MEMORY ==============
ALLOWED_MEMORY = {"long_term_memory", "session_memory", "error_memory", "approval_history"}


@app.get("/memory/{name}")
def memory_get(name: str):
    if name not in ALLOWED_MEMORY:
        raise HTTPException(400, "invalid memory file")
    f = MEMORY_DIR / f"{name}.json"
    if not f.exists():
        return {"data": None}
    try:
        return {"data": json.loads(f.read_text(encoding="utf-8"))}
    except Exception:
        return {"data": None}


@app.post("/memory/save")
def memory_save(req: MemoryWrite):
    if req.file not in ALLOWED_MEMORY:
        raise HTTPException(400, "invalid memory file")
    f = MEMORY_DIR / f"{req.file}.json"
    f.write_text(json.dumps(req.data, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"ok": True}


# ============== STATE ==============
@app.post("/state/{new_state}")
async def set_state(new_state: str):
    valid = {"IDLE", "PLANNING", "EXECUTING", "WAITING_APPROVAL", "FIXING", "PAUSED", "DONE", "FAILED"}
    if new_state not in valid:
        raise HTTPException(400, "invalid state")
    STATE["agent_state"] = new_state
    await ws_manager.broadcast("status", {"state": new_state})
    return {"ok": True, "state": new_state}


# ============== WEBSOCKET ==============
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws_manager.connect(ws)
    try:
        await ws_manager.broadcast("status", {"state": STATE["agent_state"]})
        while True:
            msg = await ws.receive_text()
            try:
                data = json.loads(msg)
            except Exception:
                data = {"type": "ping", "raw": msg}
            # echo / log inbound
            await ws_manager.broadcast("log", {"source": "ws_in", "data": data})
    except WebSocketDisconnect:
        await ws_manager.disconnect(ws)
    except Exception as e:
        log.warning(f"ws error: {e}")
        await ws_manager.disconnect(ws)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.server:app", host="127.0.0.1", port=8765, reload=False)
