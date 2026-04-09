"""Shared fixtures and CI-aware markers for the test suite."""
import os
import sys
import types
import pytest

# ---------------------------------------------------------------------------
# Environment detection
# ---------------------------------------------------------------------------

# Detect CI environment (GitHub Actions, GitLab CI, etc.)
IN_CI = os.environ.get("CI", "").lower() in ("true", "1") or os.environ.get("GITHUB_ACTIONS") == "true"

# Detect CUDA availability without importing torch (avoids hang if torch is absent)


def _cuda_available() -> bool:
    """Detect CUDA without importing torch (which hangs on CPU-only machines)."""
    import shutil
    if not shutil.which("nvidia-smi"):
        return False
    try:
        import subprocess
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, timeout=5, text=True
        )
        return result.returncode == 0 and len(result.stdout.strip()) > 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


CUDA_AVAILABLE = _cuda_available()

# ---------------------------------------------------------------------------
# Mock torch and SAM imports when CUDA is unavailable
#
# Some separate_v15+ modules call `import torch` and `from ultralytics import SAM`
# deep inside functions.  When torch is installed but CUDA is absent, those
# inline imports can trigger long device-init timeouts that hang the suite.
# We replace the modules with thin stubs so the import completes instantly
# and the function bodies raise RuntimeError (which tests catch / skip on).
# ---------------------------------------------------------------------------


def _install_torch_stub() -> None:
    """Replace `torch` in sys.modules with a minimal stub."""
    if "torch" in sys.modules:
        return  # already imported — too late to stub safely

    stub = types.ModuleType("torch")
    stub.cuda = types.SimpleNamespace(
        is_available=lambda: False,
        empty_cache=lambda: None,
    )
    stub.device = lambda *a, **kw: "cpu"
    # Provide a no-op inference_mode context manager

    class _NoOp:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def __call__(self, fn): return fn
    stub.inference_mode = _NoOp()
    stub.no_grad = _NoOp()
    # scipy's array_api_compat checks getattr(torch, "Tensor") — provide a stub class
    stub.Tensor = type("Tensor", (), {})
    sys.modules["torch"] = stub


def _install_sam_stub() -> None:
    """Replace `ultralytics` (and ultralytics.SAM) with stubs."""
    if "ultralytics" in sys.modules:
        return

    class _FakeSAM:
        def __init__(self, *a, **kw):
            raise RuntimeError("SAM unavailable: no CUDA and stub active")

    ultralytics_stub = types.ModuleType("ultralytics")
    ultralytics_stub.SAM = _FakeSAM
    sys.modules["ultralytics"] = ultralytics_stub


# Only install stubs when CUDA is absent to avoid masking real issues on GPU machines.
if not CUDA_AVAILABLE:
    _install_torch_stub()
    _install_sam_stub()

# ---------------------------------------------------------------------------
# pytest hooks
# ---------------------------------------------------------------------------


def pytest_collection_modifyitems(config, items):
    """Skip GPU/model-weight tests when running in CI or when CUDA is absent."""
    no_gpu = IN_CI or not CUDA_AVAILABLE
    if not no_gpu:
        return

    reason = (
        "Requires GPU/CUDA – skipped in CI"
        if IN_CI
        else "Requires CUDA – not available on this machine"
    )
    skip_marker = pytest.mark.skip(reason=reason)
    for item in items:
        if "gpu" in item.keywords:
            item.add_marker(skip_marker)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def cuda_available():
    """Session-scoped fixture exposing CUDA availability to tests."""
    return CUDA_AVAILABLE


@pytest.fixture(scope="session")
def in_ci():
    """Session-scoped fixture exposing CI detection to tests."""
    return IN_CI
