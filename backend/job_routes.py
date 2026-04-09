"""
FastAPI router for async job polling.

Wire into main.py after Issues 4+5 land:
    from job_routes import router as job_router
    app.include_router(job_router)

Also call startup registration in main.py:
    from job_queue import cleanup_expired_jobs
    # In startup handler:
    asyncio.create_task(cleanup_expired_jobs())
"""

import asyncio
import base64
import hashlib
import io
import json
import time

import psutil
from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from analytics import RequestLog
from job_queue import JobStatus, _job_store, create_job, get_job, update_job

router = APIRouter()


@router.get("/api/job/{job_id}")
async def job_status(job_id: str):
    """Poll job status. Returns result inline when done."""
    job = get_job(job_id)
    if job is None:
        return JSONResponse(
            status_code=404,
            content={"error": "Job not found or expired."},
        )

    status = job["status"]

    if status == JobStatus.DONE:
        result = job["result"]
        # Deliver once — clean up after download
        del _job_store[job_id]
        return Response(
            content=result,
            media_type="application/json",
            headers={"X-Job-Status": "done"},
        )

    if status == JobStatus.ERROR:
        error = job["error"]
        del _job_store[job_id]
        return JSONResponse(
            status_code=500,
            content={"error": error, "status": "error"},
        )

    # PENDING or RUNNING
    return JSONResponse({
        "status": str(status),
        "progress": job.get("progress"),
        "job_id": job_id,
    })


async def run_plates_svg_job(
    job_id: str,
    image_bytes: bytes,
    plates: int,
    dust: int,
    upscale: bool,
    upscale_scale: int,
    chroma_boost: float,
    shadow_threshold: int,
    highlight_threshold: int,
    median_size: int,
    locked: list,
    heavy_semaphore: asyncio.Semaphore,
) -> None:
    """Background worker for plates-svg jobs.

    Acquires heavy_semaphore to serialize GPU/SAM work, runs full-res v20
    separation on cache miss, then generates SVGs via potrace.

    Depends on:
      - Issue 4: v20._svg_cache + v20._SVG_CACHE_MAX_ENTRIES
      - Issue 5: v20._make_cache_key(..., res_tag="output") + v20.build_output_response()

    Until those land, the caller (main.py) must adapt the cache_key call.
    """
    try:
        import separate as v20
    except ImportError:
        update_job(job_id, JobStatus.ERROR, error="v20 module not available")
        return

    update_job(job_id, JobStatus.RUNNING)

    # ── Memory preflight ────────────────────────────────────────────────────
    try:
        from gpu_config import MEMORY_REQUIRED_CACHED, MEMORY_REQUIRED_UNCACHED
        mem = psutil.virtual_memory()
        free_gb = mem.available / 1e9
        threshold = (
            MEMORY_REQUIRED_CACHED if v20._sam_model else MEMORY_REQUIRED_UNCACHED
        )
        if free_gb < threshold:
            update_job(
                job_id,
                JobStatus.ERROR,
                error=(
                    f"Insufficient memory ({free_gb:.1f}GB free, "
                    f"need {threshold}GB)"
                ),
            )
            return
    except Exception as exc:
        update_job(job_id, JobStatus.ERROR, error=f"Memory check failed: {exc}")
        return

    # ── Analytics setup ─────────────────────────────────────────────────────
    raw_hash = hashlib.sha256(image_bytes).hexdigest()
    rlog = RequestLog("/api/plates-svg", request_id=raw_hash[:16])
    try:
        _probe = __import__("PIL.Image", fromlist=["Image"]).Image.open(
            io.BytesIO(image_bytes)
        )
        rlog.set_input(
            w=_probe.size[0],
            h=_probe.size[1],
            kb=len(image_bytes) / 1024,
            fmt=_probe.format or "PNG",
        )
    except Exception:
        pass
    rlog.set_params(
        plates=plates, dust=dust, version="v20",
        upscale=upscale, upscale_scale=upscale_scale,
    )

    loop = asyncio.get_event_loop()

    async with heavy_semaphore:
        try:
            # Issue 5 cache key — res_tag="output" separates from preview cache.
            # _make_cache_key gains res_tag param in Issue 5; until then the
            # caller in main.py passes a plain key and this line is replaced.
            cache_key = v20._make_cache_key(raw_hash, plates, dust, res_tag="output")
            svg_cache_key = cache_key  # dedicated _svg_cache, no prefix needed

            # ── SVG cache hit ────────────────────────────────────────────────
            if svg_cache_key in v20._svg_cache:
                rlog.set_cache_hit(hit=True, svg=True)
                rlog.finish(status=200)
                update_job(
                    job_id,
                    JobStatus.DONE,
                    result=v20._svg_cache[svg_cache_key].encode(),
                )
                return

            # ── Pixel separation cache miss — run full-res v20 ───────────────
            if cache_key not in v20._separation_cache:
                update_job(job_id, JobStatus.RUNNING, progress="separation")
                with rlog.stage("separation"):
                    await loop.run_in_executor(
                        None,
                        lambda: v20.build_output_response(
                            image_bytes=image_bytes,
                            plates=plates,
                            dust=dust,
                            upscale=upscale,
                            upscale_scale=upscale_scale,
                            chroma_boost=chroma_boost,
                            locked_colors=locked,
                            shadow_threshold=shadow_threshold,
                            highlight_threshold=highlight_threshold,
                            median_size=median_size,
                            cache_hash=raw_hash,
                        ),
                    )
            else:
                rlog.set_cache_hit(hit=True)

            cached = v20._separation_cache.get(cache_key)
            if cached is None:
                raise RuntimeError("Separation cache write failed unexpectedly.")

            manifest = cached["manifest"]
            h, w = manifest["height"], manifest["width"]

            # ── Potrace / SVG generation ─────────────────────────────────────
            update_job(job_id, JobStatus.RUNNING, progress="potrace")

            def _build_svgs():
                svgs = []
                for plate_info in manifest["plates"]:
                    name = plate_info["name"]
                    plate_data = cached["plates"].get(name, {})
                    mask = plate_data.get("mask")
                    svg = v20.mask_to_svg_string(mask, w, h) if mask is not None else ""

                    png_b64 = ""
                    plate_image = plate_data.get("image")
                    if plate_image is not None:
                        buf = io.BytesIO()
                        plate_image.save(buf, format="PNG", compress_level=1)
                        png_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

                    svgs.append({
                        "name": name,
                        "color": plate_info["color"],
                        "svg": svg,
                        "png_b64": png_b64,
                    })
                return svgs

            with rlog.stage("potrace"):
                svgs = await loop.run_in_executor(None, _build_svgs)

            # ── Encoding ─────────────────────────────────────────────────────
            update_job(job_id, JobStatus.RUNNING, progress="encoding")
            response_json = json.dumps(svgs)

            # Cache SVG result — potrace at full res is slow; cache for retries
            v20._svg_cache[svg_cache_key] = response_json
            while len(v20._svg_cache) > v20._SVG_CACHE_MAX_ENTRIES:
                oldest = next(iter(v20._svg_cache))
                del v20._svg_cache[oldest]

            # ── Analytics output ─────────────────────────────────────────────
            try:
                svg_sizes = [len(s.get("svg", "")) / 1024 for s in svgs]
                png_sizes = [
                    len(s.get("png_b64", "")) * 3 / 4 / 1024 for s in svgs
                ]
                rlog.set_output(
                    w=w, h=h,
                    plates_returned=len(svgs),
                    svg_sizes_kb=svg_sizes,
                    png_sizes_kb=png_sizes,
                )
            except Exception:
                pass
            rlog.finish(status=200)

            update_job(
                job_id,
                JobStatus.DONE,
                result=response_json.encode(),
            )

        except Exception as exc:
            err_msg = f"{type(exc).__name__}: {exc}"
            rlog.set_error(err_msg, type(exc).__name__)
            rlog.finish(status=500)
            update_job(job_id, JobStatus.ERROR, error=err_msg)
