import os
import threading
from pathlib import Path
from typing import Optional

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from .logger import get_logger

log = get_logger("project_manager")

IGNORED_DIRS = {"node_modules", "dist", "build", ".git", "__pycache__", ".venv", "venv", ".next"}


def _is_ignored(path: str) -> bool:
    parts = Path(path).parts
    return any(p in IGNORED_DIRS for p in parts)


class _Handler(FileSystemEventHandler):
    def __init__(self, on_change) -> None:
        super().__init__()
        self.on_change = on_change

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        if _is_ignored(event.src_path):
            return
        try:
            self.on_change(event.event_type, event.src_path)
        except Exception as e:
            log.warning(f"watchdog callback error: {e}")


class ProjectManager:
    def __init__(self, projects_root: str) -> None:
        self.projects_root = Path(projects_root).resolve()
        self.projects_root.mkdir(parents=True, exist_ok=True)
        self.active: Optional[Path] = None
        self._observer: Optional[Observer] = None
        self._lock = threading.Lock()
        self._on_change = None

    def list_projects(self):
        return sorted([p.name for p in self.projects_root.iterdir() if p.is_dir()])

    def create_project(self, name: str) -> Path:
        target = (self.projects_root / name).resolve()
        target.relative_to(self.projects_root)
        target.mkdir(parents=True, exist_ok=True)
        return target

    def set_active(self, name: str, on_change=None) -> Path:
        target = (self.projects_root / name).resolve()
        target.relative_to(self.projects_root)
        if not target.exists():
            target.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._stop_observer()
            self.active = target
            self._on_change = on_change
            self._start_observer()
        return target

    def get_active(self) -> Path:
        if self.active is None:
            raise RuntimeError("No active project. Call /project/select first.")
        return self.active

    def _start_observer(self) -> None:
        if self.active is None or self._on_change is None:
            return
        self._observer = Observer()
        self._observer.schedule(_Handler(self._on_change), str(self.active), recursive=True)
        self._observer.daemon = True
        self._observer.start()

    def _stop_observer(self) -> None:
        if self._observer is not None:
            try:
                self._observer.stop()
                self._observer.join(timeout=2)
            except Exception:
                pass
            self._observer = None
