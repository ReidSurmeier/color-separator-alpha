<h1 align="center">Color.separator Alpha (2026)</h1>

<p align="center">
  <a href="https://github.com/ReidSurmeier/color-separator-alpha/actions/workflows/ci.yml"><img src="https://github.com/ReidSurmeier/color-separator-alpha/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://codecov.io/gh/ReidSurmeier/color-separator-alpha"><img src="https://codecov.io/gh/ReidSurmeier/color-separator-alpha/graph/badge.svg" alt="codecov"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-PolyForm%20NC%201.0-blue.svg" alt="License: PolyForm Noncommercial"></a>
  <a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/python-3.10+-blue.svg" alt="Python 3.10+"></a>
  <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16-black.svg" alt="Next.js 16"></a>
  <a href="https://pytorch.org/"><img src="https://img.shields.io/badge/PyTorch-2.6-ee4c2c.svg" alt="PyTorch"></a>
</p>

<p align="center">
  <strong>AI-powered color separation for woodblock printing.</strong>
</p>

Color.separator splits photographs into flat color plates for relief printing. Each plate is a binary mask — ink or paper — for woodblock, linocut, or screenprint layers. The tool uses SAM2.1 for object-aware segmentation, K-means++ for perceptual color clustering in CIELAB space, and potrace for Inkscape-quality cubic bezier SVG output.

* Live: https://color.reidsurmeier.wtf
* Algorithm: SAM2.1 + K-means++ + Canny + RealESRGAN + potrace

## Pipeline

```
photograph ──► ESRGAN 2x/4x ──► SAM2.1 masks ──► K-means++ (CIELAB)
                                                        │
            potrace SVG ◄── cleanup ◄── guided filter ◄─┘
                │
                ▼
        per-plate SVG + PNG + manifest
```

**ESRGAN** optional super-resolution before processing. **SAM2.1** generates object-aware region masks. **K-means++** clusters pixels in perceptual CIELAB space, respecting SAM boundaries. **Guided filter** preserves edges on neutral plates. **Potrace** converts binary masks to cubic bezier SVG paths (same engine as Inkscape).

## Feature Comparison

|  | Color.separator | UltraSeps | Separation Studio | T-Seps | Photoshop | CorelDRAW | Illustrator | Vectorizer.ai |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| AI segmentation (SAM2) | **Yes** | — | — | — | — | — | — | — |
| CIELAB perceptual clustering | **Yes** | — | — | — | Manual | — | — | — |
| AI upscale (RealESRGAN) | **2x/4x** | — | — | — | 2x | 2x | — | — |
| Vector SVG output | **Yes** | — | — | — | — | **Yes** | **Yes** | **Yes** |
| Auto merge suggestions (CIEDE2000) | **Yes** | — | — | — | — | Partial | — | Partial |
| Plates / channels | **2-60** | 6-8 | 8-12 | 6-8 | 56 | Spot | 128 | N/A |
| Full resolution output | **Always** | Yes | Yes | Yes | Yes | Yes | Yes | Limited |
| Real-time preview | **SSE stream** | After run | Yes | After run | Yes | Yes | Yes | Yes |
| Spot color ink libraries | — | — | **Yes** | — | **Yes** | **Yes** | — | — |
| Simulated process seps | — | **Yes** | **Yes** | **Yes** | Manual | — | — | — |
| Index color separation | — | **Yes** | **Yes** | **Yes** | Manual | — | — | — |
| Self-hosted / local | **Yes** | Desktop | Desktop | Desktop | Desktop | Desktop | Desktop | Cloud |
| Open source | **Yes** | — | — | — | — | — | — | — |
| GPU accelerated | **RTX 4070+** | CPU | CPU | CPU | CPU | CPU | CPU | Cloud |
| Price | **Free** | $349 | $499 | $249 | $23/mo | $550 | $23/mo | $10/mo |

## Output

Each separation produces:

| File | Format | Description |
|------|--------|-------------|
| `composite.png` | PNG | Preview of all plates composited |
| `plate_{color}.svg` | SVG | Potrace cubic bezier vectors per plate |
| `plate_{color}.png` | PNG | Binary mask (0=ink, 255=paper) per plate |
| `manifest.json` | JSON | Colors, coverage %, merge suggestions |
| `diagram.png` | PNG | Visual layout of all plates |

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, TypeScript |
| Backend | FastAPI, uvicorn, Python 3.10+ |
| Segmentation | SAM2.1 (Segment Anything Model 2.1) |
| Upscale | RealESRGAN (Real-ESRGAN x2/x4) |
| Vectorization | potrace (cubic bezier, fill-rule evenodd) |
| Color science | CIELAB, CIEDE2000, MiniBatchKMeans |
| Edge detection | Canny, guided filter, morphological ops |
| GPU | PyTorch 2.6 + CUDA 12.6 |
| Deploy | Docker Compose, Nginx, Cloudflare tunnel |
| Analytics | Structured JSONL, per-request GPU/CPU metrics |

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/ReidSurmeier/color-separator-alpha.git
cd color-separator-alpha
docker compose -f docker-compose.local.yml build
docker compose -f docker-compose.local.yml up -d
# → http://localhost:8004
```

### Manual

```bash
# Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8001

# Frontend
npm install
npm run build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
PORT=8004 node .next/standalone/server.js
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | System status — GPU, VRAM, SAM cache, memory |
| `/api/preview-stream` | POST | SSE preview with real-time progress events |
| `/api/plates-svg` | POST | Full-resolution SVG + PNG output (async job) |
| `/api/merge` | POST | Merge color plates with index mapping |
| `/api/upscale` | POST | RealESRGAN super-resolution (cached) |
| `/api/separate` | POST | ZIP download with all plates |
| `/api/analytics` | GET | Request analytics with filtering |
| `/api/analytics/event` | POST | Frontend event tracking |
| `/api/job/{id}` | GET | Poll async job status |

## Resolution Policy

Full resolution output, always. No downscaling. No compression unless it would literally OOM the server.

- Preview is capped at 2000px for interactive speed
- Output (ZIP/SVG/PNG) runs at original resolution
- 4x upscale on 2000px input = 8000px output
- Processing time is not a constraint — quality is

## Hardware Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| GPU | GTX 1060 6GB | RTX 4070+ 12GB |
| VRAM | 6GB | 12GB+ |
| RAM | 16GB | 32GB+ |
| Storage | 2GB (models) | 5GB |

SAM2.1 tiny model: ~400MB. RealESRGAN x4 model: ~64MB.

## Testing

```bash
# Backend
cd backend && python -m pytest tests/ -v

# Frontend
npm run lint && npx tsc --noEmit

# E2E
npx playwright test
```

## Architecture

```
Internet → Cloudflare CDN → cloudflared tunnel (Linux)
  → Nginx (600s timeout) → Tailscale → Windows Docker
    → Frontend (Next.js, port 8004)
      → Backend (FastAPI + SAM2.1 + RealESRGAN, port 8001)
        → RTX 4070 SUPER (12GB VRAM, CUDA 12.6)
```

## Papers & References

Color.separator builds on these research papers and open-source projects:

### Segmentation
| Paper | Authors | Year | Use |
|-------|---------|------|-----|
| [SAM 2: Segment Anything in Images and Videos](https://arxiv.org/abs/2408.00714) | Ravi et al. (Meta AI) | 2024 | Object-aware mask generation for color boundary detection |
| [Segment Anything](https://arxiv.org/abs/2304.02643) | Kirillov et al. (Meta AI) | 2023 | Foundation model for the SAM2 architecture |

### Super-Resolution
| Paper | Authors | Year | Use |
|-------|---------|------|-----|
| [Real-ESRGAN: Training Real-World Blind Super-Resolution with Pure Synthetic Data](https://arxiv.org/abs/2107.10833) | Wang et al. | 2021 | 2x/4x upscaling before separation for higher resolution output |
| [ESRGAN: Enhanced Super-Resolution Generative Adversarial Networks](https://arxiv.org/abs/1809.00219) | Wang et al. | 2018 | Foundation architecture for Real-ESRGAN |
| [BasicSR: Open Source Image and Video Restoration Toolbox](https://github.com/XPixelGroup/BasicSR) | XPixelGroup | 2022 | PyTorch framework for ESRGAN inference |

### Vectorization
| Paper | Authors | Year | Use |
|-------|---------|------|-----|
| [Potrace: Transforming bitmaps into vector graphics](https://potrace.sourceforge.net/potrace.pdf) | Selinger | 2003 | Cubic bezier tracing of binary plate masks — same engine as Inkscape's Trace Bitmap |

### Color Science
| Paper | Authors | Year | Use |
|-------|---------|------|-----|
| [The CIEDE2000 Color-Difference Formula](https://doi.org/10.1002/col.20070) | Sharma, Wu, Dalal | 2005 | Perceptual color distance for merge suggestions |
| [CIELAB Color Space](https://en.wikipedia.org/wiki/CIELAB_color_space) | CIE | 1976 | Perceptual color clustering via K-means in L\*a\*b\* |
| [Using K-Means for Color Quantization](https://scikit-learn.org/stable/auto_examples/cluster/plot_color_quantization.html) | scikit-learn | — | MiniBatchKMeans for fast color plate assignment |

### Edge Detection & Filtering
| Paper | Authors | Year | Use |
|-------|---------|------|-----|
| [A Computational Approach to Edge Detection](https://doi.org/10.1109/TPAMI.1986.4767851) | Canny | 1986 | Edge-aware plate boundary refinement |
| [Guided Image Filtering](https://doi.org/10.1109/TPAMI.2012.213) | He, Sun, Tang | 2013 | Edge-preserving smoothing on neutral plates |

### Libraries & Frameworks
| Project | Use |
|---------|-----|
| [PyTorch](https://pytorch.org/) | GPU inference for SAM2 and RealESRGAN |
| [Ultralytics](https://github.com/ultralytics/ultralytics) | SAM2.1 model loading and inference |
| [FastAPI](https://fastapi.tiangolo.com/) | Async Python backend with SSE streaming |
| [Next.js](https://nextjs.org/) | React frontend with standalone deployment |
| [potrace (pypotrace)](https://github.com/flupke/pypotrace) | Python bindings for the potrace library |
| [scikit-image](https://scikit-image.org/) | Contour finding, morphological operations |
| [OpenCV](https://opencv.org/) | Image resizing, color space conversion |
| [JSZip](https://stuk.github.io/jszip/) | Client-side ZIP generation for plate downloads |

## License

Copyright (c) 2026, Reid Surmeier. All rights reserved.<br>
Color.separator is provided under the [PolyForm Noncommercial 1.0.0](LICENSE) license for non-commercial use only.
