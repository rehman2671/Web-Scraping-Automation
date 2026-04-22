import asyncio
import json
import time
from typing import List

from fastapi import WebSocket


class WebSocketManager:
    def __init__(self) -> None:
        self.active: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self.active.append(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            if ws in self.active:
                self.active.remove(ws)

    async def broadcast(self, msg_type: str, payload: dict) -> None:
        message = json.dumps({
            "type": msg_type,
            "payload": payload,
            "timestamp": int(time.time() * 1000),
        })
        dead: List[WebSocket] = []
        async with self._lock:
            connections = list(self.active)
        for ws in connections:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for d in dead:
                    if d in self.active:
                        self.active.remove(d)


ws_manager = WebSocketManager()
