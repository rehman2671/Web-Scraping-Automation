import subprocess
from pathlib import Path
from typing import Optional, Tuple


def _run(cmd: list, cwd: Path, timeout: int = 30) -> Tuple[int, str, str]:
    p = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def is_repo(cwd: Path) -> bool:
    return (cwd / ".git").exists()


def init_repo(cwd: Path) -> Tuple[bool, str]:
    if is_repo(cwd):
        return True, "already-initialized"
    rc, out, err = _run(["git", "init"], cwd)
    if rc != 0:
        return False, err or out
    _run(["git", "config", "user.email", "agent@local"], cwd)
    _run(["git", "config", "user.name", "AI Agent"], cwd)
    return True, "initialized"


def commit_all(cwd: Path, message: str) -> Tuple[bool, str]:
    ok, info = init_repo(cwd)
    if not ok:
        return False, info
    _run(["git", "add", "-A"], cwd)
    rc, out, err = _run(["git", "commit", "-m", message, "--allow-empty"], cwd)
    if rc != 0:
        return False, err or out
    rc2, sha, _ = _run(["git", "rev-parse", "HEAD"], cwd)
    return True, sha.strip()


def rollback_to(cwd: Path, sha: Optional[str] = None) -> Tuple[bool, str]:
    if not is_repo(cwd):
        return False, "not a repo"
    target = sha or "HEAD~1"
    rc, out, err = _run(["git", "reset", "--hard", target], cwd)
    if rc != 0:
        return False, err or out
    return True, out.strip()


def tag_commit(cwd: Path, name: str, message: str = "") -> Tuple[bool, str]:
    if not is_repo(cwd):
        return False, "not a repo"
    args = ["git", "tag", "-a", name, "-m", message or name]
    rc, out, err = _run(args, cwd)
    if rc != 0:
        return False, err or out
    rc2, sha, _ = _run(["git", "rev-parse", "HEAD"], cwd)
    return True, sha.strip()


def log(cwd: Path, n: int = 20) -> Tuple[bool, str]:
    if not is_repo(cwd):
        return False, "not a repo"
    rc, out, err = _run(["git", "log", f"-n{n}", "--oneline", "--decorate=short", "--no-color"], cwd)
    if rc != 0:
        return False, err or out
    return True, out
