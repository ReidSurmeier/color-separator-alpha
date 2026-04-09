"use client";

import { useEffect, useRef, useState } from "react";

interface ProgressBarProps {
  isLoading: boolean;
  progressStage: string | null;
  progressPct: number;
  plateProgress?: { current: number; total: number };
  partialResults?: boolean;
  downloadProgress?: string | null;
}

const STAGE_LABELS: Record<string, string> = {
  // v20 stages
  "Upscaling image (4×)": "upscaling 4×",
  "Upscaling image (2x)": "upscaling 2×",
  "Upscaling image": "upscaling",
  "Detecting strokes": "detecting strokes",
  "Segmenting objects (SAM)": "SAM segmentation",
  "Merging regions": "merging regions",
  "Clustering colors": "clustering colors",
  Clustering: "clustering",
  "Smoothing plates": "smoothing plates",
  "Filling strokes": "filling strokes",
  "Detecting edges": "detecting edges",
  "Correcting holes": "correcting holes",
  "Cleaning up": "cleanup",
  "Building output": "building output",
  // main.py stages
  "Separating colors": "separating colors",
  "Separating plates": "separating plates",
  "Pre-processing": "pre-processing",
  "Running SAM segmentation": "SAM segmentation",
  "Building composite": "building composite",
  "Generating plates": "generating plates",
  "Encoding result": "encoding",
  "Building ZIP": "building ZIP",
  // status/meta stages
  "Still processing...": "processing",
  "Partial results": "partial",
  heartbeat: "processing",
  plate_complete: "plates",
  partial_complete: "partial",
  complete: "complete",
};

// Match "Processing plate 3/8" — stage comes pre-interpolated from backend
const PLATE_STAGE_RE = /^Processing plate (\d+)\/(\d+)$/;

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export default function ProgressBar({
  isLoading,
  progressStage,
  progressPct,
  plateProgress,
  partialResults,
  downloadProgress,
}: ProgressBarProps) {
  const [elapsed, setElapsed] = useState(0);
  const t0 = useRef<number>(0);
  const iv = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stall detection
  const [stalled, setStalled] = useState(false);
  const lastPctRef = useRef<number>(-1);
  const lastPctTimeRef = useRef<number>(0);

  useEffect(() => {
    if (isLoading) {
      t0.current = Date.now();
      lastPctRef.current = -1;
      lastPctTimeRef.current = Date.now();
      iv.current = setInterval(() => {
        const now = Date.now();
        setElapsed(now - t0.current);
        setStalled(now - lastPctTimeRef.current > 3000);
      }, 500);
    } else {
      if (iv.current) clearInterval(iv.current);
      iv.current = null;
    }
    return () => {
      if (iv.current) clearInterval(iv.current);
    };
  }, [isLoading]);

  // Track pct changes — reset stall timer (ref-only, no setState needed;
  // the interval's setStalled call will pick up the new timestamp)
  useEffect(() => {
    if (progressPct !== lastPctRef.current) {
      lastPctRef.current = progressPct;
      lastPctTimeRef.current = Date.now();
    }
  }, [progressPct]);

  if (!isLoading && !partialResults) return null;
  if (!progressStage && !partialResults) return null;

  const pct = progressPct > 0 ? progressPct : 0;

  // Check for pre-interpolated "Processing plate N/M" stage from backend
  const plateStageMatch = progressStage ? PLATE_STAGE_RE.exec(progressStage) : null;

  let label: string;
  let plateText: string | null = null;

  if (plateStageMatch) {
    // Backend already gives us the plate numbers in the stage string
    label = "plates";
    plateText = `${plateStageMatch[1]}/${plateStageMatch[2]}`;
  } else {
    label = STAGE_LABELS[progressStage ?? ""] ?? progressStage ?? "";
    // plateProgress from SSE plate_complete events
    const plate =
      plateProgress && plateProgress.total > 0 && plateProgress.current > 0 ? plateProgress : null;
    if (plate) {
      plateText = `${plate.current}/${plate.total}`;
    }
  }

  let eta = "";
  if (pct > 5 && elapsed > 3000 && pct < 98) {
    const left = (elapsed / pct) * (100 - pct);
    eta = `~${fmt(left)} left`;
  }

  const isIndeterminate = (pct === 0 && isLoading) || stalled;

  return (
    <div
      className="progress-bar-root"
      role="progressbar"
      aria-live="polite"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label || "Processing"}
    >
      <div className="progress-bar-track">
        <div
          className="progress-bar-fill"
          style={{ width: pct > 0 ? `${pct}%` : "0%" }}
          data-indeterminate={isIndeterminate ? "true" : undefined}
        />
      </div>
      <span className="progress-bar-label">
        {downloadProgress ?? (
          <>
            {label}
            {plateText && ` ${plateText}`}
            {!plateText && pct > 0 && ` ${pct}%`}
          </>
        )}
      </span>
      <span className="progress-bar-time">{fmt(elapsed)}</span>
      {eta && <span className="progress-bar-eta">{eta}</span>}
    </div>
  );
}
