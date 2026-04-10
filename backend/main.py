"""
FastAPI backend for woodblock color separation — v20 only.
Run: uvicorn main:app --host 0.0.0.0 --port 8001 --workers 1
"""
import asyncio
import re as _re
import base64
import gc
import hmac
import io
import json
import secrets
import time

import numpy as np
import psutil
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, JSONResponse
from PIL import Image
from starlette.background import BackgroundTask
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import StreamingResponse

from pydantic import BaseModel

from gpu_config import (
    BACKEND_API_KEY,
    GPU_AUTH_PASSWORD,
    HEAVY_SEMAPHORE_LIMIT,
    MAX_IMAGE_PIXELS,
    MEMORY_REQUIRED_CACHED,
    MEMORY_REQUIRED_UNCACHED,
    RATE_LIMIT_PER_MINUTE,
    UPSCALE_ENABLED,
    UPSCALE_SCALE,
)

# HEIF/HEIC image support
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

# Concurrency limit: 1 (SAM uses most of available VRAM/RAM)
_heavy_semaphore = asyncio.Semaphore(HEAVY_SEMAPHORE_LIMIT)

import separate as v20  # noqa: E402
from analytics import RequestLog  # noqa: E402

try:
    import auto_optimize
except ImportError:
    auto_optimize = None

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50MB
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

# Magic-byte signatures for allowed image formats
_IMAGE_MAGIC: list[tuple[bytes, bytes | None]] = [
    (b"\x89PNG", None),       # PNG
    (b"\xff\xd8\xff", None),  # JPEG
    (b"GIF87a", None),        # GIF87
    (b"GIF89a", None),        # GIF89
    (b"RIFF", b"WEBP"),      # WebP  (bytes 8-11 = "WEBP")
    (b"II*\x00", None),      # TIFF LE
    (b"MM\x00*", None),      # TIFF BE
    # HEIF/HEIC handled separately below via ftyp brand check
    (b"BM", None),           # BMP
]


def _check_magic(data: bytes) -> bool:
    """Return True if data starts with a recognised image magic sequence."""
    for magic, extra in _IMAGE_MAGIC:
        if data[:len(magic)] == magic:
            if extra is None:
                return True
            # For WebP: bytes 8-11 must equal the extra tag
            if data[8:12] == extra:
                return True
    # HEIF/HEIC: ftyp box at offset 4 with validated brand
    _HEIF_BRANDS = {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}
    if len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in _HEIF_BRANDS:
        return True
    return False


async def validate_upload(image_bytes: bytes):
    """Validate uploaded image. Returns error response or None if valid."""
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        return JSONResponse(status_code=413, content={"error": "File too large. Max 50MB."})

    if not _check_magic(image_bytes):
        return JSONResponse(status_code=400, content={"error": "Invalid image file."})

    try:
        img = Image.open(io.BytesIO(image_bytes))
        img.load()
        w, h = img.size
        if w * h > MAX_IMAGE_PIXELS:
            return JSONResponse(
                status_code=413,
                content={"error": f"Image too large ({w}x{h}). Max {MAX_IMAGE_PIXELS} pixels."},
            )
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid image file."})
    return None


def strip_exif(image_bytes: bytes) -> bytes:
    """Return image bytes with EXIF/metadata stripped (re-saved as PNG)."""
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        return image_bytes


app = FastAPI(title="Woodblock Color Separation API")

from analytics_api import router as analytics_router  # noqa: E402
app.include_router(analytics_router)

from job_routes import router as job_router  # noqa: E402
app.include_router(job_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://tools.reidsurmeier.wtf",
        "https://colorseparator.reidsurmeier.wtf",
        "https://colorseperator.reidsurmeier.wtf",
        "http://localhost:3008",
        "http://localhost:3003",
    ],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key", "Accept"],
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add standard security headers to every response."""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response


app.add_middleware(SecurityHeadersMiddleware)


class APIKeyMiddleware(BaseHTTPMiddleware):
    """Require X-API-Key header when BACKEND_API_KEY is configured."""
    async def dispatch(self, request: Request, call_next):
        if not BACKEND_API_KEY:
            return await call_next(request)
        if request.url.path == "/api/health":
            return await call_next(request)
        key = request.headers.get("X-API-Key", "")
        if not hmac.compare_digest(key, BACKEND_API_KEY):
            return JSONResponse(status_code=401, content={"error": "Invalid or missing API key."})
        return await call_next(request)


app.add_middleware(APIKeyMiddleware)

try:
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.util import get_remote_address
    from slowapi.errors import RateLimitExceeded
    limiter = Limiter(key_func=get_remote_address, default_limits=[f"{RATE_LIMIT_PER_MINUTE}/minute"])
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
except ImportError as _slowapi_err:
    raise ImportError(
        "slowapi is required for rate limiting. "
        "Install it with: pip install slowapi"
    ) from _slowapi_err

# GPU auth token store: token -> expiry timestamp (unix seconds)
_GPU_TOKENS: dict[str, float] = {}
_GPU_TOKEN_TTL = 86400  # 24 hours


def _purge_expired_tokens() -> None:
    now = time.time()
    expired = [tok for tok, exp in _GPU_TOKENS.items() if exp < now]
    for tok in expired:
        del _GPU_TOKENS[tok]


class AuthRequest(BaseModel):
    password: str


@app.post("/api/auth/verify")
async def verify_gpu_password(body: AuthRequest):
    """Verify password to unlock GPU features on the frontend."""
    if not GPU_AUTH_PASSWORD:
        return {"authorized": True}
    if hmac.compare_digest(body.password, GPU_AUTH_PASSWORD):
        _purge_expired_tokens()
        token = secrets.token_urlsafe(32)
        _GPU_TOKENS[token] = time.time() + _GPU_TOKEN_TTL
        return {"authorized": True, "token": token}
    return JSONResponse(status_code=403, content={"authorized": False, "error": "Invalid password."})


@app.post("/api/auth/check")
async def check_gpu_token(body: dict):
    """Check if a GPU auth token is still valid."""
    if not GPU_AUTH_PASSWORD:
        return {"valid": True}
    _purge_expired_tokens()
    token = body.get("token", "")
    if not token:
        return {"valid": False}
    expiry = _GPU_TOKENS.get(token)
    valid = expiry is not None and time.time() < expiry
    return {"valid": valid}


def parse_locked_colors(raw: str | None) -> list[list[int]] | None:
    if not raw:
        return None
    try:
        colors = json.loads(raw)
        if isinstance(colors, list) and len(colors) > 0:
            return colors
    except (json.JSONDecodeError, TypeError):
        pass
    return None


PLATES_MIN = 2
PLATES_MAX = 60
SAM_PLATES_MAX = 60
DUST_MIN = 5
DUST_MAX = 100
SAM_TIMEOUT_SECONDS = 600


def _clamp(val: int, lo: int, hi: int) -> int:
    return max(lo, min(val, hi))


def _clamp_float_params(params: dict) -> dict:
    """Clamp all numeric processing params to safe ranges."""
    clamps = {
        "edge_sigma": (0.1, 10.0),
        "sigma_s": (1.0, 300.0),
        "sigma_r": (0.01, 1.0),
        "meanshift_sp": (1, 60),
        "meanshift_sr": (1, 80),
        "chroma_boost": (0.5, 3.0),
        "median_size": (1, 15),
        "shadow_threshold": (0, 50),
        "highlight_threshold": (50, 100),
        "detail_strength": (0.0, 2.0),
        "n_segments": (100, 10000),
        "compactness": (1, 100),
        "crf_spatial": (1, 20),
        "crf_color": (1, 50),
        "crf_compat": (1, 50),
    }
    for key, (lo, hi) in clamps.items():
        if key in params:
            params[key] = type(lo)(max(lo, min(params[key], hi)))
    return params


def _cleanup_gpu():
    """Force garbage collection and free GPU memory."""
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def check_memory_for_sam(n_colors: int = 20):
    """Check if enough memory is available for SAM processing.
    Returns (ok: bool, message: str)
    """
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    available_gb = (mem.available + swap.free) / (1024**3)

    sam_cached = v20._sam_model is not None
    required_gb = MEMORY_REQUIRED_CACHED if sam_cached else MEMORY_REQUIRED_UNCACHED

    if n_colors > 20:
        required_gb = required_gb + 4.0

    if available_gb < required_gb:
        return False, f"Insufficient memory: {available_gb:.1f}GB available, need {required_gb:.1f}GB."
    return True, "OK"


@app.get("/api/health")
async def health():
    mem = psutil.virtual_memory()
    sam_cached = v20._sam_model is not None

    gpu_available = False
    gpu_name = None
    gpu_mem_mb = None
    try:
        import torch
        if torch.cuda.is_available():
            gpu_available = True
            gpu_name = torch.cuda.get_device_name(0)
            gpu_mem_mb = round(torch.cuda.get_device_properties(0).total_memory / (1024**2))
    except Exception:
        pass

    ok, mem_msg = check_memory_for_sam()

    return {
        "status": "ok" if ok else "degraded",
        "sam_cached": sam_cached,
        "sam_ready": ok,
        "sam_memory_note": mem_msg if not ok else None,
        "gpu_available": gpu_available,
        "gpu_name": gpu_name,
        "gpu_memory_mb": gpu_mem_mb,
        "system_memory_available_gb": round(mem.available / (1024**3), 1),
        "sam_plates_max": SAM_PLATES_MAX,
        "plates_60_supported": SAM_PLATES_MAX >= 60,
        "upscale_enabled": UPSCALE_ENABLED,
        "upscale_scale": UPSCALE_SCALE if UPSCALE_ENABLED else None,
    }


@app.post("/api/preview")
async def preview(
    image: UploadFile = File(...),
    plates: int = Form(3),
    dust: int = Form(20),
    use_edges: bool = Form(True),
    edge_sigma: float = Form(1.5),
    locked_colors: str | None = Form(None),
    version: str = Form("v20"),
    upscale: bool = Form(True),
    median_size: int = Form(5),
    chroma_boost: float = Form(1.3),
    shadow_threshold: int = Form(8),
    highlight_threshold: int = Form(95),
    n_segments: int = Form(3000),
    compactness: int = Form(15),
    crf_spatial: int = Form(3),
    crf_color: int = Form(13),
    crf_compat: int = Form(10),
    sigma_s: float = Form(100),
    sigma_r: float = Form(0.5),
    meanshift_sp: int = Form(15),
    meanshift_sr: int = Form(30),
    detail_strength: float = Form(0.5),
):
    image_bytes = await image.read()
    err = await validate_upload(image_bytes)
    if err is not None:
        return err
    image_bytes = strip_exif(image_bytes)
    locked = parse_locked_colors(locked_colors)
    plates = _clamp(plates, PLATES_MIN, SAM_PLATES_MAX)
    dust = _clamp(dust, DUST_MIN, DUST_MAX)
    _clamped = _clamp_float_params(dict(
        edge_sigma=edge_sigma, sigma_s=sigma_s, sigma_r=sigma_r,
        meanshift_sp=meanshift_sp, meanshift_sr=meanshift_sr,
        chroma_boost=chroma_boost, median_size=median_size,
        shadow_threshold=shadow_threshold, highlight_threshold=highlight_threshold,
        detail_strength=detail_strength, n_segments=n_segments, compactness=compactness,
        crf_spatial=crf_spatial, crf_color=crf_color, crf_compat=crf_compat,
    ))
    chroma_boost = _clamped["chroma_boost"]
    median_size = _clamped["median_size"]
    shadow_threshold = _clamped["shadow_threshold"]
    highlight_threshold = _clamped["highlight_threshold"]
    edge_sigma = _clamped["edge_sigma"]

    kwargs: dict = dict(
        image_bytes=image_bytes,
        plates=plates,
        dust=dust,
        use_edges=use_edges,
        edge_sigma=edge_sigma,
        locked_colors=locked,
        shadow_threshold=shadow_threshold,
        highlight_threshold=highlight_threshold,
        median_size=median_size,
        chroma_boost=chroma_boost,
        upscale=upscale if UPSCALE_ENABLED else False,
    )

    ok, msg = check_memory_for_sam(n_colors=plates)
    if not ok:
        return JSONResponse(
            status_code=503,
            content={"error": msg, "code": "MEMORY_LOW", "retry_after_seconds": 30, "plates_completed": 0},
            headers={"Retry-After": "30"},
        )
    try:
        async with _heavy_semaphore:
            composite_bytes, manifest = await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None, lambda: v20.build_preview_response(**kwargs)
                ),
                timeout=SAM_TIMEOUT_SECONDS,
            )
    except asyncio.TimeoutError:
        _cleanup_gpu()
        return JSONResponse(status_code=504, content={
            "error": f"Processing timed out after {SAM_TIMEOUT_SECONDS}s. Try fewer plates or a smaller image.",
            "code": "TIMEOUT",
        })
    except Exception as e:
        _cleanup_gpu()
        return JSONResponse(status_code=500, content={
            "error": f"Separation failed: {type(e).__name__}: {e}",
            "code": "PROCESSING_ERROR",
        })
    finally:
        _cleanup_gpu()

    return Response(
        content=composite_bytes,
        media_type="image/png",
        headers={"X-Manifest": json.dumps(manifest)},
    )


@app.post("/api/preview-stream")
async def preview_stream(
    request: Request,
    image: UploadFile = File(...),
    plates: int = Form(3),
    dust: int = Form(20),
    use_edges: bool = Form(True),
    edge_sigma: float = Form(1.5),
    locked_colors: str | None = Form(None),
    version: str = Form("v20"),
    upscale: bool = Form(True),
    median_size: int = Form(5),
    chroma_boost: float = Form(1.3),
    shadow_threshold: int = Form(8),
    highlight_threshold: int = Form(95),
    n_segments: int = Form(3000),
    compactness: int = Form(15),
    crf_spatial: int = Form(3),
    crf_color: int = Form(13),
    crf_compat: int = Form(10),
    sigma_s: float = Form(100),
    sigma_r: float = Form(0.5),
    meanshift_sp: int = Form(15),
    meanshift_sr: int = Form(30),
    detail_strength: float = Form(0.5),
):
    """Stream progress events via SSE, then send final result.

    SSE heartbeats keep the connection alive past Cloudflare's 100s tunnel timeout.
    """
    image_bytes = await image.read()
    err = await validate_upload(image_bytes)
    if err is not None:
        return err
    image_bytes = strip_exif(image_bytes)

    rlog = RequestLog("/api/preview-stream")
    rlog.set_client(
        request.headers.get("user-agent", ""),
        request.client.host if request.client else "",
    )
    try:
        _probe = Image.open(io.BytesIO(image_bytes))
        _iw, _ih = _probe.size
        _ifmt = _probe.format or "PNG"
    except Exception:
        _iw, _ih, _ifmt = None, None, "PNG"
    rlog.set_input(w=_iw, h=_ih, kb=round(len(image_bytes) / 1024, 1), fmt=_ifmt)
    rlog.set_params(plates=plates, dust=dust, version="v20", upscale=upscale, upscale_scale=None)

    locked = parse_locked_colors(locked_colors)
    plates = _clamp(plates, PLATES_MIN, SAM_PLATES_MAX)
    dust = _clamp(dust, DUST_MIN, DUST_MAX)
    _clamped = _clamp_float_params(dict(
        edge_sigma=edge_sigma, sigma_s=sigma_s, sigma_r=sigma_r,
        meanshift_sp=meanshift_sp, meanshift_sr=meanshift_sr,
        chroma_boost=chroma_boost, median_size=median_size,
        shadow_threshold=shadow_threshold, highlight_threshold=highlight_threshold,
        detail_strength=detail_strength, n_segments=n_segments, compactness=compactness,
        crf_spatial=crf_spatial, crf_color=crf_color, crf_compat=crf_compat,
    ))
    chroma_boost = _clamped["chroma_boost"]
    median_size = _clamped["median_size"]
    shadow_threshold = _clamped["shadow_threshold"]
    highlight_threshold = _clamped["highlight_threshold"]
    edge_sigma = _clamped["edge_sigma"]

    ok, msg = check_memory_for_sam(n_colors=plates)
    if not ok:
        rlog.set_error(msg)
        rlog.finish(503)
        return JSONResponse(
            status_code=503,
            content={"error": msg, "code": "MEMORY_LOW", "retry_after_seconds": 30, "plates_completed": 0},
            headers={"Retry-After": "30"},
        )

    progress_events: list[dict] = []

    def on_progress(stage: str, pct: int):
        progress_events.append({"stage": stage, "pct": pct})

    kwargs: dict = dict(
        image_bytes=image_bytes,
        plates=plates,
        dust=dust,
        use_edges=use_edges,
        edge_sigma=edge_sigma,
        locked_colors=locked,
        shadow_threshold=shadow_threshold,
        highlight_threshold=highlight_threshold,
        median_size=median_size,
        chroma_boost=chroma_boost,
        upscale=upscale if UPSCALE_ENABLED else False,
        progress_callback=on_progress,
    )

    async def generate():
        loop = asyncio.get_event_loop()

        try:
            async with _heavy_semaphore:
                future = loop.run_in_executor(
                    None, lambda: v20.build_preview_response(**kwargs)
                )

                sent = 0
                elapsed = 0.0
                last_heartbeat_ts = time.time()
                plates_seen = 0
                total_plates = plates
                while not future.done():
                    await asyncio.sleep(0.3)
                    elapsed += 0.3
                    if elapsed > SAM_TIMEOUT_SECONDS:
                        future.cancel()
                        _t_err = (
                            f'Processing timed out after {SAM_TIMEOUT_SECONDS}s.'
                            ' Try fewer plates or a smaller image.'
                        )
                        rlog.set_error(_t_err, exc_type="TimeoutError")
                        rlog.finish(504)
                        yield f"data: {json.dumps({'stage': 'error', 'pct': 0, 'error': _t_err})}\n\n"
                        return
                    while sent < len(progress_events):
                        evt = progress_events[sent]
                        pct = evt.get("pct", 0)
                        yield f"data: {json.dumps(evt)}\n\n"
                        sent += 1
                        if "plate" in evt.get("stage", "").lower():
                            plates_seen += 1
                            _pc = {'stage': 'plate_complete', 'pct': pct,
                                   'plate_index': plates_seen, 'total_plates': total_plates}
                            yield f"data: {json.dumps(_pc)}\n\n"
                    now = time.time()
                    if now - last_heartbeat_ts >= 10.0:
                        yield f"data: {json.dumps({'stage': 'heartbeat', 'pct': -1, 'ts': now})}\n\n"
                        last_heartbeat_ts = now

                # Drain remaining progress events
                while sent < len(progress_events):
                    evt = progress_events[sent]
                    pct = evt.get("pct", 0)
                    yield f"data: {json.dumps(evt)}\n\n"
                    sent += 1
                    if "plate" in evt.get("stage", "").lower():
                        plates_seen += 1
                        _pc2 = {'stage': 'plate_complete', 'pct': pct,
                                'plate_index': plates_seen, 'total_plates': total_plates}
                        yield f"data: {json.dumps(_pc2)}\n\n"

                composite_bytes, manifest = future.result()

            img_b64 = base64.b64encode(composite_bytes).decode()
            pct = 100
            if manifest.get("partial_results"):
                _partial = {
                    'stage': 'partial_complete', 'pct': pct,
                    'plates_completed': len(manifest.get('plates', [])),
                    'error': 'memory_pressure', 'manifest': manifest, 'image': img_b64,
                }
                yield f"data: {json.dumps(_partial)}\n\n"
                rlog.finish(206)
            else:
                _done = {'stage': 'complete', 'pct': 100,
                         'manifest': manifest, 'image': img_b64}
                yield f"data: {json.dumps(_done)}\n\n"
                rlog.finish(200)
        except (MemoryError, Exception) as e:
            err_str = str(e)
            if isinstance(e, MemoryError) or "CUDA out of memory" in err_str:
                _oom = {'stage': 'partial_complete', 'pct': 0,
                        'plates_completed': 0, 'error': 'memory_pressure'}
                yield f"data: {json.dumps(_oom)}\n\n"
                rlog.set_error(f"{type(e).__name__}: {e}", exc_type=type(e).__name__)
                rlog.finish(500)
                return
            rlog.set_error(f"{type(e).__name__}: {e}", exc_type=type(e).__name__)
            rlog.finish(500)
            yield f"data: {json.dumps({'stage': 'error', 'pct': 0, 'error': f'{type(e).__name__}: {e}'})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream",
                             background=BackgroundTask(_cleanup_gpu))


@app.post("/api/separate")
async def separate_endpoint(
    request: Request,
    image: UploadFile = File(...),
    plates: int = Form(3),
    dust: int = Form(20),
    use_edges: bool = Form(True),
    edge_sigma: float = Form(1.5),
    locked_colors: str | None = Form(None),
    version: str = Form("v20"),
    upscale: bool = Form(True),
    median_size: int = Form(5),
    chroma_boost: float = Form(1.3),
    shadow_threshold: int = Form(8),
    highlight_threshold: int = Form(95),
    n_segments: int = Form(3000),
    compactness: int = Form(15),
    crf_spatial: int = Form(3),
    crf_color: int = Form(13),
    crf_compat: int = Form(10),
    sigma_s: float = Form(100),
    sigma_r: float = Form(0.5),
    meanshift_sp: int = Form(15),
    meanshift_sr: int = Form(30),
    detail_strength: float = Form(0.5),
):
    image_bytes = await image.read()
    err = await validate_upload(image_bytes)
    if err is not None:
        return err
    image_bytes = strip_exif(image_bytes)

    rlog = RequestLog("/api/separate")
    rlog.set_client(
        request.headers.get("user-agent", ""),
        request.client.host if request.client else "",
    )
    try:
        _probe = Image.open(io.BytesIO(image_bytes))
        _iw, _ih = _probe.size
        _ifmt = _probe.format or "PNG"
    except Exception:
        _iw, _ih, _ifmt = None, None, "PNG"
    rlog.set_input(w=_iw, h=_ih, kb=round(len(image_bytes) / 1024, 1), fmt=_ifmt)
    rlog.set_params(plates=plates, dust=dust, version="v20", upscale=upscale)

    locked = parse_locked_colors(locked_colors)
    plates = _clamp(plates, PLATES_MIN, SAM_PLATES_MAX)
    dust = _clamp(dust, DUST_MIN, DUST_MAX)
    _clamped = _clamp_float_params(dict(
        edge_sigma=edge_sigma, sigma_s=sigma_s, sigma_r=sigma_r,
        meanshift_sp=meanshift_sp, meanshift_sr=meanshift_sr,
        chroma_boost=chroma_boost, median_size=median_size,
        shadow_threshold=shadow_threshold, highlight_threshold=highlight_threshold,
        detail_strength=detail_strength, n_segments=n_segments, compactness=compactness,
        crf_spatial=crf_spatial, crf_color=crf_color, crf_compat=crf_compat,
    ))
    chroma_boost = _clamped["chroma_boost"]
    median_size = _clamped["median_size"]
    shadow_threshold = _clamped["shadow_threshold"]
    highlight_threshold = _clamped["highlight_threshold"]
    edge_sigma = _clamped["edge_sigma"]

    kwargs: dict = dict(
        image_bytes=image_bytes,
        plates=plates,
        dust=dust,
        use_edges=use_edges,
        edge_sigma=edge_sigma,
        locked_colors=locked,
        shadow_threshold=shadow_threshold,
        highlight_threshold=highlight_threshold,
        median_size=median_size,
        chroma_boost=chroma_boost,
        upscale=upscale if UPSCALE_ENABLED else False,
    )

    ok, msg = check_memory_for_sam(n_colors=plates)
    if not ok:
        rlog.set_error(msg)
        rlog.finish(503)
        return JSONResponse(
            status_code=503,
            content={"error": msg, "code": "MEMORY_LOW", "retry_after_seconds": 30, "plates_completed": 0},
            headers={"Retry-After": "30"},
        )
    try:
        async with _heavy_semaphore:
            zip_bytes = await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None, lambda: v20.build_zip_response(**kwargs)
                ),
                timeout=SAM_TIMEOUT_SECONDS,
            )
        rlog.finish(200)
    except asyncio.TimeoutError:
        _cleanup_gpu()
        rlog.set_error(f"Timed out after {SAM_TIMEOUT_SECONDS}s", exc_type="TimeoutError")
        rlog.finish(504)
        return JSONResponse(status_code=504, content={
            "error": f"Processing timed out after {SAM_TIMEOUT_SECONDS}s. Try fewer plates or a smaller image.",
            "code": "TIMEOUT",
        })
    except Exception as e:
        _cleanup_gpu()
        rlog.set_error(f"{type(e).__name__}: {e}", exc_type=type(e).__name__)
        rlog.finish(500)
        return JSONResponse(status_code=500, content={
            "error": f"Separation failed: {type(e).__name__}: {e}",
            "code": "PROCESSING_ERROR",
        })
    finally:
        _cleanup_gpu()

    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=woodblock-plates.zip"},
    )


@app.post("/api/upscale")
async def upscale_endpoint(image: UploadFile = File(...)):
    """Pre-upscale an image and cache it for later processing."""
    image_bytes = await image.read()
    err = await validate_upload(image_bytes)
    if err is not None:
        return err
    image_bytes = strip_exif(image_bytes)
    img_hash, cached, success = v20.upscale_and_cache(image_bytes)
    return Response(
        content=json.dumps({"hash": img_hash, "cached": cached, "upscaled": success}),
        media_type="application/json",
    )


@app.post("/api/merge")
async def merge_endpoint(
    request: Request,
    image: UploadFile = File(...),
    merge_pairs: str = Form(...),
    plates: int = Form(3),
    dust: int = Form(20),
    locked_colors: str | None = Form(None),
    version: str = Form("v20"),
    upscale: bool = Form(True),
    chroma_boost: float = Form(1.3),
    sigma_s: float = Form(100),
    sigma_r: float = Form(0.5),
    meanshift_sp: int = Form(15),
    meanshift_sr: int = Form(30),
    img_hash: str | None = Form(None),
):
    """Run separation then merge specified plate pairs."""
    image_bytes = await image.read()
    err = await validate_upload(image_bytes)
    if err is not None:
        return err
    image_bytes = strip_exif(image_bytes)

    rlog = RequestLog("/api/merge")
    rlog.set_client(
        request.headers.get("user-agent", ""),
        request.client.host if request.client else "",
    )
    try:
        _probe = Image.open(io.BytesIO(image_bytes))
        _iw, _ih = _probe.size
        _ifmt = _probe.format or "PNG"
    except Exception:
        _iw, _ih, _ifmt = None, None, "PNG"
    rlog.set_input(w=_iw, h=_ih, kb=round(len(image_bytes) / 1024, 1), fmt=_ifmt)
    rlog.set_params(plates=plates, dust=dust, version="v20", upscale=upscale)

    locked = parse_locked_colors(locked_colors)
    try:
        pairs = json.loads(merge_pairs)
    except (json.JSONDecodeError, TypeError):
        rlog.set_error("Invalid merge_pairs JSON")
        rlog.finish(400)
        return JSONResponse(status_code=400, content={"error": "Invalid merge_pairs JSON."})

    rlog.set_merge_info(pairs)
    plates = _clamp(plates, PLATES_MIN, SAM_PLATES_MAX)

    merge_kwargs = dict(
        image_bytes=image_bytes,
        merge_pairs=pairs,
        plates=plates,
        dust=dust,
        locked_colors=locked,
        chroma_boost=chroma_boost,
        sigma_s=sigma_s,
        sigma_r=sigma_r,
        meanshift_sp=meanshift_sp,
        meanshift_sr=meanshift_sr,
        upscale=upscale if UPSCALE_ENABLED else False,
        img_hash=img_hash,
    )

    ok, msg = check_memory_for_sam(n_colors=plates)
    if not ok:
        rlog.set_error(msg)
        rlog.finish(503)
        return JSONResponse(
            status_code=503,
            content={"error": msg, "code": "MEMORY_LOW", "retry_after_seconds": 30, "plates_completed": 0},
            headers={"Retry-After": "30"},
        )
    try:
        async with _heavy_semaphore:
            composite_bytes, manifest = await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None, lambda: v20.build_merge_response(**merge_kwargs)
                ),
                timeout=SAM_TIMEOUT_SECONDS,
            )
        rlog.finish(200)
    except asyncio.TimeoutError:
        _cleanup_gpu()
        rlog.set_error(f"Timed out after {SAM_TIMEOUT_SECONDS}s", exc_type="TimeoutError")
        rlog.finish(504)
        return JSONResponse(status_code=504, content={
            "error": f"Merge timed out after {SAM_TIMEOUT_SECONDS}s. Try fewer plates or a smaller image.",
            "code": "TIMEOUT",
        })
    except Exception as e:
        _cleanup_gpu()
        rlog.set_error(f"{type(e).__name__}: {e}", exc_type=type(e).__name__)
        rlog.finish(500)
        return JSONResponse(status_code=500, content={
            "error": f"Merge failed: {type(e).__name__}: {e}",
            "code": "PROCESSING_ERROR",
        })
    finally:
        _cleanup_gpu()

    return Response(
        content=composite_bytes,
        media_type="image/png",
        headers={"X-Manifest": json.dumps(manifest)},
    )


@app.post("/api/plates")
async def plates_endpoint(
    image: UploadFile = File(...),
    plates: int = Form(3),
    dust: int = Form(20),
    version: str = Form("v20"),
    upscale: bool = Form(True),
    chroma_boost: float = Form(1.3),
    sigma_s: float = Form(100),
    sigma_r: float = Form(0.5),
    meanshift_sp: int = Form(15),
    meanshift_sr: int = Form(30),
    locked_colors: str | None = Form(None),
):
    """Return JSON with base64-encoded plate thumbnail images (800px max)."""
    image_bytes = await image.read()
    err = await validate_upload(image_bytes)
    if err is not None:
        return err
    image_bytes = strip_exif(image_bytes)
    locked = parse_locked_colors(locked_colors)
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        img.load()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid image file"})

    max_dim = 800
    if max(img.size) > max_dim:
        ratio = max_dim / max(img.size)
        img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)), Image.LANCZOS)

    plates = _clamp(int(plates), PLATES_MIN, SAM_PLATES_MAX)
    arr = np.array(img)

    kwargs: dict = dict(
        n_plates=plates,
        dust_threshold=dust,
        locked_colors=locked,
        return_data=True,
        upscale=False,  # thumbnails never upscaled
        chroma_boost=chroma_boost,
        use_edges=True,
        edge_sigma=1.5,
        shadow_threshold=8,
        highlight_threshold=95,
        median_size=3,
    )

    ok, msg = check_memory_for_sam(n_colors=plates)
    if not ok:
        return JSONResponse(
            status_code=503,
            content={"error": msg, "code": "MEMORY_LOW", "retry_after_seconds": 30, "plates_completed": 0},
            headers={"Retry-After": "30"},
        )
    try:
        async with _heavy_semaphore:
            result = await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None, lambda: v20.separate(arr, **kwargs)
                ),
                timeout=SAM_TIMEOUT_SECONDS,
            )
    except asyncio.TimeoutError:
        _cleanup_gpu()
        return JSONResponse(status_code=504, content={
            "error": f"Processing timed out after {SAM_TIMEOUT_SECONDS}s.",
            "code": "TIMEOUT",
        })
    except Exception as e:
        _cleanup_gpu()
        return JSONResponse(status_code=500, content={
            "error": f"Separation failed: {type(e).__name__}: {e}",
            "code": "PROCESSING_ERROR",
        })
    finally:
        _cleanup_gpu()

    plate_images = []
    for plate_info in result["manifest"]["plates"]:
        name = plate_info["name"]
        plate_data = result["plates"][name]
        buf = io.BytesIO()
        plate_data["image"].save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        plate_images.append({
            "name": name,
            "color": plate_info["color"],
            "coverage": plate_info.get("coverage_pct", 0),
            "image": f"data:image/png;base64,{b64}",
        })

    return Response(
        content=json.dumps({"plates": plate_images}),
        media_type="application/json",
    )


@app.post("/api/plates-stream")
async def plates_stream_endpoint(
    request: Request,
    image: UploadFile = File(...),
    plates: int = Form(3),
    dust: int = Form(20),
    version: str = Form("v20"),
    upscale: bool = Form(True),
    chroma_boost: float = Form(1.3),
    sigma_s: float = Form(100),
    sigma_r: float = Form(0.5),
    meanshift_sp: int = Form(15),
    meanshift_sr: int = Form(30),
    locked_colors: str | None = Form(None),
):
    """Stream individual plate thumbnails via SSE as they become available."""
    image_bytes = await image.read()
    err = await validate_upload(image_bytes)
    if err is not None:
        return err
    image_bytes = strip_exif(image_bytes)

    rlog = RequestLog("/api/plates-stream")
    rlog.set_client(
        request.headers.get("user-agent", ""),
        request.client.host if request.client else "",
    )
    rlog.set_params(plates=plates, dust=dust, version="v20", upscale=False)

    locked = parse_locked_colors(locked_colors)
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        img.load()
        rlog.set_input(w=img.size[0], h=img.size[1], kb=round(len(image_bytes) / 1024, 1), fmt="PNG")
    except Exception:
        rlog.set_error("Invalid image file")
        rlog.finish(400)
        return JSONResponse(status_code=400, content={"error": "Invalid image file"})

    max_dim = 800
    if max(img.size) > max_dim:
        ratio = max_dim / max(img.size)
        img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)), Image.LANCZOS)

    plates = _clamp(int(plates), PLATES_MIN, SAM_PLATES_MAX)
    arr = np.array(img)

    kwargs: dict = dict(
        n_plates=plates,
        dust_threshold=dust,
        locked_colors=locked,
        return_data=True,
        upscale=False,
        chroma_boost=chroma_boost,
        use_edges=True,
        edge_sigma=1.5,
        shadow_threshold=8,
        highlight_threshold=95,
        median_size=3,
    )

    ok, msg = check_memory_for_sam(n_colors=plates)
    if not ok:
        rlog.set_error(msg)
        rlog.finish(503)
        return JSONResponse(
            status_code=503,
            content={"error": msg, "code": "MEMORY_LOW", "retry_after_seconds": 30, "plates_completed": 0},
            headers={"Retry-After": "30"},
        )

    async def generate():
        loop = asyncio.get_event_loop()

        try:
            async with _heavy_semaphore:
                result = await asyncio.wait_for(
                    loop.run_in_executor(None, lambda: v20.separate(arr, **kwargs)),
                    timeout=SAM_TIMEOUT_SECONDS,
                )

            _meta = result.get("_meta", {})
            rlog.set_sam_info(_meta.get("sam_segment_count", 0), _meta.get("sam_device", "unknown"))

            plate_infos = result["manifest"]["plates"]
            total = len(plate_infos)

            yield f"data: {json.dumps({'type': 'count', 'total': total})}\n\n"

            for idx, plate_info in enumerate(plate_infos):
                name = plate_info["name"]
                plate_data = result["plates"][name]
                buf = io.BytesIO()
                plate_data["image"].save(buf, format="PNG")
                b64 = base64.b64encode(buf.getvalue()).decode("ascii")
                evt = {
                    "type": "plate",
                    "index": idx,
                    "total": total,
                    "name": name,
                    "color": plate_info["color"],
                    "coverage": plate_info.get("coverage_pct", 0),
                    "image": f"data:image/png;base64,{b64}",
                }
                yield f"data: {json.dumps(evt)}\n\n"
                await asyncio.sleep(0)

            yield f"data: {json.dumps({'type': 'done', 'total': total})}\n\n"
            rlog.finish(200)
        except asyncio.TimeoutError:
            _to_msg = f'Processing timed out after {SAM_TIMEOUT_SECONDS}s.'
            rlog.set_error(_to_msg, exc_type="TimeoutError")
            rlog.finish(504)
            yield f"data: {json.dumps({'type': 'error', 'error': _to_msg})}\n\n"
        except Exception as e:
            rlog.set_error(f"{type(e).__name__}: {e}", exc_type=type(e).__name__)
            rlog.finish(500)
            yield f"data: {json.dumps({'type': 'error', 'error': f'{type(e).__name__}: {e}'})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream",
                             background=BackgroundTask(_cleanup_gpu))


@app.post("/api/plates-svg")
async def plates_svg_endpoint(
    image: UploadFile = File(...),
    plates: int = Form(3),
    dust: int = Form(20),
    version: str = Form("v20"),
    upscale: bool = Form(True),
    upscale_scale: int = Form(2),
    chroma_boost: float = Form(1.3),
    shadow_threshold: int = Form(8),
    highlight_threshold: int = Form(95),
    median_size: int = Form(3),
    locked_colors: str | None = Form(None),
    use_edges: bool = Form(True),
    edge_sigma: float = Form(1.5),
    # Accept but ignore these params (needed for buildFormData compatibility)
    n_segments: int = Form(3000),
    compactness: int = Form(15),
    crf_spatial: int = Form(3),
    crf_color: int = Form(13),
    crf_compat: int = Form(10),
    sigma_s: float = Form(100),
    sigma_r: float = Form(0.5),
    meanshift_sp: int = Form(15),
    meanshift_sr: int = Form(30),
    detail_strength: float = Form(0.5),
):
    """Generate high-res SVGs + PNGs for all plates. Returns async job_id for polling."""
    from job_queue import create_job, update_job, JobStatus
    import hashlib as _hl

    image_bytes = await image.read()
    err = await validate_upload(image_bytes)
    if err is not None:
        return err
    image_bytes = strip_exif(image_bytes)

    locked = parse_locked_colors(locked_colors)
    plates = _clamp(int(plates), PLATES_MIN, SAM_PLATES_MAX)
    dust = _clamp(int(dust), DUST_MIN, DUST_MAX)
    upscale_scale = upscale_scale if upscale_scale in (2, 4) else 2
    if not UPSCALE_ENABLED:
        upscale = False

    raw_hash = _hl.sha256(image_bytes).hexdigest()
    cache_key = v20._make_cache_key(raw_hash, plates, dust)

    # Fast path: cached SVG
    if cache_key in v20._svg_cache:
        rlog = RequestLog("/api/plates-svg", request_id=raw_hash[:16])
        rlog.set_cache_hit(hit=True, svg=True)
        rlog.finish(status=200)
        return Response(content=v20._svg_cache[cache_key], media_type="application/json")

    # Slow path: enqueue job
    job_id = create_job()

    async def _run_job():
        rlog = RequestLog("/api/plates-svg", request_id=raw_hash[:16])
        try:
            _probe = Image.open(io.BytesIO(image_bytes))
            rlog.set_input(w=_probe.size[0], h=_probe.size[1],
                           kb=len(image_bytes) / 1024, fmt=_probe.format or "PNG")
        except Exception:
            pass
        rlog.set_params(plates=plates, dust=dust, version="v20",
                        upscale=upscale, upscale_scale=upscale_scale)

        loop = asyncio.get_event_loop()
        try:
            update_job(job_id, JobStatus.RUNNING, progress="separation")

            # Run full v20 separation if not cached
            if cache_key not in v20._separation_cache:
                kwargs = dict(
                    image_bytes=image_bytes, plates=plates, dust=dust,
                    use_edges=use_edges, edge_sigma=edge_sigma,
                    locked_colors=locked, shadow_threshold=shadow_threshold,
                    highlight_threshold=highlight_threshold,
                    median_size=median_size, chroma_boost=chroma_boost,
                    upscale=upscale,
                )
                async with _heavy_semaphore:
                    with rlog.stage("separation"):
                        composite_bytes, manifest = await asyncio.wait_for(
                            loop.run_in_executor(
                                None, lambda: v20.build_preview_response(**kwargs)
                            ),
                            timeout=SAM_TIMEOUT_SECONDS,
                        )
            else:
                rlog.set_cache_hit(hit=True)

            cached = v20._separation_cache.get(cache_key)
            if cached is None:
                raise RuntimeError("Separation cache miss after processing")

            sep_manifest = cached["manifest"]
            h, w = sep_manifest["height"], sep_manifest["width"]

            update_job(job_id, JobStatus.RUNNING, progress="potrace")

            def _build_svgs():
                import base64 as b64mod
                svgs = []
                for plate_info in sep_manifest["plates"]:
                    name = plate_info["name"]
                    plate_data = cached["plates"].get(name, {})
                    mask = plate_data.get("mask")
                    svg = v20.mask_to_svg_string(mask, w, h) if mask is not None else ""
                    png_b64 = ""
                    plate_image = plate_data.get("image")
                    if plate_image is not None:
                        buf = io.BytesIO()
                        plate_image.save(buf, format="PNG", compress_level=1)
                        png_b64 = b64mod.b64encode(buf.getvalue()).decode("ascii")
                    svgs.append({
                        "name": name,
                        "color": plate_info["color"],
                        "svg": svg,
                        "png_b64": png_b64,
                    })
                return svgs

            with rlog.stage("potrace"):
                svgs = await loop.run_in_executor(None, _build_svgs)

            response_json = json.dumps(svgs)
            v20._svg_cache[cache_key] = response_json
            while len(v20._svg_cache) > v20._SVG_CACHE_MAX_ENTRIES:
                oldest = next(iter(v20._svg_cache))
                del v20._svg_cache[oldest]

            rlog.finish(status=200)
            update_job(job_id, JobStatus.DONE, result=response_json.encode())

        except Exception as e:
            rlog.set_error(f"{type(e).__name__}: {e}", type(e).__name__)
            rlog.finish(status=500)
            update_job(job_id, JobStatus.ERROR, error=f"{type(e).__name__}: {e}")
        finally:
            _cleanup_gpu()

    asyncio.create_task(_run_job())
    return JSONResponse({"job_id": job_id, "status": "pending"})


@app.post("/api/auto-optimize")
async def auto_optimize_endpoint(
    image: UploadFile = File(...),
    plates: int = Form(8),
):
    """Trigger auto-optimization. Returns job ID for polling."""
    image_bytes = await image.read()
    err = await validate_upload(image_bytes)
    if err is not None:
        return err
    image_bytes = strip_exif(image_bytes)
    status = auto_optimize.trigger_optimization(image_bytes, initial_plates=plates)
    return Response(
        content=json.dumps(status),
        media_type="application/json",
    )


_JOB_ID_RE = _re.compile(r"^[a-f0-9]{12}$")


@app.get("/api/auto-optimize/{job_id}")
async def auto_optimize_status(job_id: str):
    """Poll auto-optimization status."""
    if not _JOB_ID_RE.match(job_id):
        return JSONResponse(status_code=400, content={"error": "Invalid job ID."})
    status = auto_optimize.get_status(job_id)
    return Response(
        content=json.dumps(status),
        media_type="application/json",
    )
