#!/usr/bin/env python3
"""
Woodblock color separation V20 — SAM + guided filter + diff-based hole correction.

Uses SAM2.1 to segment the image into objects FIRST, then runs K-means
within each object region independently. This prevents similar-colored
objects from merging.
"""
import argparse
import hashlib
import io
import json
import os
import tempfile
import zipfile
from concurrent.futures import ThreadPoolExecutor

import gc

import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import label as ndlabel
from scipy.spatial.distance import cdist
from skimage.color import rgb2lab, lab2rgb, deltaE_ciede2000
from svg_generator import (
    mask_to_svg,
    mask_to_svg as mask_to_svg_string,
    mask_to_svg as mask_to_cnc_svg_string,
    mask_to_svg_legacy as mask_to_svg_string_legacy,
    mask_to_svg_file,
)
from sklearn.cluster import MiniBatchKMeans
from shared_cache import LRUCache


_upscale_cache = LRUCache(maxsize=5)

# ── Separation result cache for fast merge ──
# Pixel data: large numpy arrays. Keep 3 (memory constraint).
_separation_cache: dict = {}
_CACHE_MAX_ENTRIES = 3  # Keep last 3 separations (large numpy arrays; 3 is safe)

# SVG strings: small JSON (~50-2000KB). Keep 10 (cheap).
_svg_cache: dict = {}
_SVG_CACHE_MAX_ENTRIES = 10

# ── ESRGAN model cache: keyed by (scale, weights_path) ──
# Avoids rebuilding RRDBNet + loading weights on every request (~2-3s overhead).
_esrgan_upsampler_cache: dict = {}


def _image_hash(image_bytes: bytes) -> str:
    return hashlib.sha256(image_bytes[:4096]).hexdigest()


def _make_cache_key(image_bytes_or_hash: "str | bytes", n_plates: int, dust: int) -> str:
    """Resolution-independent cache key derived from raw image file bytes."""
    if isinstance(image_bytes_or_hash, (bytes, bytearray)):
        h = hashlib.sha256(image_bytes_or_hash).hexdigest()
    else:
        h = image_bytes_or_hash
    return f"{h}_{n_plates}_{dust}"


def upscale_2x(arr: np.ndarray, scale: int = None) -> tuple[np.ndarray, bool]:
    """Run Real-ESRGAN on an RGB numpy array. Returns (result, success).
    scale: 2 or 4. Defaults to gpu_config.UPSCALE_SCALE.
    Model is cached in _esrgan_upsampler_cache after first load."""
    try:
        if scale is None:
            from gpu_config import UPSCALE_SCALE
            scale = UPSCALE_SCALE
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            gc.collect()
        from basicsr.archs.rrdbnet_arch import RRDBNet
        from realesrgan import RealESRGANer

        if scale == 4:
            weights_name = "RealESRGAN_x4plus.pth"
        else:
            weights_name = "RealESRGAN_x2plus.pth"
            scale = 2  # normalize

        weights_path = os.path.join(os.path.dirname(__file__), "weights", weights_name)
        if not os.path.exists(weights_path):
            # Fallback to 2x if 4x weights missing
            if scale == 4:
                weights_path = os.path.join(os.path.dirname(__file__), "weights", "RealESRGAN_x2plus.pth")
                scale = 2
                if not os.path.exists(weights_path):
                    return arr, False
            else:
                return arr, False

        cache_key = (scale, weights_path)
        if cache_key not in _esrgan_upsampler_cache:
            model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=scale)
            # tile=512 reduces tile-boundary overhead on 12GB VRAM vs default 256
            upsampler = RealESRGANer(
                scale=scale, model_path=weights_path, model=model,
                half=torch.cuda.is_available(),
                device="cuda" if torch.cuda.is_available() else "cpu",
                tile=512, tile_pad=10
            )
            _esrgan_upsampler_cache[cache_key] = upsampler

        upsampler = _esrgan_upsampler_cache[cache_key]
        bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
        output, _ = upsampler.enhance(bgr, outscale=scale)
        result = cv2.cvtColor(output, cv2.COLOR_BGR2RGB)
        # Do NOT del upsampler — it is now cached for reuse
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        gc.collect()
        return result, True
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"Upscale failed: {e}")
        return arr, False


def upscale_and_cache(image_bytes: bytes, scale: int = None) -> tuple[str, bool, bool]:
    """Upscale image and store in cache. Returns (hash, cached, success)."""
    img_hash = _image_hash(image_bytes)
    if img_hash in _upscale_cache:
        return img_hash, True, True
    arr = np.array(Image.open(io.BytesIO(image_bytes)).convert('RGB'))
    upscaled, success = upscale_2x(arr, scale=scale)
    if success:
        _upscale_cache[img_hash] = upscaled
    return img_hash, False, success


# ── SAM model cache ──
_sam_model = None


def get_sam_model():
    global _sam_model
    if _sam_model is None:
        import torch
        from gpu_config import SAM_MODEL, SAM_FORCE_CPU
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            gc.collect()
        from ultralytics import SAM
        _sam_model = SAM(SAM_MODEL)
        if SAM_FORCE_CPU:
            _sam_model.model.cpu()
        # else: SAM stays on CUDA (auto-detected)
    return _sam_model


def release_sam():
    """No-op — keep SAM cached in RAM for subsequent requests.
    Loading SAM is the expensive part (~2GB, ~3s). Once loaded,
    reuse is cheap. On 16GB machines, releasing + reloading each
    request causes repeated OOM spikes."""
    pass


def release_upscaler(free_model: bool = False):
    """Free upscale result cache to reclaim RAM.
    free_model=True also evicts the cached ESRGAN model from VRAM (use only when shutting down
    or before loading a large model that cannot coexist with ESRGAN weights).
    By default the model stays cached so subsequent requests skip model load (~2s)."""
    global _upscale_cache, _esrgan_upsampler_cache
    _upscale_cache = LRUCache(maxsize=5)
    if free_model:
        _esrgan_upsampler_cache.clear()
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def connected_component_cleanup(labels, n_plates, dust_threshold=150):
    """
    For each plate, find connected components. Components smaller than
    dust_threshold get absorbed into the most common neighboring plate.
    Optimized: batch all small components per plate using morphological dilation.
    """
    h, w = labels.shape

    for plate_id in range(n_plates):
        mask = labels == plate_id
        labeled, n_comp = ndlabel(mask)
        if n_comp <= 1:
            continue

        comp_sizes = np.bincount(labeled.ravel())
        small_mask = np.zeros_like(mask)
        for comp_id in range(1, len(comp_sizes)):
            if comp_sizes[comp_id] < dust_threshold:
                small_mask |= (labeled == comp_id)

        if not np.any(small_mask):
            continue

        kernel = np.ones((5, 5), np.uint8)
        temp_labels = labels.copy()
        temp_labels[small_mask] = -1

        for _ in range(3):
            dilated = cv2.dilate(
                (temp_labels + 1).astype(np.uint16),
                kernel
            ).astype(np.int32) - 1
            still_empty = temp_labels == -1
            temp_labels[still_empty] = dilated[still_empty]

        labels[small_mask] = temp_labels[small_mask]
        labels[labels == -1] = plate_id

    return labels


def separate(input_path_or_array, output_dir=None, n_plates=4, dust_threshold=150,
             use_edges=True, edge_sigma=1.5,
             locked_colors=None, return_data=False,
             chroma_boost=1.3,
             shadow_threshold=8, highlight_threshold=95,
             median_size=3,
             upscale=True, img_hash=None,
             upscale_scale=None,
             progress_callback=None,
             cache_hash: "str | None" = None):
    """
    V15 separation: SAM segmentation -> per-region K-means -> Canny edges -> CC cleanup.
    """
    def report(stage, pct):
        if progress_callback:
            progress_callback(stage, pct)

    # Load image
    if isinstance(input_path_or_array, str):
        img = Image.open(input_path_or_array).convert("RGB")
        arr = np.array(img)
    else:
        arr = input_path_or_array
        img = Image.fromarray(arr)

    # ── Step 0: Optional Real-ESRGAN upscale ──
    from gpu_config import UPSCALE_SCALE
    _effective_scale = upscale_scale if upscale_scale in (2, 4) else UPSCALE_SCALE
    report(f"Upscaling image ({_effective_scale}×)", 5)
    was_upscaled = False
    if upscale:
        if img_hash and img_hash in _upscale_cache:
            arr = _upscale_cache[img_hash]
            img = Image.fromarray(arr)
            was_upscaled = True
        else:
            upscaled_arr, success = upscale_2x(arr, scale=upscale_scale)
            if success:
                arr = upscaled_arr
                img = Image.fromarray(arr)
                was_upscaled = True

        release_upscaler(free_model=False)  # Flush inference activations; keep model cached for next request

    h, w = arr.shape[:2]

    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    # ── Step 0.5: Line-aware pre-pass — detect thin dark strokes ──
    report("Detecting strokes", 15)
    # Convert to grayscale and find dark strokes (signatures, text, fine linework)
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)

    # Adaptive threshold to find dark marks on lighter background
    # Block size 31 catches both fine pen strokes and printed text
    adaptive_thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 8
    )

    # Also catch mid-tone strokes (signatures are often not pure black)
    # Use a global threshold relative to the median background
    # Use median of non-white pixels (the card, not surrounding white)
    card_pixels = gray[gray < 240]
    bg_median = np.median(card_pixels) if len(card_pixels) > 0 else np.median(gray)
    dark_global = (gray < bg_median * 0.85).astype(np.uint8) * 255

    # Also detect via local contrast (catches faint signatures on colored backgrounds)
    gray_float = gray.astype(np.float32)
    local_mean = cv2.blur(gray_float, (51, 51))
    local_contrast = local_mean - gray_float  # positive = darker than surroundings
    local_contrast_mask = (local_contrast > 8).astype(np.uint8) * 255

    # Combine all detections
    stroke_mask = ((adaptive_thresh > 0) | (dark_global > 0) | (local_contrast_mask > 0)).astype(np.uint8)

    # Clean up: remove very large regions (those are color areas, not strokes)
    # Keep only thin structures via morphological opening
    thin_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 1))
    stroke_mask = cv2.morphologyEx(stroke_mask, cv2.MORPH_OPEN, thin_kernel)

    # Dilate slightly to capture full stroke width
    dilate_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    stroke_mask = cv2.dilate(stroke_mask, dilate_kernel, iterations=1)

    # Remove large connected components (> 2% of image = not a stroke)
    from scipy.ndimage import label as ndlabel_func
    labeled_strokes, n_stroke_comps = ndlabel_func(stroke_mask)
    if n_stroke_comps > 0:
        comp_sizes = np.bincount(labeled_strokes.ravel())[1:]
        max_stroke_size = h * w * 0.02  # 2% threshold
        # Vectorized: find all oversized component IDs at once, zero them in one mask op
        large_ids = np.where(comp_sizes > max_stroke_size)[0] + 1  # +1: comp IDs are 1-indexed
        if large_ids.size > 0:
            stroke_mask[np.isin(labeled_strokes, large_ids)] = 0

    stroke_mask_bool = stroke_mask.astype(bool)

    # ── Step 1: SAM segmentation ──
    report("Segmenting objects (SAM)", 25)
    import torch
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        gc.collect()
    model = get_sam_model()

    # Save image to temp file for SAM
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
        Image.fromarray(arr).save(f.name)
        temp_path = f.name

    # Grid of points for segmentation — balanced density
    step = max(50, min(h, w) // 18)
    points = []
    for y in range(step // 2, h - step // 2, step):
        for x in range(step // 2, w - step // 2, step):
            points.append([x, y])
    points_arr = np.array(points)
    labels_arr = np.ones(len(points_arr))

    try:
        import torch as _torch_sam
        # Dynamic GPU/CPU decision: large images with many points OOM the 12GB GPU.
        # Heuristic: if image_pixels * num_points > threshold, use CPU for SAM.
        _num_points = len(points_arr)
        _img_pixels = h * w
        # SAM2.1 tiny uses ~3-4GB VRAM regardless of point count (batched).
        # Actual limit is image size: 4000x4000 fp16 ≈ 120MB tensor + ~3GB model.
        # 12GB GPU handles up to ~20M pixels comfortably (e.g. 4500x4500).
        _sam_gpu_threshold = 10_000_000_000  # 10B — allows 4000x4000 @ 500+ points on 12GB
        _sam_cost = _img_pixels * _num_points
        if _torch_sam.cuda.is_available() and _sam_cost < _sam_gpu_threshold:
            _sam_device = "cuda"
        else:
            _sam_device = "cpu"
            if _torch_sam.cuda.is_available():
                print(f"SAM using CPU (cost={_sam_cost:.0f} > threshold={_sam_gpu_threshold}, "
                      f"img={w}x{h}, points={_num_points})")
                _torch_sam.cuda.empty_cache()
        results = model(temp_path, points=points_arr, labels=labels_arr, device=_sam_device)
        masks = results[0].masks.data.cpu().numpy()
        del results
        gc.collect()
    except (RuntimeError, Exception) as e:
        print(f"SAM failed ({e}), falling back to single-region mode")
        masks = np.ones((1, h, w), dtype=bool)
    finally:
        os.unlink(temp_path)
        release_sam()  # Free GPU for ESRGAN

    # ── Step 2: Merge overlapping/small SAM masks into coherent regions ──
    report("Merging regions", 40)
    region_map = np.zeros((h, w), dtype=np.int32)
    mask_areas = [(i, m.sum()) for i, m in enumerate(masks)]
    mask_areas.sort(key=lambda x: x[1], reverse=True)  # largest first

    for mask_idx, area in mask_areas:
        mask = masks[mask_idx]
        if mask.shape != (h, w):
            mask = np.array(Image.fromarray(mask.astype(np.uint8) * 255).resize((w, h))) > 128
        unclaimed = region_map == 0
        region_map[mask & unclaimed] = mask_idx + 1

    # Fill unclaimed pixels — use color similarity to nearest claimed pixel
    if np.any(region_map == 0):
        # First pass: small kernel dilation (3x3) to fill thin gaps
        kernel_small = np.ones((3, 3), np.uint8)
        filled = region_map.copy()
        for _ in range(20):  # more passes with smaller kernel = finer fill
            dilated = cv2.dilate(filled.astype(np.uint16), kernel_small).astype(np.int32)
            still_empty = filled == 0
            if not np.any(still_empty):
                break
            filled[still_empty] = dilated[still_empty]
        # Second pass: larger kernel for any remaining
        if np.any(filled == 0):
            kernel_large = np.ones((7, 7), np.uint8)
            for _ in range(5):
                dilated = cv2.dilate(filled.astype(np.uint16), kernel_large).astype(np.int32)
                still_empty = filled == 0
                if not np.any(still_empty):
                    break
                filled[still_empty] = dilated[still_empty]
        region_map = filled

    # ── Step 2.5: Split SAM regions by color saturation ──
    # If a SAM region contains both high-sat (colored) and low-sat (neutral) pixels,
    # split it into two sub-regions so K-means doesn't mix them
    hsv_split = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
    sat_split = hsv_split[:, :, 1]

    next_region_id = region_map.max() + 1
    for region_id in np.unique(region_map):
        if region_id == 0:
            continue
        region_mask = region_map == region_id
        region_sats = sat_split[region_mask]

        # Check if this region has BOTH high-sat and low-sat pixels
        high_sat_count = np.sum(region_sats > 70)
        low_sat_count = np.sum(region_sats <= 70)
        total = len(region_sats)

        # Only split if both groups are significant (>15% each)
        if high_sat_count > total * 0.15 and low_sat_count > total * 0.15:
            # Split: high-sat pixels get a new region ID
            high_sat_mask = region_mask & (sat_split > 70)
            region_map[high_sat_mask] = next_region_id
            next_region_id += 1

    unique_regions = np.unique(region_map)
    unique_regions = unique_regions[unique_regions > 0]
    n_sam_masks = len(masks)

    # ── Step 3: Per-region K-means clustering ──
    report("Clustering colors", 50)
    arr_float = arr.astype(np.float64) / 255.0
    lab_img = rgb2lab(arr_float)
    lab_boosted = lab_img.copy()
    lab_boosted[:, :, 1] *= chroma_boost
    lab_boosted[:, :, 2] *= chroma_boost

    lab_flat = lab_boosted.reshape(-1, 3)

    max_samples = 80000
    if len(lab_flat) > max_samples:
        indices = np.random.RandomState(42).choice(len(lab_flat), max_samples, replace=False)
        sample = lab_flat[indices]
    else:
        sample = lab_flat

    # Handle locked colors
    init = "k-means++"
    if locked_colors and len(locked_colors) > 0:
        locked_rgb = np.array(locked_colors, dtype=np.float64).reshape(-1, 1, 3) / 255.0
        locked_lab = rgb2lab(locked_rgb).reshape(-1, 3)
        locked_lab[:, 1] *= chroma_boost
        locked_lab[:, 2] *= chroma_boost
        if len(locked_lab) == n_plates:
            init = locked_lab
        elif len(locked_lab) < n_plates:
            remaining = n_plates - len(locked_lab)
            random_indices = np.random.RandomState(42).choice(len(sample), remaining, replace=False)
            extra_centroids = sample[random_indices]
            init = np.vstack([locked_lab, extra_centroids])
        else:
            init = locked_lab[:n_plates]

    kmeans = MiniBatchKMeans(
        n_clusters=n_plates,
        init=init,
        random_state=42,
        n_init=3 if isinstance(init, str) else 1,
        batch_size=min(10000, len(sample)),
        max_iter=100,
    )
    kmeans.fit(sample)

    palette_lab_boosted = kmeans.cluster_centers_

    # Now assign pixels using color distance within SAM regions
    pixel_labels = np.zeros((h, w), dtype=np.int32)

    # Pre-compute centroid properties
    palette_lab_for_check = palette_lab_boosted.copy()
    palette_lab_for_check[:, 1] /= chroma_boost
    palette_lab_for_check[:, 2] /= chroma_boost
    centroid_chroma = np.sqrt(palette_lab_for_check[:, 1]**2 + palette_lab_for_check[:, 2]**2)

    hsv_assign = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
    sat_assign = hsv_assign[:, :, 1]

    # ── Vectorized region assignment ──
    # Compute all pixel-to-centroid distances in one shot (avoids repeated cdist per region).
    # Then apply per-region centroid blocking as a secondary correction pass.
    lab_flat_all = lab_boosted.reshape(-1, 3)
    all_dists = cdist(lab_flat_all, palette_lab_boosted, metric='sqeuclidean')  # (H*W, n_plates)

    # Default assignment: nearest centroid globally
    pixel_labels_flat = np.argmin(all_dists, axis=1)

    # Correction pass: for colored regions, block neutral centroids (chroma < 8)
    neutral_centroids = np.where(centroid_chroma < 8)[0]  # centroid indices to block
    if neutral_centroids.size > 0:
        # Build a mean-saturation map per pixel to identify colored-region pixels
        # Use region_map to mark which pixels are in a colored region
        colored_region_ids = []
        for region_id in unique_regions:
            region_mask = region_map == region_id
            region_sats = sat_assign[region_mask]
            if len(region_sats) > 0 and np.mean(region_sats) > 60:
                colored_region_ids.append(region_id)

        if colored_region_ids:
            colored_pixel_mask = np.isin(region_map, colored_region_ids).ravel()  # (H*W,)
            # For colored pixels, set distances to neutral centroids to inf, recompute argmin
            blocked_dists = all_dists[colored_pixel_mask].copy()
            blocked_dists[:, neutral_centroids] = np.inf
            pixel_labels_flat[colored_pixel_mask] = np.argmin(blocked_dists, axis=1)
            del blocked_dists

    pixel_labels = pixel_labels_flat.reshape(h, w).astype(np.int32)
    del all_dists, lab_flat_all, pixel_labels_flat

    # ── Step 4: Guided filter (neutral plates only) + morphological cleanup ──
    report("Smoothing plates", 65)
    # Apply guided filter ONLY to neutral/background plates to fill holes
    # Leave colored plates (red, blue, etc) untouched to preserve thin features
    from cv2.ximgproc import guidedFilter

    guide = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0

    palette_lab_gf = palette_lab_boosted.copy()
    palette_lab_gf[:, 1] /= chroma_boost
    palette_lab_gf[:, 2] /= chroma_boost
    centroid_chroma_gf = np.sqrt(palette_lab_gf[:, 1]**2 + palette_lab_gf[:, 2]**2)

    # Build soft plate scores, but only guided-filter the neutral ones.
    # Neutral plates are processed in parallel (guidedFilter is CPU-bound and thread-safe).
    plate_scores = np.zeros((n_plates, h, w), dtype=np.float32)
    _partial_results = False
    _plates_completed = 0
    try:
        import torch as _torch
        _has_torch = True
    except ImportError:
        _has_torch = False

    def _process_plate(plate_id):
        """Compute plate score for one plate. Returns (plate_id, score_array)."""
        mask_float = (pixel_labels == plate_id).astype(np.float32)
        if centroid_chroma_gf[plate_id] < 15:  # neutral plate — safe to smooth
            score = guidedFilter(guide, mask_float, radius=3, eps=0.04)
        else:  # colored plate — keep raw to preserve thin features
            score = mask_float
        return plate_id, score

    try:
        # Use up to 4 threads — guidedFilter releases GIL for most of its C++ work
        n_workers = min(n_plates, 4)
        with ThreadPoolExecutor(max_workers=n_workers) as pool:
            futures = [pool.submit(_process_plate, pid) for pid in range(n_plates)]
            for future in futures:
                pid, score = future.result()
                plate_scores[pid] = score
                _plates_completed += 1
                report(f"Processing plate {pid+1}/{n_plates}", 50 + int(40 * pid / n_plates))
        # Flush VRAM once after all plates done
        if _has_torch and _torch.cuda.is_available():
            if _torch.cuda.memory_reserved() > 10 * 1024 ** 3:
                _torch.cuda.empty_cache()
                gc.collect()
    except (MemoryError, Exception) as _plate_err:
        _is_oom = isinstance(_plate_err, MemoryError)
        try:
            import torch as _torch_oom
            _is_oom = _is_oom or isinstance(_plate_err, _torch_oom.cuda.OutOfMemoryError)
        except (ImportError, AttributeError):
            pass
        if _is_oom:
            gc.collect()
            if _has_torch and _torch.cuda.is_available():
                _torch.cuda.empty_cache()
            _partial_results = True
            # Zero out any plates that didn't complete
            for _remaining in range(_plates_completed, n_plates):
                plate_scores[_remaining] = 0.0
        else:
            raise

    # Re-assign pixels based on highest score
    pixel_labels = np.argmax(plate_scores, axis=0).astype(np.int32)
    del plate_scores

    # Morphological closing for remaining tiny holes
    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    for plate_id in range(n_plates):
        mask = (pixel_labels == plate_id).astype(np.uint8)
        closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, close_kernel, iterations=1)
        fill_candidates = (closed > 0) & (mask == 0)
        pixel_labels[fill_candidates] = plate_id

    # ── Step 4.5: Two-pass stroke fill + color protection ──
    report("Filling strokes", 75)
    hsv_pp = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
    hue_pp = hsv_pp[:, :, 0]
    sat_pp = hsv_pp[:, :, 1]
    val_pp = hsv_pp[:, :, 2]

    palette_lab_pp = palette_lab_boosted.copy()
    palette_lab_pp[:, 1] /= chroma_boost
    palette_lab_pp[:, 2] /= chroma_boost
    darkest_plate = int(np.argmin(palette_lab_pp[:, 0]))
    reddest_plate = int(np.argmax(palette_lab_pp[:, 1]))
    centroid_chroma_pp = np.sqrt(palette_lab_pp[:, 1]**2 + palette_lab_pp[:, 2]**2)

    # PASS 1: Fill dark strokes — but ONLY if the pixel ITSELF is low-saturation
    # This is the key insight: dark strokes (signatures, text) have low saturation
    # Colored illustration pixels have high saturation even when dark
    # So pixel saturation is the discriminator, not neighborhood saturation
    fill_mask = stroke_mask_bool & (gray < bg_median * 0.85) & (sat_pp < 100)
    pixel_labels[fill_mask] = darkest_plate

    # PASS 2: Fix red-hue pixels stuck on neutral plates
    red_hue = ((hue_pp < 15) | (hue_pp > 165)) & (sat_pp > 80) & (val_pp > 50)
    for plate_id in range(n_plates):
        if centroid_chroma_pp[plate_id] < 10:
            fix_mask = red_hue & (pixel_labels == plate_id)
            pixel_labels[fix_mask] = reddest_plate

    # ── Step 5: Canny edge assignment ──
    report("Detecting edges", 82)
    if use_edges:
        from skimage.color import rgb2gray
        from skimage.feature import canny
        from scipy.ndimage import binary_dilation

        # Get palette_lab for brightness ordering
        palette_lab = palette_lab_boosted.copy()
        palette_lab[:, 1] /= chroma_boost
        palette_lab[:, 2] /= chroma_boost

        gray = rgb2gray(arr)
        edges = canny(gray, sigma=edge_sigma, low_threshold=0.04, high_threshold=0.12)
        edges = binary_dilation(edges, iterations=1)

        # ── Vectorized edge assignment ──
        # Instead of a per-pixel Python loop, use morphological dilation:
        # For each plate (darkest first), dilate its mask into edge pixels.
        # Darker plates overwrite lighter ones, replicating "assign darkest nearby plate".
        palette_brightness = np.array([palette_lab[p][0] for p in range(n_plates)])
        brightness_order_edges = np.argsort(palette_brightness)[::-1]  # lightest → darkest

        edge_mask = edges.astype(np.uint8)
        dilate_k = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))  # 7x7 covers ±3 neighborhood
        for plate_id in brightness_order_edges:
            plate_mask = (pixel_labels == plate_id).astype(np.uint8)
            dilated = cv2.dilate(plate_mask, dilate_k)
            # Assign this plate to edge pixels that are covered by its dilation
            pixel_labels[edges & (dilated > 0)] = plate_id
        # Darker plates run last and overwrite lighter ones — same semantics as original loop

    # ── Step 6: CC cleanup ──
    report("Correcting holes", 88)
    pixel_labels = connected_component_cleanup(pixel_labels, n_plates, dust_threshold)

    # ── Step 7: Get palette RGB ──
    palette_lab = palette_lab_boosted.copy()
    palette_lab[:, 1] /= chroma_boost
    palette_lab[:, 2] /= chroma_boost

    palette_rgb_float = lab2rgb(palette_lab.reshape(-1, 1, 3)).reshape(-1, 3)
    palette_rgb = np.clip(palette_rgb_float * 255, 0, 255).astype(np.uint8)

    # ── Step 8: Extract and clean individual plates ──
    report("Cleaning up", 95)
    brightness_order = np.argsort([c[0] for c in palette_lab])

    results_list = []
    plate_images = {}

    for rank, idx in enumerate(brightness_order):
        mask = pixel_labels == idx
        coverage = np.sum(mask) / mask.size * 100
        rgb = palette_rgb[idx]
        name = f"plate{rank + 1}"

        binary = np.where(mask, 0, 255).astype(np.uint8)
        plate_img = Image.fromarray(binary)

        plate_info = {
            "name": name,
            "index": int(idx),
            "rank": rank + 1,
            "color": [int(rgb[0]), int(rgb[1]), int(rgb[2])],
            "color_hex": f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}",
            "coverage_pct": round(coverage, 2),
        }
        results_list.append(plate_info)
        plate_images[name] = {"mask": mask, "binary": binary, "image": plate_img}

    # ── Step 8.8: Micro-hole fill ──
    # Fill 1-2px isolated pixels that don't match their neighbors
    # If a pixel's 4-connected neighbors are all the same plate, adopt that plate
    for _ in range(1):  # single pass
        padded = np.pad(pixel_labels, 1, mode='edge')
        up = padded[:-2, 1:-1]
        down = padded[2:, 1:-1]
        left = padded[1:-1, :-2]
        right = padded[1:-1, 2:]
        # Where all 4 neighbors agree but center disagrees
        neighbors_agree = (up == down) & (down == left) & (left == right)
        center_disagrees = pixel_labels != up
        fix = neighbors_agree & center_disagrees
        pixel_labels[fix] = up[fix]

    # Update plate masks from fixed labels
    for plate_info in results_list:
        idx = plate_info["index"]
        name = plate_info["name"]
        mask = pixel_labels == idx
        plate_images[name]["mask"] = mask
        plate_images[name]["binary"] = np.where(mask, 0, 255).astype(np.uint8)
        plate_images[name]["image"] = Image.fromarray(plate_images[name]["binary"])

    # ── Step 9: Composite preview ──
    comp = np.ones((h, w, 3), dtype=np.uint8) * 255
    for plate_info in reversed(results_list):
        name = plate_info["name"]
        mask = plate_images[name]["mask"]
        rgb_val = plate_info["color"]
        comp[mask] = rgb_val

    composite_img = Image.fromarray(comp)

    # ── Step 9.5: Diff-based hole filling ──
    # Compare composite to original image — where they differ significantly,
    # copy original pixels into the composite. This fills holes while preserving
    # the plate color assignments for everything else.
    if isinstance(input_path_or_array, str):
        orig_for_diff = np.array(Image.open(input_path_or_array).convert("RGB"))
    else:
        orig_for_diff = input_path_or_array.copy()

    # Resize original to match composite if upscaling changed dimensions
    if orig_for_diff.shape[:2] != comp.shape[:2]:
        orig_for_diff = np.array(Image.fromarray(orig_for_diff).resize((comp.shape[1], comp.shape[0]), Image.LANCZOS))

    # Compute per-pixel color distance
    diff_vec = comp.astype(np.float32) - orig_for_diff.astype(np.float32)
    diff_mag = np.sqrt(np.sum(diff_vec**2, axis=2))

    # Where difference is large (>100), the composite is wrong — copy from original
    # But quantize the copied pixel to the nearest plate color
    high_diff = diff_mag > 130
    if np.any(high_diff):
        # For each high-diff pixel, find nearest plate color and assign it
        high_diff_pixels = orig_for_diff[high_diff].astype(np.float64) / 255.0
        high_diff_lab = rgb2lab(high_diff_pixels.reshape(-1, 1, 3)).reshape(-1, 3)
        high_diff_lab[:, 1] *= chroma_boost
        high_diff_lab[:, 2] *= chroma_boost

        dists_fix = cdist(high_diff_lab, palette_lab_boosted, metric='sqeuclidean')
        fixed_labels = np.argmin(dists_fix, axis=1)

        # Update pixel_labels and recomposite
        pixel_labels[high_diff] = fixed_labels

        # Rebuild composite with fixed labels
        comp = np.ones((h, w, 3), dtype=np.uint8) * 255
        for plate_info in reversed(results_list):
            name = plate_info["name"]
            mask = pixel_labels == plate_info["index"]
            rgb_val = plate_info["color"]
            comp[mask] = rgb_val

        composite_img = Image.fromarray(comp)  # rebuild after fix

        # Update plate_images masks to match fixed pixel_labels
        for plate_info in results_list:
            idx = plate_info["index"]
            name = plate_info["name"]
            mask = pixel_labels == idx
            plate_images[name]["mask"] = mask
            plate_images[name]["binary"] = np.where(mask, 0, 255).astype(np.uint8)
            plate_images[name]["image"] = Image.fromarray(plate_images[name]["binary"])

    # ── Step 10: Merge suggestions ──
    merge_suggestions = []
    for i in range(len(palette_lab)):
        for j in range(i + 1, len(palette_lab)):
            delta_e = deltaE_ciede2000(
                palette_lab[i].reshape(1, 1, 3),
                palette_lab[j].reshape(1, 1, 3)
            ).item()
            if 2.0 < delta_e < 15:
                merge_suggestions.append({
                    'plate_a': int(i),
                    'plate_b': int(j),
                    'delta_e': round(float(delta_e), 1)
                })

    # ── Step 11: Manifest ──
    manifest = {
        "width": w,
        "height": h,
        "num_plates": n_plates,
        "plates": results_list,
        "paper_pct": round(100.0 - sum(p["coverage_pct"] for p in results_list), 2),
        "version": "v20",
        "upscaled": was_upscaled,
        "upscale_scale": UPSCALE_SCALE if was_upscaled else None,
        "merge_suggestions": merge_suggestions,
        "sam_masks": n_sam_masks,
        "partial_results": _partial_results,
        "plates_completed": _plates_completed if _partial_results else n_plates,
    }

    if return_data:
        result = {
            "composite": composite_img,
            "plates": plate_images,
            "manifest": manifest,
            "palette_rgb": palette_rgb,
            "pixel_labels": pixel_labels,
            "_meta": {
                "sam_segment_count": len(masks),
                "sam_device": _sam_device,
            },
        }
        # Cache for merge reuse — avoids re-running full SAM pipeline on merge.
        # Prefer cache_hash (raw image bytes hash = resolution-independent) so that
        # build_preview_response (2000px) and build_merge_response share the same key.
        # Fall back to pixel-array hash if no cache_hash was supplied.
        if cache_hash is not None:
            _ck = _make_cache_key(cache_hash, n_plates, dust_threshold)
        else:
            _ck = hashlib.sha256(arr.tobytes()).hexdigest() + f"_{n_plates}_{dust_threshold}"
        _separation_cache[_ck] = {
            "pixel_labels": pixel_labels,
            "palette_rgb": palette_rgb,
            "manifest": manifest,
            "composite": composite_img,
            "plates": plate_images,
        }
        while len(_separation_cache) > _CACHE_MAX_ENTRIES:
            oldest = next(iter(_separation_cache))
            del _separation_cache[oldest]
        return result

    # Save files
    composite_img.save(os.path.join(output_dir, "composite.png"))

    for plate_info in results_list:
        name = plate_info["name"]
        plate_images[name]["image"].save(os.path.join(output_dir, f"{name}.png"))

        mask = plate_images[name]["mask"]
        svg_path = os.path.join(output_dir, f"{name}.svg")
        mask_to_svg_file(mask, svg_path, w, h)

    with open(os.path.join(output_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    return manifest


def apply_merge(pixel_labels, palette_rgb, merge_pairs, n_plates):
    """Apply merge operations."""
    labels = pixel_labels.copy()
    for plate_a, plate_b in merge_pairs:
        labels[labels == plate_a] = plate_b
    return labels


def build_preview_response(image_bytes, plates=4, dust=50,
                           locked_colors=None,
                           chroma_boost=1.3,
                           use_edges=True, edge_sigma=1.5,
                           shadow_threshold=8, highlight_threshold=95,
                           median_size=3,
                           upscale=True, img_hash=None,
                           upscale_scale=None,
                           progress_callback=None, **kwargs):
    """Process image and return composite PNG bytes + manifest."""
    from gpu_config import PREVIEW_MAX_DIM
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")

    upscale_requested = upscale
    max_dim = PREVIEW_MAX_DIM
    # High plate counts: cap resolution to reduce memory pressure
    if plates > 40:
        max_dim = min(max_dim, 2048)
    if plates > 50:
        upscale = False
    if max(img.size) > max_dim:
        ratio = max_dim / max(img.size)
        new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
        img = img.resize(new_size, Image.LANCZOS)

    arr = np.array(img)

    # Resolution-independent cache key: hash of raw image_bytes (not the resized arr).
    # This lets plates-svg and merge endpoints find the result even when they resize differently.
    _raw_hash = hashlib.sha256(image_bytes).hexdigest()
    _preview_cache_key = _make_cache_key(_raw_hash, plates, dust)
    if _preview_cache_key in _separation_cache:
        result = _separation_cache[_preview_cache_key]
    else:
        result = separate(
            arr, n_plates=plates, dust_threshold=dust,
            use_edges=use_edges, edge_sigma=edge_sigma,
            locked_colors=locked_colors, return_data=True,
            chroma_boost=chroma_boost,
            shadow_threshold=shadow_threshold, highlight_threshold=highlight_threshold,
            median_size=median_size,
            upscale=upscale, img_hash=img_hash,
            upscale_scale=upscale_scale,
            progress_callback=progress_callback,
            cache_hash=_raw_hash,
        )

    buf = io.BytesIO()
    result["composite"].save(buf, format="PNG")

    manifest = result["manifest"]
    was_upscaled = manifest.get("upscaled", False)
    manifest["upscale_disabled_reason"] = (
        "high_plate_count" if (not was_upscaled and upscale_requested) else None
    )

    return buf.getvalue(), manifest


def build_merge_response(image_bytes, merge_pairs, plates=4, dust=50,
                         locked_colors=None,
                         chroma_boost=1.3,
                         use_edges=True, edge_sigma=1.5,
                         shadow_threshold=8, highlight_threshold=95,
                         median_size=3,
                         upscale=True, img_hash=None,
                         upscale_scale=None, **kwargs):
    """Run separation, apply merges, return new composite + manifest."""
    from gpu_config import MERGE_MAX_DIM
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")

    max_dim = MERGE_MAX_DIM
    if max(img.size) > max_dim:
        ratio = max_dim / max(img.size)
        new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
        img = img.resize(new_size, Image.LANCZOS)

    arr = np.array(img)

    # Resolution-independent cache key matches build_preview_response.
    _raw_hash = hashlib.sha256(image_bytes).hexdigest()
    _merge_cache_key = _make_cache_key(_raw_hash, plates, dust)
    if _merge_cache_key in _separation_cache:
        result = _separation_cache[_merge_cache_key]
    else:
        result = separate(
            arr, n_plates=plates, dust_threshold=dust,
            use_edges=use_edges, edge_sigma=edge_sigma,
            locked_colors=locked_colors, return_data=True,
            chroma_boost=chroma_boost,
            shadow_threshold=shadow_threshold, highlight_threshold=highlight_threshold,
            median_size=median_size,
            upscale=upscale, img_hash=img_hash,
            upscale_scale=upscale_scale,
            cache_hash=_raw_hash,
        )

    pixel_labels = result["pixel_labels"]
    palette_rgb = result["palette_rgb"]
    h, w = pixel_labels.shape

    pixel_labels = apply_merge(pixel_labels, palette_rgb, merge_pairs, plates)

    active_labels = np.unique(pixel_labels)
    active_labels = active_labels[active_labels < plates]
    palette_lab_all = rgb2lab(palette_rgb.reshape(-1, 1, 3).astype(np.float64) / 255.0).reshape(-1, 3)
    brightness_order = np.argsort([palette_lab_all[idx][0] for idx in active_labels])

    new_results = []
    plate_images = {}
    for rank, order_idx in enumerate(brightness_order):
        idx = active_labels[order_idx]
        mask = pixel_labels == idx
        coverage = np.sum(mask) / mask.size * 100
        rgb = palette_rgb[idx]
        name = f"plate{rank + 1}"
        binary = np.where(mask, 0, 255).astype(np.uint8)

        plate_info = {
            "name": name,
            "index": int(idx),
            "rank": rank + 1,
            "color": [int(rgb[0]), int(rgb[1]), int(rgb[2])],
            "color_hex": f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}",
            "coverage_pct": round(coverage, 2),
        }
        new_results.append(plate_info)
        plate_images[name] = {"mask": mask, "binary": binary}

    comp = np.ones((h, w, 3), dtype=np.uint8) * 255
    for plate_info in reversed(new_results):
        name = plate_info["name"]
        mask = plate_images[name]["mask"]
        comp[mask] = plate_info["color"]

    composite_img = Image.fromarray(comp)

    merge_suggestions = []
    for i_idx in range(len(active_labels)):
        for j_idx in range(i_idx + 1, len(active_labels)):
            li, lj = active_labels[i_idx], active_labels[j_idx]
            delta_e = deltaE_ciede2000(
                palette_lab_all[li].reshape(1, 1, 3),
                palette_lab_all[lj].reshape(1, 1, 3)
            ).item()
            if 2.0 < delta_e < 15:
                merge_suggestions.append({
                    'plate_a': int(li),
                    'plate_b': int(lj),
                    'delta_e': round(float(delta_e), 1)
                })

    manifest = {
        "width": w,
        "height": h,
        "num_plates": len(active_labels),
        "plates": new_results,
        "paper_pct": round(100.0 - sum(p["coverage_pct"] for p in new_results), 2),
        "version": "v20",
        "upscaled": result["manifest"].get("upscaled", False),
        "merge_suggestions": merge_suggestions,
    }

    buf = io.BytesIO()
    composite_img.save(buf, format="PNG")
    return buf.getvalue(), manifest


def build_zip_response(image_bytes, plates=4, dust=50,
                       locked_colors=None,
                       chroma_boost=1.3,
                       use_edges=True, edge_sigma=1.5,
                       shadow_threshold=8, highlight_threshold=95,
                       median_size=3,
                       upscale=True, img_hash=None,
                       upscale_scale=None,
                       progress_callback=None, **kwargs):
    """Process image and return ZIP bytes containing all outputs."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")

    upscale_requested = upscale
    if plates > 50:
        upscale = False

    arr = np.array(img)
    result = separate(
        arr, n_plates=plates, dust_threshold=dust,
        use_edges=use_edges, edge_sigma=edge_sigma,
        locked_colors=locked_colors, return_data=True,
        chroma_boost=chroma_boost,
        shadow_threshold=shadow_threshold, highlight_threshold=highlight_threshold,
        median_size=median_size,
        upscale=upscale, img_hash=img_hash,
        upscale_scale=upscale_scale,
        progress_callback=progress_callback,
    )

    manifest = result["manifest"]
    was_upscaled = manifest.get("upscaled", False)
    manifest["upscale_disabled_reason"] = (
        "high_plate_count" if (not was_upscaled and upscale_requested) else None
    )

    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        comp_buf = io.BytesIO()
        result["composite"].save(comp_buf, format="PNG")
        zf.writestr(zipfile.ZipInfo("composite.png"), comp_buf.getvalue(), compress_type=zipfile.ZIP_STORED)

        h, w = manifest["height"], manifest["width"]

        for plate_info in manifest["plates"]:
            name = plate_info["name"]
            plate_data = result["plates"][name]

            png_buf = io.BytesIO()
            plate_data["image"].save(png_buf, format="PNG")
            zf.writestr(zipfile.ZipInfo(f"png/{name}.png"), png_buf.getvalue(), compress_type=zipfile.ZIP_STORED)

            svg_content = mask_to_svg_string(plate_data["mask"], w, h)
            zf.writestr(zipfile.ZipInfo(f"svg/{name}.svg"), svg_content.encode(), compress_type=zipfile.ZIP_DEFLATED)

        zf.writestr(zipfile.ZipInfo("manifest.json"), json.dumps(manifest, indent=2).encode(), compress_type=zipfile.ZIP_DEFLATED)

    return zip_buf.getvalue()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Woodblock color separation V15 (SAM-guided)")
    parser.add_argument("input", nargs="?", default=None, help="Input image path")
    parser.add_argument("output", nargs="?", default=None, help="Output directory")
    parser.add_argument("--plates", type=int, default=8, help="Number of color plates")
    parser.add_argument("--dust", type=int, default=50, help="CC cleanup threshold")
    parser.add_argument("--no-edges", action="store_true", help="Disable Canny edge detection")
    parser.add_argument("--edge-sigma", type=float, default=1.5, help="Canny edge sigma")
    parser.add_argument("--chroma", type=float, default=1.3, help="Chroma boost factor")
    parser.add_argument("--shadow", type=int, default=8, help="Shadow threshold (L*)")
    parser.add_argument("--highlight", type=int, default=95, help="Highlight threshold (L*)")
    parser.add_argument("--median", type=int, default=3, help="Median filter size for label map")
    parser.add_argument("--no-upscale", action="store_true", help="Disable Real-ESRGAN upscale")
    args = parser.parse_args()

    if args.input and args.output:
        result = separate(
            args.input, args.output, n_plates=args.plates,
            dust_threshold=args.dust,
            use_edges=not args.no_edges, edge_sigma=args.edge_sigma,
            chroma_boost=args.chroma,
            shadow_threshold=args.shadow, highlight_threshold=args.highlight,
            median_size=args.median,
            upscale=not args.no_upscale,
        )
        print(json.dumps(result, indent=2))
    else:
        parser.print_help()
