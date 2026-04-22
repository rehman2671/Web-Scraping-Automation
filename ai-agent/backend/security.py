import os
import shlex
from pathlib import Path
from typing import List, Tuple

ALLOWED_BINARIES = {
    "npm", "npx", "node", "yarn", "pnpm",
    "python", "python3", "pip", "pip3", "pytest", "uv",
    "git",
    "cargo", "rustc",
    "go",
    "mvn", "gradle",
    "java",
    "make",
    "ls", "cat", "echo", "pwd",
}

DANGEROUS_TOKENS = (
    "&&", "||", ";", "|", ">", "<", "`", "$(",
    "rm -rf", "sudo", "chmod 777", "mkfs", ":(){", "curl ", "wget ",
)

DANGEROUS_FLAGS = ("--privileged", "--no-preserve-root")


def safe_resolve(workdir: str, rel_path: str) -> Path:
    """Prevent path traversal. Always resolves under workdir."""
    base = Path(workdir).resolve()
    target = (base / rel_path).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise PermissionError(f"Path traversal blocked: {rel_path}")
    return target


def validate_command(cmd: str) -> Tuple[bool, str, List[str]]:
    if not cmd or not cmd.strip():
        return False, "Empty command", []

    lower = cmd.lower()
    for tok in DANGEROUS_TOKENS:
        if tok in lower:
            return False, f"Forbidden token: {tok}", []

    try:
        parts = shlex.split(cmd)
    except ValueError as e:
        return False, f"Bad shell syntax: {e}", []

    if not parts:
        return False, "Empty command", []

    bin_name = os.path.basename(parts[0])
    if bin_name not in ALLOWED_BINARIES:
        return False, f"Binary not allow-listed: {bin_name}", []

    for flag in DANGEROUS_FLAGS:
        if flag in parts:
            return False, f"Dangerous flag: {flag}", []

    return True, "ok", parts
