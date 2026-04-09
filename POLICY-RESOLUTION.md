# Resolution Policy — Color.separator Alpha

## Directive
Full resolution output always. Never downscale. Never compress unless it would literally crash the server (OOM kill). Processing time is not a constraint — if it takes 5 minutes, it takes 5 minutes.

## What This Means

### Preview (interactive)
- Cap at PREVIEW_MAX_DIM for interactive preview ONLY (memory safety for SAM)
- Preview is a preview — lower res is acceptable here
- User sees fast feedback at preview resolution

### Output (ZIP download, plates-svg)
- ALWAYS original resolution or upscaled resolution
- Never cap potrace input resolution
- Never cap PNG output resolution
- If 5120x2712 input → 5120x2712 output (native) or 10240x5424 (2x) or 20480x10848 (4x)
- PNG compress_level=1 (fast, minimal compression, maximum quality)
- SVG viewBox must match actual output dimensions

### Upscale
- 2x and 4x produce exactly that multiplier on the original input
- No post-upscale cap (remove UPSCALE_CACHE_MAX_DIM constraint on output)
- If 4x on 5120x2712 = 20480x10848, so be it
- OOM is the only valid reason to refuse — return 503 with clear message

### Potrace
- Run at full output resolution
- No resolution cap on potrace input
- If it takes 120s, it takes 120s
- Queue-based architecture handles the timeout (no Cloudflare 100s issue)

### What IS acceptable to limit
- Preview resolution (interactive speed matters)
- Concurrent requests (semaphore=1 for GPU, prevents OOM)
- Total image pixel count (50M pixels — prevents malicious inputs)
- Memory guard (503 if RAM would OOM)

### What is NOT acceptable
- Downscaling output to save time
- Reducing potrace resolution for speed
- Compressing PNGs beyond level=1
- Capping post-upscale dimensions
- Silently falling back to lower resolution
