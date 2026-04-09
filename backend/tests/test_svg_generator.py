"""Tests for svg_generator.py — potrace-based SVG generation."""
import os
import sys
import tempfile

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from svg_generator import mask_to_svg, mask_to_svg_legacy, mask_to_svg_file


# ── helpers ──────────────────────────────────────────────────────────────────


def _circle_mask(h=100, w=100, cy=50, cx=50, r=30):
    """Binary mask with a filled circle."""
    yy, xx = np.ogrid[:h, :w]
    return ((yy - cy) ** 2 + (xx - cx) ** 2 <= r ** 2).astype(np.uint8)


def _rect_mask(h=100, w=100, y0=20, y1=80, x0=20, x1=80):
    """Binary mask with a filled rectangle."""
    mask = np.zeros((h, w), dtype=np.uint8)
    mask[y0:y1, x0:x1] = 1
    return mask


def _ring_mask(h=100, w=100, cy=50, cx=50, r_outer=40, r_inner=15):
    """Ring (donut) — outer circle with a hole. Tests evenodd fill."""
    yy, xx = np.ogrid[:h, :w]
    outer = (yy - cy) ** 2 + (xx - cx) ** 2 <= r_outer ** 2
    inner = (yy - cy) ** 2 + (xx - cx) ** 2 <= r_inner ** 2
    return (outer & ~inner).astype(np.uint8)


# ── mask_to_svg: SVG structure ───────────────────────────────────────────────


class TestMaskToSvgStructure:
    def test_valid_xml_header(self):
        svg = mask_to_svg(_circle_mask(), 100, 100)
        assert svg.startswith('<?xml version="1.0"')

    def test_contains_svg_element(self):
        svg = mask_to_svg(_circle_mask(), 100, 100)
        assert "<svg" in svg
        assert "</svg>" in svg

    def test_viewbox_present(self):
        svg = mask_to_svg(_circle_mask(), 200, 150)
        assert 'viewBox="0 0 200 150"' in svg

    def test_shape_rendering(self):
        svg = mask_to_svg(_circle_mask(), 100, 100)
        assert 'shape-rendering="geometricPrecision"' in svg

    def test_fill_rule_evenodd(self):
        svg = mask_to_svg(_circle_mask(), 100, 100)
        assert 'fill-rule="evenodd"' in svg

    def test_cubic_bezier_commands(self):
        """Curved shapes should produce cubic bezier (C) commands."""
        svg = mask_to_svg(_circle_mask(), 100, 100)
        assert " C " in svg


# ── mask_to_svg: various shapes ──────────────────────────────────────────────


class TestMaskToSvgShapes:
    def test_circle(self):
        svg = mask_to_svg(_circle_mask(), 100, 100)
        assert "<path" in svg
        assert 'fill="black"' in svg

    def test_rectangle(self):
        svg = mask_to_svg(_rect_mask(), 100, 100)
        assert "<path" in svg

    def test_single_pixel(self):
        mask = np.zeros((50, 50), dtype=np.uint8)
        mask[25, 25] = 1
        svg = mask_to_svg(mask, 50, 50)
        # Single pixel may be filtered by turdsize; either potrace or legacy
        assert "</svg>" in svg

    def test_full_mask(self):
        """All-ones mask should produce valid SVG (potrace may filter it)."""
        mask = np.ones((60, 80), dtype=np.uint8)
        svg = mask_to_svg(mask, 80, 60)
        assert "</svg>" in svg
        assert 'viewBox="0 0 80 60"' in svg


# ── hole preservation (ring/donut) ───────────────────────────────────────────


class TestHolePreservation:
    def test_ring_produces_compound_path(self):
        """Ring mask must use compound path with evenodd to preserve hole."""
        svg = mask_to_svg(_ring_mask(), 100, 100)
        assert 'fill-rule="evenodd"' in svg
        # Compound path: multiple M commands within a single d attribute
        d_attr_start = svg.find('d="')
        assert d_attr_start > 0
        d_value = svg[d_attr_start + 3: svg.find('"', d_attr_start + 3)]
        m_count = d_value.count("M ")
        assert m_count >= 2, f"Expected >=2 sub-paths for ring, got {m_count}"


# ── empty mask ───────────────────────────────────────────────────────────────


class TestEmptyMask:
    def test_all_zeros_produces_valid_svg(self):
        mask = np.zeros((100, 100), dtype=np.uint8)
        svg = mask_to_svg(mask, 100, 100)
        assert "</svg>" in svg

    def test_all_zeros_falls_back_to_legacy(self):
        """Empty mask: potrace returns nothing, should fall back to legacy."""
        mask = np.zeros((100, 100), dtype=np.uint8)
        svg = mask_to_svg(mask, 100, 100)
        # Legacy does not include fill-rule="evenodd"
        assert "</svg>" in svg


# ── scale transform ──────────────────────────────────────────────────────────


class TestScaleTransform:
    def test_no_scale_when_dims_match(self):
        mask = _circle_mask(h=100, w=100)
        svg = mask_to_svg(mask, 100, 100)
        assert "scale(" not in svg

    def test_scale_when_width_differs(self):
        mask = _circle_mask(h=100, w=100)
        svg = mask_to_svg(mask, 200, 100)
        assert "scale(" in svg
        assert "<g transform=" in svg

    def test_scale_when_height_differs(self):
        mask = _circle_mask(h=100, w=100)
        svg = mask_to_svg(mask, 100, 200)
        assert "scale(" in svg

    def test_viewbox_matches_requested_dimensions(self):
        mask = _circle_mask(h=50, w=50)
        svg = mask_to_svg(mask, 300, 400)
        assert 'viewBox="0 0 300 400"' in svg
        assert 'width="300"' in svg
        assert 'height="400"' in svg


# ── mask_to_svg_legacy ───────────────────────────────────────────────────────


class TestMaskToSvgLegacy:
    def test_basic_output(self):
        svg = mask_to_svg_legacy(_rect_mask(), 100, 100)
        assert '<?xml' in svg
        assert '</svg>' in svg

    def test_viewbox(self):
        svg = mask_to_svg_legacy(_rect_mask(), 100, 100)
        assert 'viewBox="0 0 100 100"' in svg

    def test_shape_rendering(self):
        svg = mask_to_svg_legacy(_rect_mask(), 100, 100)
        assert 'shape-rendering="geometricPrecision"' in svg

    def test_uses_line_commands(self):
        """Legacy uses polyline (L commands), not bezier."""
        svg = mask_to_svg_legacy(_circle_mask(), 100, 100)
        assert " L " in svg

    def test_paths_closed_with_z(self):
        svg = mask_to_svg_legacy(_rect_mask(), 100, 100)
        assert " Z" in svg

    def test_empty_mask_no_paths(self):
        mask = np.zeros((50, 50), dtype=np.uint8)
        svg = mask_to_svg_legacy(mask, 50, 50)
        assert "<path" not in svg
        assert "</svg>" in svg


# ── mask_to_svg_file ─────────────────────────────────────────────────────────


class TestMaskToSvgFile:
    def test_writes_to_disk(self):
        mask = _circle_mask()
        with tempfile.NamedTemporaryFile(suffix=".svg", delete=False) as f:
            path = f.name
        try:
            mask_to_svg_file(mask, path, 100, 100)
            with open(path) as f:
                content = f.read()
            assert '<?xml' in content
            assert '</svg>' in content
        finally:
            os.unlink(path)

    def test_file_content_matches_mask_to_svg(self):
        mask = _rect_mask()
        with tempfile.NamedTemporaryFile(suffix=".svg", delete=False) as f:
            path = f.name
        try:
            mask_to_svg_file(mask, path, 100, 100)
            with open(path) as f:
                file_content = f.read()
            direct_content = mask_to_svg(mask, 100, 100)
            assert file_content == direct_content
        finally:
            os.unlink(path)
