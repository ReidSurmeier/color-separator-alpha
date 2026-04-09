"""Shared SVG generation module for color separator.

All separate_v*.py files import from here to ensure consistent
CNC-grade potrace-based SVG output across all algorithm versions.
"""

import numpy as np
from skimage_compat import find_contours, approximate_polygon


def mask_to_svg_legacy(mask, width, height, tolerance=0.5):
    """Polyline SVG fallback for simple/rectangular masks where potrace yields nothing."""
    contours = find_contours(mask.astype(float), 0.5)
    paths = []
    for contour in contours:
        if len(contour) < 3:
            continue
        simplified = approximate_polygon(contour, tolerance=tolerance)
        if len(simplified) < 3:
            continue
        d = f"M {simplified[0][1]:.3f},{simplified[0][0]:.3f}"
        for pt in simplified[1:]:
            d += f" L {pt[1]:.3f},{pt[0]:.3f}"
        d += " Z"
        paths.append(d)

    svg = '<?xml version="1.0" encoding="UTF-8"?>\n'
    svg += (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}"'
        f' viewBox="0 0 {width} {height}"'
        f' shape-rendering="geometricPrecision">\n'
    )
    for d in paths:
        svg += f'  <path d="{d}" fill="black" stroke="none"/>\n'
    svg += "</svg>\n"
    return svg


def mask_to_svg(mask, width, height, **_kwargs):
    """Generate CNC-ready SVG using potrace (Inkscape's trace bitmap engine).

    Uses the potrace algorithm — the same engine behind Inkscape's
    "Trace Bitmap > Brightness Cutoff" — to produce perfectly smooth
    cubic bezier paths from binary masks.

    Quality guarantees:
    - All organic curves use cubic Bézier (C) commands
    - alphamax=1.0 for maximum curve smoothing
    - opttolerance=0.2 for tight bezier fit
    - Smooth at 10× zoom, no faceting or polygon artifacts
    - shape-rendering="geometricPrecision"
    - 3-decimal coordinate precision
    - All paths closed with Z
    """
    import potrace

    # Trace at full mask resolution — no downscaling.
    trace_mask = mask

    # potrace expects a boolean bitmap: True = foreground (shape)
    bmp = potrace.Bitmap(trace_mask.astype(np.bool_))

    # Trace with Inkscape-equivalent settings:
    # alphamax=1.0: maximum curve smoothing (corners become curves)
    # opttolerance=0.2: tight bezier fitting tolerance
    # turdsize=2: suppress specks smaller than 2px
    path = bmp.trace(turdsize=2, alphamax=1.0, opttolerance=0.2)

    # Build SVG path data from potrace curves.
    # CRITICAL: potrace uses compound paths where outer boundaries and holes
    # alternate. All sub-paths must be combined into a SINGLE <path> element
    # with fill-rule="evenodd" so holes (like inside a "D") render correctly.
    # Separate <path> elements would fill in the holes.
    sub_paths = []
    canvas_rect_path = None  # Hold the canvas rect in case it's the only curve
    trace_h, trace_w = trace_mask.shape

    def _is_canvas_rect(start, segs, w, h, tol=1.5):
        """True only for the potrace wrapper rectangle: 4 corner segments at canvas boundary."""
        if len(segs) != 4:
            return False
        if not all(s.is_corner for s in segs):
            return False
        endpoints = [(start.x, start.y)] + [(s.end_point.x, s.end_point.y) for s in segs[:3]]
        corners = {(0, 0), (w, 0), (w, h), (0, h)}
        matched = sum(
            any(abs(ex - cx) < tol and abs(ey - cy) < tol for cx, cy in corners)
            for ex, ey in endpoints
        )
        return matched == 4

    def _curve_to_path(curve):
        """Convert a potrace curve to SVG path data string."""
        parts = [f"M {curve.start_point.x:.3f},{curve.start_point.y:.3f}"]
        for seg in curve:
            if seg.is_corner:
                parts.append(
                    f"L {seg.c.x:.3f},{seg.c.y:.3f} "
                    f"L {seg.end_point.x:.3f},{seg.end_point.y:.3f}"
                )
            else:
                parts.append(
                    f"C {seg.c1.x:.3f},{seg.c1.y:.3f} "
                    f"{seg.c2.x:.3f},{seg.c2.y:.3f} "
                    f"{seg.end_point.x:.3f},{seg.end_point.y:.3f}"
                )
        parts.append("Z")
        return " ".join(parts)

    for curve in path:
        seg_list = list(curve)

        if _is_canvas_rect(curve.start_point, seg_list, trace_w, trace_h):
            # Save but don't add yet — only skip if other curves exist
            canvas_rect_path = _curve_to_path(curve)
            continue

        sub_paths.append(_curve_to_path(curve))

    # If skipping the canvas rect left us with nothing, this plate IS
    # the background — the canvas rect is the actual content. Keep it.
    if not sub_paths and canvas_rect_path:
        sub_paths.append(canvas_rect_path)

    if not sub_paths:
        # Potrace found nothing. Check if the mask actually has ink pixels.
        # If yes, the plate has content but it's too sparse/scattered for
        # potrace (turdsize removes small specks). Generate a full-canvas
        # filled rect — this plate covers the entire image minus other plates.
        ink_pixels = np.count_nonzero(mask == 0)
        total_pixels = mask.size
        if ink_pixels > 0 and ink_pixels / total_pixels > 0.001:
            # Plate has >0.1% ink coverage — generate filled rect
            svg = '<?xml version="1.0" encoding="UTF-8"?>\n'
            svg += (
                f'<svg xmlns="http://www.w3.org/2000/svg" '
                f'width="{width}" height="{height}" '
                f'viewBox="0 0 {width} {height}" '
                f'shape-rendering="geometricPrecision">\n'
            )
            svg += f'  <rect x="0" y="0" width="{width}" height="{height}" fill="black"/>\n'
            svg += "</svg>\n"
            return svg
        return mask_to_svg_legacy(mask, width, height)

    # Combine all sub-paths into one compound path with evenodd fill rule.
    # This preserves holes — outer boundary = filled, inner boundary = hole.
    combined_d = " ".join(sub_paths)

    # Scale factor: trace_mask may differ from target width/height
    trace_h, trace_w = trace_mask.shape
    sx = width / trace_w if trace_w > 0 else 1.0
    sy = height / trace_h if trace_h > 0 else 1.0
    needs_scale = abs(sx - 1.0) > 0.001 or abs(sy - 1.0) > 0.001

    # Build high-fidelity SVG
    svg = '<?xml version="1.0" encoding="UTF-8"?>\n'
    svg += (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" '
        f'shape-rendering="geometricPrecision">\n'
    )
    if needs_scale:
        svg += f'<g transform="scale({sx:.6f},{sy:.6f})">\n'
    svg += f'  <path d="{combined_d}" fill="black" fill-rule="evenodd" stroke="none"/>\n'
    if needs_scale:
        svg += "</g>\n"
    svg += "</svg>\n"
    return svg


def mask_to_svg_file(mask, filepath, width, height, **kwargs):
    """Write potrace SVG to a file."""
    svg_content = mask_to_svg(mask, width, height, **kwargs)
    with open(filepath, "w") as f:
        f.write(svg_content)
