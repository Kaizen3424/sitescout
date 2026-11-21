"""Settings: shared constants, the Config dataclass and where values come from."""
from __future__ import annotations

import argparse
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from errors import ConfigError
from keypool import KeyPool

log = logging.getLogger("sitescout")

USER_AGENT = "sitescout/1.0"


def _env_num(name: str, default: float, cast=float):
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return cast(raw)
    except ValueError:
        log.warning("Ignoring invalid %s=%r (using %s)", name, raw, default)
        return default


@dataclass(frozen=True)
class Config:
    firecrawl_keys: KeyPool
    gemini_keys: Optional[KeyPool] = None
    openrouter_keys: Optional[KeyPool] = None
    morph_keys: Optional[KeyPool] = None
    decision_provider: str = "gemini"  # gemini | openrouter | morph
    decision_model: str = "gemini-decision-1"  # Google Decisions API
    openrouter_model: str = "perplexity/pplx-decider-v1.3:free"  # OpenRouter Decisions model
    morph_model: str = "reflex"  # Morph System One decision model
    max_key_attempts: int = 5  # stop rotating after this many rejected provider keys
    viewport_w: int = 1440
    viewport_h: int = 900
    wait_for_ms: int = 2500
    scrape_timeout_ms: int = 60000
    shot_quality: int = 80
    capture_attempts: int = 2
    http_retries: int = 3
    backoff_base: float = 1.5
    image_resolution: str = "high"  # low | medium | high | ultra_high
    max_shot_height: int = 6000  # px; taller pages are cropped (needs Pillow)
    upload_budget_kb: float = 300.0  # keep the uploaded image under ~this many kB
    # Fitted to the owner's own bad/ok/good ratings (calibration/results.json).
    reach_out_threshold: float = 0.20
    maybe_threshold: float = 0.10
    min_confidence: float = 0.55
    cache_ttl_hours: float = 12.0
    decision_cache_ttl_hours: float = 72.0  # re-runs within this window reuse Gemini answers
    cache_dir: Path = Path.home() / ".cache" / "sitescout"
    report_path: Path = Path("report.json")  # single file with every URL's result
    batch_delay: float = 1.0
    save: bool = True


def load_dotenv(paths: list[Path]) -> None:
    for p in paths:
        try:
            # utf-8-sig: tolerates a BOM when the file was saved by Notepad.
            text = p.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            val = val.strip()
            if not val.startswith(("'", '"')) and " #" in val:
                val = val.split(" #", 1)[0].rstrip()  # allow "value  # comment"
            os.environ.setdefault(key, val.strip().strip('"').strip("'"))


def _env_keys(*names: str) -> list[str]:
    """Read the first environment variable that is set.

    Multiple keys are separated by commas (semicolons and spaces work too),
    e.g. ``GEMINI_API_KEYS=AIza...,AIza...``. Duplicates are dropped.
    """
    for name in names:
        raw = os.getenv(name)
        if not raw or not raw.strip():
            continue
        keys: list[str] = []
        for k in re.split(r"[,;\s]+", raw.strip()):
            if k and k not in keys:
                keys.append(k)
        if keys:
            return keys
    return []


def _read_key_file(path: Path) -> list[str]:
    """Read API keys from a plain text file: one key per line (commas work too)."""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return []
    keys: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        for k in re.split(r"[,;\s]+", line):
            if k and k not in keys:
                keys.append(k)
    return keys


def load_config(args: argparse.Namespace) -> Config:
    fc_keys = _env_keys("FIRECRAWL_API_KEYS", "FIRECRAWL_API_KEY")
    gm_keys = _env_keys("GEMINI_API_KEYS", "GEMINI_API_KEY", "GOOGLE_API_KEY")

    provider = os.getenv("SITESCOUT_DECISION_PROVIDER", "gemini").strip().lower() or "gemini"
    if provider not in {"gemini", "openrouter", "morph"}:
        raise ConfigError("SITESCOUT_DECISION_PROVIDER must be 'gemini', 'openrouter' or 'morph' "
                          f"(got {provider!r}).")

    # OpenRouter keys come from the environment, or from cli/openrouter.txt
    # (one key per line) so a large test pool is easy to manage without .env.
    or_keys = _env_keys("OPENROUTER_API_KEYS")
    if not or_keys:
        default_file = Path(__file__).resolve().parent / "openrouter.txt"
        key_file = Path(os.getenv("SITESCOUT_OPENROUTER_KEYS_FILE") or default_file)
        or_keys = _read_key_file(key_file)

    # Morph (System One / reflex) keys: extra_env or cli/morphllm.txt, same idea.
    morph_keys = _env_keys("MORPH_API_KEYS", "MORPH_API_KEY")
    if not morph_keys:
        default_file = Path(__file__).resolve().parent / "morphllm.txt"
        key_file = Path(os.getenv("SITESCOUT_MORPH_KEYS_FILE") or default_file)
        morph_keys = _read_key_file(key_file)

    required = [("FIRECRAWL_API_KEYS", fc_keys)]
    if provider == "gemini":
        required.append(("GEMINI_API_KEYS", gm_keys))
    elif provider == "openrouter":
        required.append(("OPENROUTER_API_KEYS (or cli/openrouter.txt)", or_keys))
    else:
        required.append(("MORPH_API_KEYS (or cli/morphllm.txt)", morph_keys))
    missing = [n for n, v in required if not v]
    if missing:
        raise ConfigError(
            f"Missing API keys: {', '.join(missing)}. Create a .env file next to sitescout.py "
            "with one line per service (comma-separated for multiple keys):\n"
            "  FIRECRAWL_API_KEYS=fc-aaa,fc-bbb\n"
            "  GEMINI_API_KEYS=AIzaA,AIzaB\n"
            "For the OpenRouter provider set OPENROUTER_API_KEYS in .env, or put one key per line in "
            "cli/openrouter.txt. For the Morph provider set MORPH_API_KEYS, or put one key per line in "
            "cli/morphllm.txt. See .env.example for a template."
        )

    resolution = os.getenv("SITESCOUT_IMAGE_RESOLUTION", "high").strip().lower()
    if resolution not in {"low", "medium", "high", "ultra_high"}:
        log.warning("Invalid SITESCOUT_IMAGE_RESOLUTION=%r, using 'high'", resolution)
        resolution = "high"
    return Config(
        firecrawl_keys=KeyPool(fc_keys, "firecrawl"),
        gemini_keys=KeyPool(gm_keys, "gemini") if gm_keys else None,
        openrouter_keys=KeyPool(or_keys, "openrouter") if or_keys else None,
        morph_keys=KeyPool(morph_keys, "morph") if morph_keys else None,
        decision_provider=provider,
        decision_model=os.getenv("SITESCOUT_MODEL", "gemini-decision-1").strip() or "gemini-decision-1",
        openrouter_model=os.getenv("SITESCOUT_OPENROUTER_MODEL", "perplexity/pplx-decider-v1.3:free").strip()
        or "perplexity/pplx-decider-v1.3:free",
        morph_model=os.getenv("SITESCOUT_MORPH_MODEL", "reflex").strip() or "reflex",
        max_key_attempts=_env_num("SITESCOUT_MAX_KEY_ATTEMPTS", 5, int),
        viewport_w=_env_num("SITESCOUT_VIEWPORT_W", 1440, int),
        viewport_h=_env_num("SITESCOUT_VIEWPORT_H", 900, int),
        wait_for_ms=_env_num("SITESCOUT_WAIT_MS", 2500, int),
        image_resolution=resolution,
        max_shot_height=_env_num("SITESCOUT_MAX_SHOT_HEIGHT", 6000, int),
        upload_budget_kb=_env_num("SITESCOUT_UPLOAD_BUDGET_KB", 300.0),
        reach_out_threshold=_env_num("SITESCOUT_REACH_OUT_THRESHOLD", 0.20),
        maybe_threshold=_env_num("SITESCOUT_MAYBE_THRESHOLD", 0.10),
        min_confidence=_env_num("SITESCOUT_MIN_CONFIDENCE", 0.55),
        cache_ttl_hours=_env_num("SITESCOUT_CACHE_TTL_HOURS", 12.0),
        decision_cache_ttl_hours=_env_num("SITESCOUT_DECISION_CACHE_TTL_HOURS", 72.0),
        cache_dir=Path(os.getenv("SITESCOUT_CACHE_DIR") or (Path.home() / ".cache" / "sitescout")),
        report_path=Path(args.out),
        save=not args.no_save,
    )
