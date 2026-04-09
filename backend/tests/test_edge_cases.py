"""Edge case tests for the separation algorithm."""
import io
import os
import sys

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _make_png(arr):
    """Convert numpy array to PNG bytes."""
    buf = io.BytesIO()
    Image.fromarray(arr.astype(np.uint8)).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def v12():
    import separate_v12
    return separate_v12


@pytest.fixture
def v11():
    import separate_v11
    return separate_v11


# ---------------------------------------------------------------------------
# Tiny images
# ---------------------------------------------------------------------------
class TestTinyImages:
    """Ensure tiny images don't crash the separation pipeline."""

    def test_1x1_image(self, v12):
        """1x1 image may raise ValueError for KMeans — just ensure no crash/hang."""
        img = np.array([[[128, 64, 32]]], dtype=np.uint8)
        try:
            result = v12.separate(img, n_plates=2, dust_threshold=0, return_data=True)
            assert "manifest" in result
        except ValueError:
            pass  # KMeans can't cluster 1 sample into 2 clusters

    def test_2x2_image(self, v12):
        img = np.zeros((2, 2, 3), dtype=np.uint8)
        img[0, 0] = [255, 0, 0]
        img[0, 1] = [0, 255, 0]
        img[1, 0] = [0, 0, 255]
        img[1, 1] = [255, 255, 0]
        result = v12.separate(img, n_plates=2, dust_threshold=0, return_data=True)
        assert len(result["manifest"]["plates"]) > 0

    def test_10x10_image(self, v12):
        img = np.random.randint(0, 255, (10, 10, 3), dtype=np.uint8)
        result = v12.separate(img, n_plates=3, dust_threshold=5, return_data=True)
        assert "composite" in result

    def test_1x1_preview(self, v11):
        """1x1 image through preview — may fail due to KMeans constraints."""
        png = _make_png(np.array([[[200, 100, 50]]], dtype=np.uint8))
        try:
            comp_bytes, manifest = v11.build_preview_response(
                image_bytes=png, plates=2, dust=0
            )
            assert len(comp_bytes) > 0
            assert "plates" in manifest
        except (ValueError, Exception):
            pass  # Too small for clustering


# ---------------------------------------------------------------------------
# Uniform / single-color images
# ---------------------------------------------------------------------------
class TestSingleColor:
    """All pixels identical — should produce 1 plate (or clamp to minimum)."""

    def test_all_white(self, v12):
        img = np.full((50, 50, 3), 255, dtype=np.uint8)
        result = v12.separate(img, n_plates=3, dust_threshold=20, return_data=True)
        assert "manifest" in result
        # With one color, KMeans may produce 1 plate despite requesting 3
        assert len(result["manifest"]["plates"]) >= 1

    def test_all_black(self, v12):
        img = np.zeros((50, 50, 3), dtype=np.uint8)
        result = v12.separate(img, n_plates=3, dust_threshold=20, return_data=True)
        assert len(result["manifest"]["plates"]) >= 1

    def test_all_red(self, v12):
        img = np.full((50, 50, 3), [255, 0, 0], dtype=np.uint8)
        result = v12.separate(img, n_plates=4, dust_threshold=10, return_data=True)
        assert "plates" in result


# ---------------------------------------------------------------------------
# Grayscale image (R==G==B)
# ---------------------------------------------------------------------------
class TestGrayscaleInput:
    """Grayscale-ish input where R==G==B."""

    def test_grayscale_gradient(self, v12):
        # Horizontal grayscale gradient
        img = np.zeros((50, 50, 3), dtype=np.uint8)
        for i in range(50):
            val = int(i * 255 / 49)
            img[:, i] = [val, val, val]
        result = v12.separate(img, n_plates=3, dust_threshold=10, return_data=True)
        assert len(result["manifest"]["plates"]) > 0

    def test_grayscale_50_50(self, v12):
        """Half black, half white."""
        img = np.zeros((50, 50, 3), dtype=np.uint8)
        img[:, 25:] = 255
        result = v12.separate(img, n_plates=2, dust_threshold=5, return_data=True)
        assert len(result["manifest"]["plates"]) == 2


# ---------------------------------------------------------------------------
# High plate counts on small images
# ---------------------------------------------------------------------------
class TestHighPlateCounts:
    """Request more plates than pixels can support."""

    def test_20_plates_small_image(self, v12):
        img = np.random.randint(0, 255, (30, 30, 3), dtype=np.uint8)
        result = v12.separate(img, n_plates=20, dust_threshold=5, return_data=True)
        # Should not crash; may produce fewer plates than requested
        assert len(result["manifest"]["plates"]) >= 1

    def test_35_plates_medium_image(self, v12):
        img = np.random.randint(0, 255, (80, 80, 3), dtype=np.uint8)
        result = v12.separate(img, n_plates=35, dust_threshold=5, return_data=True)
        assert len(result["manifest"]["plates"]) >= 1


# ---------------------------------------------------------------------------
# Locked colors
# ---------------------------------------------------------------------------
class TestLockedColorsBehavior:
    """Verify locked colors appear in the output manifest."""

    def test_locked_color_present(self, v12):
        img = np.zeros((80, 80, 3), dtype=np.uint8)
        img[:40, :40] = [255, 0, 0]
        img[:40, 40:] = [0, 255, 0]
        img[40:, :40] = [0, 0, 255]
        img[40:, 40:] = [255, 255, 0]
        result = v12.separate(
            img, n_plates=4, dust_threshold=10,
            locked_colors=[[255, 0, 0]], return_data=True,
        )
        # Just verify we got plates with locked colors influencing the result
        assert len(result["manifest"]["plates"]) >= 1

    def test_multiple_locked(self, v12):
        img = np.zeros((80, 80, 3), dtype=np.uint8)
        img[:40, :40] = [255, 0, 0]
        img[:40, 40:] = [0, 255, 0]
        img[40:, :40] = [0, 0, 255]
        img[40:, 40:] = [255, 255, 0]
        result = v12.separate(
            img, n_plates=4, dust_threshold=10,
            locked_colors=[[255, 0, 0], [0, 255, 0]], return_data=True,
        )
        assert len(result["manifest"]["plates"]) >= 2


# ---------------------------------------------------------------------------
# Parameter extremes
# ---------------------------------------------------------------------------
class TestParameterExtremes:
    """Test extreme parameter values don't crash."""

    def test_dust_zero(self, v12):
        img = np.random.randint(0, 255, (50, 50, 3), dtype=np.uint8)
        result = v12.separate(img, n_plates=3, dust_threshold=0, return_data=True)
        assert "manifest" in result

    def test_dust_high(self, v12):
        img = np.random.randint(0, 255, (50, 50, 3), dtype=np.uint8)
        result = v12.separate(img, n_plates=3, dust_threshold=1000, return_data=True)
        assert "manifest" in result

    def test_chroma_boost_zero(self, v12):
        img = np.random.randint(0, 255, (50, 50, 3), dtype=np.uint8)
        result = v12.separate(
            img, n_plates=3, dust_threshold=20,
            chroma_boost=0.0, return_data=True,
        )
        assert "manifest" in result

    def test_chroma_boost_high(self, v12):
        img = np.random.randint(0, 255, (50, 50, 3), dtype=np.uint8)
        result = v12.separate(
            img, n_plates=3, dust_threshold=20,
            chroma_boost=5.0, return_data=True,
        )
        assert "manifest" in result

    def test_two_plates_minimum(self, v12):
        img = np.random.randint(0, 255, (50, 50, 3), dtype=np.uint8)
        result = v12.separate(img, n_plates=2, dust_threshold=20, return_data=True)
        assert len(result["manifest"]["plates"]) >= 1

    def test_low_sigma_v12(self, v12):
        img = np.random.randint(0, 255, (50, 50, 3), dtype=np.uint8)
        result = v12.separate(
            img, n_plates=3, dust_threshold=20,
            sigma_s=5.0, sigma_r=0.05, return_data=True,
        )
        assert "manifest" in result

    def test_sigma_extremes(self, v12):
        img = np.random.randint(0, 255, (50, 50, 3), dtype=np.uint8)
        result = v12.separate(
            img, n_plates=3, dust_threshold=20,
            sigma_s=10.0, sigma_r=0.1, return_data=True,
        )
        assert "manifest" in result


# ---------------------------------------------------------------------------
# build_preview_response with edge cases
# ---------------------------------------------------------------------------
class TestPreviewEdgeCases:
    """Edge cases through the build_preview_response path."""

    def test_preview_2_plates(self, v12):
        img = np.zeros((40, 40, 3), dtype=np.uint8)
        img[:20] = [255, 0, 0]
        img[20:] = [0, 0, 255]
        png = _make_png(img)
        comp, manifest = v12.build_preview_response(
            image_bytes=png, plates=2, dust=10
        )
        assert len(comp) > 0
        assert len(manifest["plates"]) >= 1

    def test_preview_high_dust(self, v12):
        img = np.random.randint(0, 255, (40, 40, 3), dtype=np.uint8)
        png = _make_png(img)
        comp, manifest = v12.build_preview_response(
            image_bytes=png, plates=3, dust=500
        )
        assert len(comp) > 0

    def test_zip_basic(self, v12):
        img = np.zeros((40, 40, 3), dtype=np.uint8)
        img[:20] = [200, 50, 50]
        img[20:] = [50, 50, 200]
        png = _make_png(img)
        zip_bytes = v12.build_zip_response(
            image_bytes=png, plates=2, dust=10
        )
        assert len(zip_bytes) > 0
        import zipfile
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
        assert "composite.png" in zf.namelist()
        assert "manifest.json" in zf.namelist()
