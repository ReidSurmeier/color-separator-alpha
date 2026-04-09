"""scikit-image compatibility shim.

approximate_polygon moved between skimage versions / build configs.
This module provides a single import point that works across all of them.
"""
from skimage.measure import find_contours  # noqa: F401

# approximate_polygon may live in different locations depending on the
# scikit-image build and version. Try all known paths.
_ap = None
for _mod_path in (
    "skimage.measure",
    "skimage.measure._polygon",
    "skimage.measure.polygon_approximation",
    "skimage.measure._find_contours",
):
    try:
        _m = __import__(_mod_path, fromlist=["approximate_polygon"])
        _ap = getattr(_m, "approximate_polygon", None)
        if _ap is not None:
            break
    except (ImportError, AttributeError):
        continue

if _ap is None:
    # Last resort: pure-python fallback using Douglas-Peucker
    import numpy as _np

    def approximate_polygon(coords, tolerance):  # type: ignore[misc]
        """Douglas-Peucker polygon simplification (fallback)."""
        if len(coords) <= 2:
            return coords
        d_max = 0.0
        idx = 0
        end = len(coords) - 1
        for i in range(1, end):
            d = abs(
                (coords[end, 1] - coords[0, 1]) * coords[i, 0]
                - (coords[end, 0] - coords[0, 0]) * coords[i, 1]
                + coords[end, 0] * coords[0, 1]
                - coords[end, 1] * coords[0, 0]
            ) / (_np.sqrt(
                (coords[end, 1] - coords[0, 1]) ** 2
                + (coords[end, 0] - coords[0, 0]) ** 2
            ) + 1e-10)
            if d > d_max:
                d_max = d
                idx = i
        if d_max > tolerance:
            left = approximate_polygon(coords[: idx + 1], tolerance)
            right = approximate_polygon(coords[idx:], tolerance)
            return _np.vstack([left[:-1], right])
        return _np.array([coords[0], coords[-1]])

    _ap = approximate_polygon

approximate_polygon = _ap  # noqa: F811
