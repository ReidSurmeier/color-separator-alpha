"""
Structured analytics logger for the color-separator backend.

One JSON line per API request written to:
  - stdout  (prefixed [ANALYTICS] so docker logs captures it)
  - /tmp/colorsep-analytics.jsonl  (auto-rotates at 10 MB)

Usage:
    rlog = RequestLog("/api/plates-svg", request_id="abc123")
    rlog.set_input(w=1080, h=1080, kb=1600.0, fmt="PNG")
    rlog.set_params(plates=8, dust=20, version="v20", upscale=True, upscale_scale=4)

    with rlog.stage("separation"):
        result = v20.separate(...)

    with rlog.stage("potrace"):
        svgs = _build_svgs()

    rlog.set_output(w=4320, h=4320, plates_returned=8,
                    svg_sizes_kb=[504, 192], png_sizes_kb=[122, 107])
    rlog.finish(status=200)
"""

import contextlib
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

_LOG_PATH = Path("/tmp/colorsep-analytics.jsonl")
_MAX_BYTES = 10 * 1024 * 1024  # 10 MB
_ROTATE_COPIES = 3
_lock = threading.Lock()


def _rotate_if_needed() -> None:
    """Rename log to .1/.2/.3 when it exceeds _MAX_BYTES. Must be called under _lock."""
    try:
        if not _LOG_PATH.exists() or _LOG_PATH.stat().st_size < _MAX_BYTES:
            return
        for i in range(_ROTATE_COPIES - 1, 0, -1):
            src = Path(f"{_LOG_PATH}.{i}")
            dst = Path(f"{_LOG_PATH}.{i + 1}")
            if src.exists():
                src.rename(dst)
        _LOG_PATH.rename(Path(f"{_LOG_PATH}.1"))
    except Exception:
        pass  # Logging must never crash the request


def _write_entry(entry: dict) -> None:
    line = json.dumps(entry, separators=(",", ":"))
    # stdout — captured by `docker logs`
    try:
        print(f"[ANALYTICS] {line}", flush=True)
    except Exception:
        pass
    # JSONL file
    with _lock:
        try:
            _rotate_if_needed()
            with _LOG_PATH.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass


def _gpu_info() -> tuple[bool, str | None, int | None, int | None, int | None]:
    """Return (gpu_used, gpu_name, gpu_mem_allocated_mb, gpu_mem_peak_mb, gpu_utilization_pct). Never raises."""
    try:
        import torch
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            mem_mb = round(torch.cuda.memory_allocated(0) / (1024 ** 2))
            peak_mb = round(torch.cuda.max_memory_allocated(0) / (1024 ** 2))
            try:
                util_pct = torch.cuda.utilization(0)
            except Exception:
                util_pct = None
            return True, name, mem_mb, peak_mb, util_pct
    except Exception:
        pass
    return False, None, None, None, None


def _cpu_percent() -> float | None:
    try:
        import psutil
        return psutil.cpu_percent(interval=None)
    except Exception:
        return None


def _system_mem_gb() -> float | None:
    try:
        import psutil
        return round(psutil.virtual_memory().available / (1024 ** 3), 1)
    except Exception:
        return None


class _StageTimer(contextlib.AbstractContextManager):
    """Context manager that records elapsed ms into parent RequestLog."""

    def __init__(self, log: "RequestLog", name: str) -> None:
        self._log = log
        self._name = name
        self._start: float | None = None

    def __enter__(self) -> "_StageTimer":
        self._start = time.monotonic()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
        elapsed_ms = round((time.monotonic() - self._start) * 1000)
        self._log._stages[self._name] = elapsed_ms
        if exc_type is not None:
            self._log._error = f"{exc_type.__name__}: {exc_val}"
            self._log._error_type = exc_type.__name__
        return False  # Never suppress exceptions


class RequestLog:
    """Accumulates analytics data for one request and emits a single JSON entry."""

    def __init__(self, endpoint: str, request_id: str = "") -> None:
        self.endpoint = endpoint
        self.request_id = request_id or _short_id()
        self._t0 = time.monotonic()
        self._ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        # Input
        self._input_w: int | None = None
        self._input_h: int | None = None
        self._input_kb: float | None = None
        self._input_format: str | None = None

        # Params
        self._params: dict = {}

        # Output
        self._output_w: int | None = None
        self._output_h: int | None = None
        self._plates_returned: int | None = None
        self._svg_sizes_kb: list[float] | None = None
        self._png_sizes_kb: list[float] | None = None

        # Flags
        self._cache_hit: bool = False
        self._svg_cache_hit: bool = False
        self._fallback_used: bool = False
        self._warning: str | None = None

        # Errors
        self._error: str | None = None
        self._error_type: str | None = None

        # Stage timings (name -> ms)
        self._stages: dict[str, int] = {}

        # Client info
        self._user_agent: str | None = None
        self._client_ip: str | None = None

        # Image hash
        self._image_hash: str | None = None

    # ── setters ──────────────────────────────────────────────────────────

    def set_input(self, w: int, h: int, kb: float, fmt: str = "PNG") -> None:
        self._input_w = w
        self._input_h = h
        self._input_kb = round(kb, 1)
        self._input_format = fmt

    def set_params(self, **kwargs) -> None:
        self._params.update(kwargs)

    def set_output(
        self,
        w: int | None = None,
        h: int | None = None,
        plates_returned: int | None = None,
        svg_sizes_kb: list[float] | None = None,
        png_sizes_kb: list[float] | None = None,
    ) -> None:
        self._output_w = w
        self._output_h = h
        self._plates_returned = plates_returned
        if svg_sizes_kb is not None:
            self._svg_sizes_kb = [round(x, 1) for x in svg_sizes_kb]
        if png_sizes_kb is not None:
            self._png_sizes_kb = [round(x, 1) for x in png_sizes_kb]

    def set_cache_hit(self, hit: bool = True, svg: bool = False) -> None:
        self._cache_hit = hit
        self._svg_cache_hit = svg

    def set_fallback(self, used: bool = True) -> None:
        self._fallback_used = used

    def set_warning(self, msg: str) -> None:
        self._warning = msg

    def set_error(self, msg: str, exc_type: str | None = None) -> None:
        self._error = msg
        self._error_type = exc_type

    def set_client(self, user_agent: str, ip: str) -> None:
        self._user_agent = user_agent or None
        self._client_ip = ip or None

    def set_image_hash(self, hash: str) -> None:
        self._image_hash = hash or None

    # ── stage context manager ─────────────────────────────────────────────

    def stage(self, name: str) -> _StageTimer:
        """Use as ``with rlog.stage("separation"): ...``."""
        return _StageTimer(self, name)

    # ── emit ─────────────────────────────────────────────────────────────

    def finish(self, status: int = 200) -> None:
        """Finalize timing and write the log entry. Call exactly once per request."""
        duration_ms = round((time.monotonic() - self._t0) * 1000)
        gpu_used, gpu_name, gpu_mem_mb, gpu_mem_peak_mb, gpu_utilization_pct = _gpu_info()
        cpu_pct = _cpu_percent()

        entry: dict = {
            "ts": self._ts,
            "endpoint": self.endpoint,
            "request_id": self.request_id,
            "duration_ms": duration_ms,
            "status": status,
            # Input
            "input_w": self._input_w,
            "input_h": self._input_h,
            "input_kb": self._input_kb,
            "input_format": self._input_format,
        }

        # Params (flattened)
        entry.update(self._params)

        # Stage timings — use canonical keys where known, fall through for custom names
        _stage_key_map = {
            "upload": "stage_upload_ms",
            "separation": "stage_separation_ms",
            "upscale": "stage_upscale_ms",
            "potrace": "stage_potrace_ms",
            "png_encode": "stage_png_encode_ms",
        }
        for name, ms in self._stages.items():
            key = _stage_key_map.get(name, f"stage_{name}_ms")
            entry[key] = ms

        # Output
        entry.update({
            "output_w": self._output_w,
            "output_h": self._output_h,
            "plates_returned": self._plates_returned,
        })
        if self._svg_sizes_kb is not None:
            entry["svg_total_kb"] = round(sum(self._svg_sizes_kb), 1)
            entry["svg_sizes_kb"] = self._svg_sizes_kb
        if self._png_sizes_kb is not None:
            entry["png_total_kb"] = round(sum(self._png_sizes_kb), 1)
            entry["png_sizes_kb"] = self._png_sizes_kb

        # System
        entry.update({
            "gpu_used": gpu_used,
            "gpu_name": gpu_name,
            "gpu_mem_mb": gpu_mem_mb,
            "gpu_mem_peak_mb": gpu_mem_peak_mb,
            "gpu_utilization_pct": gpu_utilization_pct,
            "cpu_percent": cpu_pct,
            "system_mem_gb": _system_mem_gb(),
            "cache_hit": self._cache_hit,
            "svg_cache_hit": self._svg_cache_hit,
            "fallback_used": self._fallback_used,
            # Client
            "user_agent": self._user_agent,
            "client_ip": self._client_ip,
            "image_hash": self._image_hash,
            # Errors
            "error": self._error,
            "error_type": self._error_type,
            "warning": self._warning,
        })

        _write_entry(entry)


def _short_id() -> str:
    """8-char pseudo-random hex ID for request correlation."""
    import random
    return f"{random.getrandbits(32):08x}"


class EventLog:
    """Lightweight event for UI interactions — not full request logs."""

    def __init__(self, event_type: str, data: dict | None = None):
        entry = {
            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "type": "event",
            "event": event_type,
        }
        if data:
            entry.update(data)
        _write_entry(entry)
