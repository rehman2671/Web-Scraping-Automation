import os
import re
from pathlib import Path
from typing import Dict, List

IGNORED = {"node_modules", "dist", "build", ".git", "__pycache__", ".venv", "venv", ".next"}

LANG_BY_EXT = {
    ".py": "python", ".js": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".tsx": "typescript",
    ".rs": "rust", ".go": "go", ".java": "java",
    ".rb": "ruby", ".php": "php", ".c": "c", ".cpp": "cpp",
    ".html": "html", ".css": "css", ".json": "json", ".md": "markdown",
}

PY_IMPORT = re.compile(r"^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))", re.MULTILINE)
JS_IMPORT = re.compile(r"""^\s*(?:import\s+.*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\))""", re.MULTILINE)
PY_DEF = re.compile(r"^\s*(?:def|class)\s+(\w+)", re.MULTILINE)
JS_DEF = re.compile(r"^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)", re.MULTILINE)


def index_project(root: Path, max_files: int = 5000) -> Dict:
    files: List[Dict] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORED]
        for f in filenames:
            full = Path(dirpath) / f
            try:
                rel = str(full.relative_to(root))
            except ValueError:
                continue
            ext = full.suffix.lower()
            try:
                size = full.stat().st_size
            except OSError:
                continue
            files.append({
                "path": rel,
                "size": size,
                "language": LANG_BY_EXT.get(ext, "other"),
            })
            if len(files) >= max_files:
                break
        if len(files) >= max_files:
            break
    return {"root": str(root), "count": len(files), "files": files}


def extract_summary(path: Path, max_bytes: int = 60_000) -> Dict:
    try:
        if path.stat().st_size > max_bytes:
            return {"path": str(path), "imports": [], "symbols": [], "truncated": True}
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return {"path": str(path), "imports": [], "symbols": [], "error": "unreadable"}

    ext = path.suffix.lower()
    imports: List[str] = []
    symbols: List[str] = []
    if ext == ".py":
        for m in PY_IMPORT.finditer(text):
            imports.append(m.group(1) or m.group(2))
        symbols = PY_DEF.findall(text)
    elif ext in (".js", ".jsx", ".ts", ".tsx"):
        for m in JS_IMPORT.finditer(text):
            imports.append(m.group(1) or m.group(2))
        symbols = JS_DEF.findall(text)

    return {
        "path": str(path),
        "imports": imports[:200],
        "symbols": symbols[:200],
        "lines": text.count("\n") + 1,
    }
