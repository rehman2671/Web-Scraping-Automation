import json
import re
import subprocess
from pathlib import Path
from typing import Dict, Tuple


def detect_test_command(cwd: Path) -> Tuple[str, str]:
    """Returns (cmd, framework). Honors .agent-test-config.json first."""
    cfg = cwd / ".agent-test-config.json"
    if cfg.exists():
        try:
            data = json.loads(cfg.read_text(encoding="utf-8"))
            if "command" in data:
                return data["command"], data.get("framework", "custom")
        except Exception:
            pass
    if (cwd / "package.json").exists():
        return "npm test --silent", "node"
    if (cwd / "pytest.ini").exists() or (cwd / "pyproject.toml").exists() or any(cwd.glob("test_*.py")):
        return "pytest -q", "python"
    if (cwd / "Cargo.toml").exists():
        return "cargo test --quiet", "rust"
    if (cwd / "go.mod").exists():
        return "go test ./...", "go"
    if (cwd / "pom.xml").exists():
        return "mvn -q test", "maven"
    if (cwd / "build.gradle").exists() or (cwd / "build.gradle.kts").exists():
        return "gradle test --quiet", "gradle"
    return "", "unknown"


PY_FAIL = re.compile(r"FAILED\s+(\S+)::(\S+)")
NODE_FAIL = re.compile(r"\bFAIL\b\s+(\S+)")
TRACE_LINE = re.compile(r'^\s*(?:File\s+"([^"]+)",\s+line\s+(\d+)|at\s+\S+\s+\(([^)]+):(\d+)|\s*([^\s]+\.\w+):(\d+))')


def parse_failures(output: str) -> Dict:
    failures = []
    for m in PY_FAIL.finditer(output):
        failures.append({"file": m.group(1), "test": m.group(2), "framework": "pytest"})
    for m in NODE_FAIL.finditer(output):
        failures.append({"file": m.group(1), "framework": "jest/mocha"})
    traces = []
    for line in output.splitlines():
        m = TRACE_LINE.search(line)
        if m:
            traces.append(line.strip())
    return {"failures": failures, "trace": traces[:50]}


def run_tests(cwd: Path, timeout: int = 120) -> Dict:
    cmd, framework = detect_test_command(cwd)
    if not cmd:
        return {"ok": False, "framework": framework, "stdout": "", "stderr": "no test framework detected", "code": -1, "failures": [], "trace": []}
    try:
        proc = subprocess.run(cmd, cwd=str(cwd), shell=True, capture_output=True, text=True, timeout=timeout)
        out = proc.stdout
        err = proc.stderr
        parsed = parse_failures(out + "\n" + err)
        return {
            "ok": proc.returncode == 0,
            "framework": framework,
            "code": proc.returncode,
            "stdout": out[-20000:],
            "stderr": err[-20000:],
            **parsed,
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "framework": framework, "code": -1, "stdout": "", "stderr": "timeout", "failures": [], "trace": []}
