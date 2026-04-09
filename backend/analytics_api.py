"""
Read-only analytics API — mounted onto the main FastAPI app in main.py.

GET /api/analytics
  ?limit=50          — max rows returned (capped at 500)
  ?endpoint=...      — filter by endpoint path (substring match)
  ?status=200        — filter by HTTP status code
  ?since=<iso8601>   — filter entries after this UTC timestamp

Returns:
{
  "entries": [...],   — list of JSON log entries (newest first)
  "summary": {
    "count": N,
    "avg_duration_ms": ...,
    "p95_duration_ms": ...,
    "error_rate": ...,
    "cache_hit_rate": ...,
    "svg_cache_hit_rate": ...
  }
}
"""

import json
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Any

router = APIRouter()
_LOG_PATH = Path("/tmp/colorsep-analytics.jsonl")

_ALLOWED_EVENTS = {
    "button_press", "param_change", "file_upload", "download_start",
    "download_complete", "merge", "zoom", "compare", "reset",
    "compare_toggle", "process_start", "process_complete", "plate_zoom", "error",
}


class EventRequest(BaseModel):
    event: str
    data: dict[str, Any] = {}


def _read_entries() -> list[dict]:
    """Read all entries from the live log file (and .1 rotation if present)."""
    entries: list[dict] = []
    for path in [_LOG_PATH, Path(f"{_LOG_PATH}.1")]:
        if not path.exists():
            continue
        try:
            with path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        except Exception:
            pass
    # Newest first
    entries.sort(key=lambda e: e.get("ts", ""), reverse=True)
    return entries


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    idx = int(len(sorted_vals) * pct / 100)
    idx = min(idx, len(sorted_vals) - 1)
    return sorted_vals[idx]


@router.get("/api/analytics")
async def analytics(
    limit: int = Query(50, ge=1, le=500),
    endpoint: str | None = Query(None),
    status: int | None = Query(None),
    since: str | None = Query(None),
):
    entries = _read_entries()

    # Filters
    if endpoint:
        entries = [e for e in entries if endpoint in e.get("endpoint", "")]
    if status is not None:
        entries = [e for e in entries if e.get("status") == status]
    if since:
        try:
            since_ts = since.rstrip("Z")
            entries = [e for e in entries if e.get("ts", "") >= since_ts]
        except Exception:
            pass

    # Summary computed from ALL matching entries before limit
    durations = [e["duration_ms"] for e in entries if isinstance(e.get("duration_ms"), (int, float))]
    errors = [e for e in entries if e.get("error") is not None]
    cache_hits = [e for e in entries if e.get("cache_hit") is True]
    svg_cache_hits = [e for e in entries if e.get("svg_cache_hit") is True]
    total = len(entries)

    summary = {
        "count": total,
        "avg_duration_ms": round(sum(durations) / len(durations)) if durations else None,
        "p95_duration_ms": round(_percentile(durations, 95)) if durations else None,
        "error_rate": round(len(errors) / total, 4) if total else None,
        "cache_hit_rate": round(len(cache_hits) / total, 4) if total else None,
        "svg_cache_hit_rate": round(len(svg_cache_hits) / total, 4) if total else None,
    }

    return JSONResponse({
        "entries": entries[:limit],
        "summary": summary,
    })


@router.post("/api/analytics/event")
async def log_event(body: EventRequest):
    if body.event not in _ALLOWED_EVENTS:
        return JSONResponse(
            status_code=400,
            content={"error": f"Unknown event type. Allowed: {sorted(_ALLOWED_EVENTS)}"},
        )
    from analytics import EventLog
    EventLog(body.event, body.data or None)
    return JSONResponse({"ok": True})


@router.get("/api/analytics/summary")
async def analytics_summary():
    entries = _read_entries()

    # Split request logs from event logs
    request_entries = [e for e in entries if e.get("type") != "event"]
    event_entries = [e for e in entries if e.get("type") == "event"]

    # Per-endpoint stats
    by_endpoint: dict[str, list[dict]] = defaultdict(list)
    for e in request_entries:
        ep = e.get("endpoint", "unknown")
        by_endpoint[ep].append(e)

    endpoint_stats = {}
    for ep, reqs in by_endpoint.items():
        durations = [r["duration_ms"] for r in reqs if isinstance(r.get("duration_ms"), (int, float))]
        errors = [r for r in reqs if r.get("error") is not None]
        endpoint_stats[ep] = {
            "count": len(reqs),
            "avg_duration_ms": round(sum(durations) / len(durations)) if durations else None,
            "error_count": len(errors),
        }

    # Top image dimensions
    dim_counts: dict[str, int] = defaultdict(int)
    for e in request_entries:
        w, h = e.get("input_w"), e.get("input_h")
        if w and h:
            dim_counts[f"{w}x{h}"] += 1
    top_dims = sorted(dim_counts.items(), key=lambda x: x[1], reverse=True)[:10]

    # GPU utilization distribution
    util_values = [
        e["gpu_utilization_pct"] for e in request_entries
        if isinstance(e.get("gpu_utilization_pct"), (int, float))
    ]
    gpu_dist = None
    if util_values:
        gpu_dist = {
            "min": min(util_values),
            "max": max(util_values),
            "avg": round(sum(util_values) / len(util_values), 1),
            "p95": round(_percentile(util_values, 95), 1),
        }

    # Events by type
    event_type_counts: dict[str, int] = defaultdict(int)
    for e in event_entries:
        event_type_counts[e.get("event", "unknown")] += 1

    # Requests per hour — last 24h
    now_utc = datetime.now(timezone.utc)
    cutoff = now_utc - timedelta(hours=24)
    hourly: dict[str, int] = defaultdict(int)
    for e in request_entries:
        ts_str = e.get("ts", "")
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            if ts >= cutoff:
                hour_key = ts.strftime("%Y-%m-%dT%H:00Z")
                hourly[hour_key] += 1
        except Exception:
            pass

    return JSONResponse({
        "endpoints": endpoint_stats,
        "top_dimensions": [{"dims": d, "count": c} for d, c in top_dims],
        "gpu_utilization": gpu_dist,
        "events_by_type": dict(event_type_counts),
        "requests_per_hour_last_24h": dict(sorted(hourly.items())),
        "total_requests": len(request_entries),
        "total_events": len(event_entries),
    })
