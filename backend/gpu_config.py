"""
GPU configuration for cloud deployment (RunPod 5090 / any CUDA GPU).
Import this at the top of main.py to override CPU-bound defaults.

Usage: set env var GPU_MODE=1 to activate.
Auth:  set BACKEND_API_KEY env var to require X-API-Key header.
       set GPU_AUTH_PASSWORD for the frontend password gate.
"""
import os

GPU_MODE = os.environ.get("GPU_MODE", "0") == "1"

# ── Authentication ──
# When set, all /api/* requests must include X-API-Key header
BACKEND_API_KEY = os.environ.get("BACKEND_API_KEY", "")
# Password users must enter in the frontend to unlock GPU processing
GPU_AUTH_PASSWORD = os.environ.get("GPU_AUTH_PASSWORD", "")
# Rate limiting (requests per minute per IP)
RATE_LIMIT_PER_MINUTE = int(os.environ.get("RATE_LIMIT_PER_MINUTE", "10" if GPU_MODE else "30"))

if GPU_MODE:
    # ── GPU mode: tuned for RTX 4070 SUPER (12GB VRAM) ──
    # For 5090/A100 (32GB+), increase limits via env vars.

    # Concurrency: 1 for 12GB VRAM (SAM uses most of it)
    HEAVY_SEMAPHORE_LIMIT = int(os.environ.get("HEAVY_SEMAPHORE_LIMIT", "1"))

    # Memory check thresholds
    MEMORY_REQUIRED_CACHED = 1.0      # GB
    MEMORY_REQUIRED_UNCACHED = 2.0    # GB

    # SAM model — env var SAM_WEIGHTS overrides default
    SAM_MODEL = os.environ.get("SAM_WEIGHTS", "sam2.1_t.pt")

    # Force GPU for SAM (don't call .cpu())
    SAM_FORCE_CPU = False

    # Image dimension limits — safe for 12GB VRAM with SAM tiny
    PREVIEW_MAX_DIM = int(os.environ.get("PREVIEW_MAX_DIM", "2000"))
    MERGE_MAX_DIM = int(os.environ.get("MERGE_MAX_DIM", "2000"))
    SEPARATE_MAX_DIM = int(os.environ.get("SEPARATE_MAX_DIM", "4000"))
    UPSCALE_PRE_MAX_DIM = int(os.environ.get("UPSCALE_PRE_MAX_DIM", "1500"))
    UPSCALE_CACHE_MAX_DIM = int(os.environ.get("UPSCALE_CACHE_MAX_DIM", "1500"))

    # Upscaling: 2x for 12GB VRAM (keeps post-upscale under 3000x3000)
    UPSCALE_ENABLED = True
    UPSCALE_SCALE = int(os.environ.get("UPSCALE_SCALE", "2"))

    # PIL pixel limit
    MAX_IMAGE_PIXELS = 50_000_000

    # Uvicorn workers
    WORKERS = int(os.environ.get("WORKERS", "1"))

else:
    # ── Local/CPU defaults (your 16GB desktop) ──
    HEAVY_SEMAPHORE_LIMIT = 1
    MEMORY_REQUIRED_CACHED = 4.0
    MEMORY_REQUIRED_UNCACHED = 11.0
    SAM_MODEL = os.environ.get("SAM_WEIGHTS", "sam2.1_t.pt")
    SAM_FORCE_CPU = True
    PREVIEW_MAX_DIM = 1500
    MERGE_MAX_DIM = 1500
    SEPARATE_MAX_DIM = 4000
    UPSCALE_PRE_MAX_DIM = 1500
    UPSCALE_CACHE_MAX_DIM = 1000
    UPSCALE_ENABLED = False  # v20 upscale off on 16GB
    UPSCALE_SCALE = int(os.environ.get("UPSCALE_SCALE", "2"))
    MAX_IMAGE_PIXELS = 50_000_000
    WORKERS = 2
