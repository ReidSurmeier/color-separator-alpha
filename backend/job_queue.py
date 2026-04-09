"""
In-process job queue for long-running color separation requests.

No external queue service needed — asyncio + dict is sufficient for
single-worker deployment (semaphore=1, one GPU).

Usage:
    job_id = create_job()
    update_job(job_id, JobStatus.RUNNING)
    update_job(job_id, JobStatus.DONE, result=b"...")
    job = get_job(job_id)
"""

import asyncio
import time
import uuid
from enum import Enum


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"


# In-memory job store.
# Format: {job_id: {"status": JobStatus, "result": bytes|None, "error": str|None,
#                   "created_at": float, "progress": str|None}}
_job_store: dict[str, dict] = {}

_JOB_TTL_SECONDS = 3600  # 1 hour


def create_job() -> str:
    """Create a new job entry. Returns the job_id."""
    job_id = str(uuid.uuid4())
    _job_store[job_id] = {
        "status": JobStatus.PENDING,
        "result": None,
        "error": None,
        "created_at": time.time(),
        "progress": None,
    }
    return job_id


def get_job(job_id: str) -> dict | None:
    """Return job dict or None if not found."""
    return _job_store.get(job_id)


def update_job(
    job_id: str,
    status: JobStatus,
    result: bytes | None = None,
    error: str | None = None,
    progress: str | None = None,
) -> None:
    """Update job status, result, error, and/or progress stage.

    progress: one of "separation" | "potrace" | "encoding" | None
    """
    job = _job_store.get(job_id)
    if job is None:
        return
    job["status"] = status
    if result is not None:
        job["result"] = result
    if error is not None:
        job["error"] = error
    if progress is not None:
        job["progress"] = progress


async def cleanup_expired_jobs() -> None:
    """Async loop: remove jobs older than _JOB_TTL_SECONDS. Run every 5 minutes."""
    while True:
        await asyncio.sleep(300)
        now = time.time()
        expired = [
            jid
            for jid, j in list(_job_store.items())
            if now - j["created_at"] > _JOB_TTL_SECONDS
        ]
        for jid in expired:
            del _job_store[jid]
