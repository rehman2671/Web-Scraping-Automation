"""
Routing matrix used by the extension. The backend just exposes the configuration;
actual prompt dispatch happens in the browser via content scripts (no API mode).
"""
from typing import Dict, List

ROUTES: Dict[str, str] = {
    "planning": "chatgpt",
    "coding": "deepseek",
    "debugging": "qwen",
    "long_context": "gemini",
}

FALLBACK_ORDER: List[str] = ["deepseek", "chatgpt", "gemini", "qwen"]

MODEL_LIMITS: Dict[str, int] = {
    "chatgpt": 8000,
    "deepseek": 8000,
    "qwen": 8000,
    "gemini": 32000,
}


def get_routing_config() -> Dict:
    return {
        "routes": ROUTES,
        "fallback": FALLBACK_ORDER,
        "limits": MODEL_LIMITS,
    }
