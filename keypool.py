"""Multi-key pool: random selection + cooldowns + dead-key tracking."""
from __future__ import annotations

import random
import threading
import time
from typing import Any, Optional

from errors import ConfigError, FatalAPIError


class KeyPool:
    """Thread-safe pool of API keys.

    * `pick()` returns a random healthy key. Keys that are cooling down are
      only returned when nothing else is available.
    * `report_failure(..., fatal=True)` permanently retires a key (bad key,
      out of credits).
    * `report_failure(..., fatal=False, cooldown=X)` puts a key on an
      exponentially-growing cooldown (60s -> 120s -> ... capped at 10 min).
    """

    def __init__(self, keys: list[str], name: str):
        # Dedupe while preserving order.
        self.keys = list(dict.fromkeys(k.strip() for k in keys if k and k.strip()))
        if not self.keys:
            raise ConfigError(f"No {name} API keys configured. Set them in .env (comma-separated).")
        self.name = name
        self._state: dict[str, dict[str, Any]] = {
            k: {"fails": 0, "cooldown_until": 0.0, "dead": False} for k in self.keys
        }
        self._lock = threading.Lock()

    def __len__(self) -> int:
        return len(self.keys)

    def pick(self, exclude: Optional[set[str]] = None) -> str:
        """Random healthy key not in `exclude`. Raises FatalAPIError if none left."""
        exclude = exclude or set()
        with self._lock:
            now = time.time()
            alive = [k for k in self.keys if k not in exclude and not self._state[k]["dead"]]
            if not alive:
                raise FatalAPIError(
                    f"All {self.name} API keys are invalid or exhausted. "
                    f"Add more keys to {self.name.upper()}_API_KEYS in .env."
                )
            ready = [k for k in alive if self._state[k]["cooldown_until"] <= now]
            return random.choice(ready if ready else alive)

    def report_success(self, key: str) -> None:
        with self._lock:
            st = self._state.get(key)
            if st is not None:
                st["fails"] = 0
                st["cooldown_until"] = 0.0

    def report_rate_limited(self, key: str, cooldown: float = 60.0) -> None:
        """429: flat cooldown (rate-limit windows are usually ~1 minute, so there
        is no point in growing the backoff exponentially)."""
        with self._lock:
            st = self._state.get(key)
            if st is None:
                return
            st["fails"] += 1
            st["cooldown_until"] = max(st["cooldown_until"], time.time() + cooldown)

    def report_failure(self, key: str, *, fatal: bool = False, cooldown: float = 30.0) -> None:
        with self._lock:
            st = self._state.get(key)
            if st is None:
                return
            st["fails"] += 1
            if fatal:
                st["dead"] = True
                return
            backoff = min(cooldown * (2 ** (st["fails"] - 1)), 600.0)
            st["cooldown_until"] = time.time() + backoff

    def seconds_until_ready(self) -> Optional[float]:
        """Seconds until the soonest cooling key becomes ready again.
        None when there is no alive key at all."""
        with self._lock:
            now = time.time()
            alive = [k for k in self.keys if not self._state[k]["dead"]]
            if not alive:
                return None
            soonest = min(self._state[k]["cooldown_until"] for k in alive)
            return max(0.0, soonest - now)

    def stats(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return {k: dict(v) for k, v in self._state.items()}
