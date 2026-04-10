"use client";

import { useState, useCallback, useRef, useEffect, type ChangeEvent } from "react";
import {
  fetchPreviewStream,
  fetchPlatesStream,
  fetchUpscale,
  fetchMerge,
  fetchPlatesSvg,
  trackEvent,
  ApiError,
} from "@/lib/api";
import type { PlateStreamEvent } from "@/lib/api";
import { rgbToHex, hexToRgb } from "@/lib/colors";
import type { SeparationParams, Manifest, PreviewResult } from "@/lib/types";
import type { VersionId, PaletteColor, PlateImage, AppError } from "@/constants";

function toAppError(err: unknown): AppError {
  if (err instanceof ApiError) {
    return { message: err.message, retryable: err.retryable };
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return { message: "Request cancelled", retryable: false };
  }
  return {
    message: err instanceof Error ? err.message : "Unknown error",
    retryable: true,
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export function useColorSeparator() {
  // === File state ===
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [imageInfo, setImageInfo] = useState<{
    width: number;
    height: number;
    size: string;
    type: string;
  } | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [compositeUrl, setCompositeUrl] = useState<string | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [colors, setColors] = useState<PaletteColor[]>([]);

  // === Loading / error ===
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  // === Params ===
  const [plates, setPlates] = useState(4);
  const [dust, setDust] = useState(5);
  const [useEdges, setUseEdges] = useState(true);
  const [edgeSigma, setEdgeSigma] = useState(3.0);
  const [version, setVersion] = useState<VersionId>("v20");
  const [upscale, setUpscale] = useState(true);
  const [upscaleScale, setUpscaleScale] = useState<2 | 4>(2);
  const [medianSize, setMedianSize] = useState(5);
  const [chromaBoost, setChromaBoost] = useState(1.3);
  const [shadowThreshold, setShadowThreshold] = useState(8);
  const [highlightThreshold, setHighlightThreshold] = useState(95);
  const [nSegments, setNSegments] = useState(3000);
  const [compactness, setCompactness] = useState(15);
  const [crfSpatial, setCrfSpatial] = useState(3);
  const [crfColor, setCrfColor] = useState(13);
  const [crfCompat, setCrfCompat] = useState(10);
  const [sigmaS, setSigmaS] = useState(100);
  const [sigmaR, setSigmaR] = useState(0.5);
  const [meanshiftSp, setMeanshiftSp] = useState(15);
  const [meanshiftSr, setMeanshiftSr] = useState(30);
  const [detailStrength, setDetailStrength] = useState(0.5);

  // === UI state ===
  const [progressStage, setProgressStage] = useState<string | null>(null);
  const [progressPct, setProgressPct] = useState(0);
  const [partialResults, setPartialResults] = useState(false);
  const [plateProgressCurrent, setPlateProgressCurrent] = useState(0);
  const [plateProgressTotal, setPlateProgressTotal] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeGroups, setMergeGroups] = useState<number[][]>([]);
  const [activeMergeGroup, setActiveMergeGroup] = useState(0);
  const [zoomedPlate, setZoomedPlate] = useState<number | null>(null);
  const [plateImages, setPlateImages] = useState<PlateImage[]>([]);
  const [isLoadingPlates, setIsLoadingPlates] = useState(false);
  const [platesLoadedCount, setPlatesLoadedCount] = useState(0);
  const [platesTotalCount, setPlatesTotalCount] = useState(0);
  const [downloadProgress, setDownloadProgress] = useState<string | null>(null);
  const [upscaleHash, setUpscaleHash] = useState<string | null>(null);
  const [isUpscaling, setIsUpscaling] = useState(false);

  // === Refs ===
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paramChangeTrackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compositeUrlRef = useRef<string | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const plateUrlsRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // === Computed ===
  const hasCrfSliders = version === "v7" || version === "v8";
  const hasSuperpixelSliders = version === "v6";
  const hasV4Sliders = version === "v4";
  const hasUpscaleToggle =
    version === "v4" ||
    version === "v6" ||
    version === "v9" ||
    version === "v10" ||
    version === "v11" ||
    version === "v14" ||
    version === "v15" ||
    version === "v16" ||
    version === "v17" ||
    version === "v18" ||
    version === "v19" ||
    version === "v20";
  const hasChromaSlider =
    version === "v4" ||
    version === "v6" ||
    version === "v7" ||
    version === "v8" ||
    version === "v9" ||
    version === "v10" ||
    version === "v11" ||
    version === "v14" ||
    version === "v15" ||
    version === "v16" ||
    version === "v17" ||
    version === "v18" ||
    version === "v19" ||
    version === "v20";
  const hasV9Sliders =
    version === "v9" || version === "v10" || version === "v11" || version === "v14";
  const canCompare = compositeUrl !== null && sourceUrl !== null;
  const displayImage = showOriginal && canCompare ? sourceUrl : (compositeUrl ?? sourceUrl);

  // === Helpers ===
  const cleanupPlateUrls = useCallback(() => {
    for (const url of plateUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    plateUrlsRef.current = [];
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const cancelRequest = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
    setIsLoadingPlates(false);
    setProgressStage(null);
    setProgressPct(0);
  }, []);

  const resetUiOnError = useCallback(() => {
    setIsLoading(false);
    setIsLoadingPlates(false);
    setProgressStage(null);
    setProgressPct(0);
    setIsMerging(false);
    setDownloadProgress(null);
  }, []);

  // === Keyboard shortcuts: spacebar toggles comparison, Escape closes overlays ===
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        setShowOriginal((prev) => {
          const next = !prev;
          trackEvent('compare_toggle', { showing: next ? 'original' : 'composite' });
          return next;
        });
      }
      if (e.key === "Escape") {
        if (zoomedPlate !== null) setZoomedPlate(null);
        else if (showAbout) setShowAbout(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [zoomedPlate, showAbout]);

  // === Close nav on outside click (mobile) ===
  useEffect(() => {
    if (!navOpen) return;
    const handler = (e: MouseEvent) => {
      const nav = document.querySelector(".nav-panel");
      const burger = document.querySelector(".hamburger");
      if (nav && !nav.contains(e.target as Node) && burger && !burger.contains(e.target as Node)) {
        setNavOpen(false);
      }
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [navOpen]);

  const getParams = useCallback(
    (overrides?: Partial<SeparationParams>): SeparationParams => ({
      plates: overrides?.plates ?? plates,
      dust: overrides?.dust ?? dust,
      useEdges: overrides?.useEdges ?? useEdges,
      edgeSigma: overrides?.edgeSigma ?? edgeSigma,
      lockedColors: overrides?.lockedColors ?? colors.filter((c) => c.locked).map((c) => c.rgb),
      version: overrides?.version ?? version,
      upscale: overrides?.upscale ?? upscale,
      upscaleScale: overrides?.upscaleScale ?? upscaleScale,
      medianSize: overrides?.medianSize ?? medianSize,
      chromaBoost: overrides?.chromaBoost ?? chromaBoost,
      shadowThreshold: overrides?.shadowThreshold ?? shadowThreshold,
      highlightThreshold: overrides?.highlightThreshold ?? highlightThreshold,
      nSegments: overrides?.nSegments ?? nSegments,
      compactness: overrides?.compactness ?? compactness,
      crfSpatial: overrides?.crfSpatial ?? crfSpatial,
      crfColor: overrides?.crfColor ?? crfColor,
      crfCompat: overrides?.crfCompat ?? crfCompat,
      sigmaS: overrides?.sigmaS ?? sigmaS,
      sigmaR: overrides?.sigmaR ?? sigmaR,
      meanshiftSp: overrides?.meanshiftSp ?? meanshiftSp,
      meanshiftSr: overrides?.meanshiftSr ?? meanshiftSr,
      detailStrength: overrides?.detailStrength ?? detailStrength,
    }),
    [
      plates,
      dust,
      useEdges,
      edgeSigma,
      colors,
      version,
      upscale,
      medianSize,
      chromaBoost,
      shadowThreshold,
      highlightThreshold,
      nSegments,
      compactness,
      crfSpatial,
      crfColor,
      crfCompat,
      sigmaS,
      sigmaR,
      meanshiftSp,
      meanshiftSr,
      detailStrength,
      upscaleScale,
    ]
  );

  const stopProgress = useCallback(() => {
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    progressTimerRef.current = null;
    setProgressPct(100);
    setProgressStage(null);
  }, []);

  const fetchPlateImagesFromApi = useCallback(
    async (currentFile: File, params: SeparationParams, signal?: AbortSignal) => {
      setIsLoadingPlates(true);
      setPlatesLoadedCount(0);
      setPlatesTotalCount(params.plates);
      cleanupPlateUrls();
      setPlateImages([]);

      try {
        await fetchPlatesStream(
          currentFile,
          params,
          (evt: PlateStreamEvent) => {
            if (evt.type === "count") {
              setPlatesTotalCount(evt.total);
            } else if (evt.type === "plate") {
              const rawImage = evt.image!;
              // Handle both raw base64 and data URI formats
              const base64 = rawImage.startsWith("data:") ? rawImage.split(",")[1]! : rawImage;
              const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
              const blob = new Blob([bytes], { type: "image/png" });
              const url = URL.createObjectURL(blob);
              plateUrlsRef.current.push(url);
              setPlateImages((prev) => [
                ...prev,
                {
                  name: evt.name!,
                  url,
                  color: evt.color!,
                  coverage: evt.coverage ?? 0,
                  manifestIndex: evt.index ?? prev.length,
                  ...(evt.svg ? { svg: evt.svg } : {}),
                },
              ]);
              setPlatesLoadedCount((evt.index ?? 0) + 1);
            } else if (evt.type === "done") {
              setIsLoadingPlates(false);
            }
          },
          signal
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (
          err instanceof ApiError &&
          (err.code === "REQUEST_CANCELLED" || err.code === "NETWORK_ERROR")
        )
          return;
        console.debug("Plate stream failed:", err);
        setIsLoadingPlates(false);
      }
    },
    [cleanupPlateUrls]
  );

  const applyPreviewResult = useCallback((result: PreviewResult) => {
    if (compositeUrlRef.current) URL.revokeObjectURL(compositeUrlRef.current);
    compositeUrlRef.current = result.compositeUrl;
    setCompositeUrl(result.compositeUrl);
    setManifest(result.manifest);

    if (result.manifest.plates.length > 0) {
      setColors((prev) => {
        const locked = prev.filter((c) => c.locked);
        const detected = result.manifest.plates.map((p) => ({
          rgb: p.color,
          locked: false,
        }));
        if (locked.length === 0) return detected;
        return [...locked, ...detected.slice(locked.length)];
      });
    }
  }, []);

  const runPreview = useCallback(
    async (currentFile: File, params: SeparationParams) => {
      setIsLoading(true);
      setError(null);
      setPlateImages([]);
      setIsLoadingPlates(true);
      setPlatesLoadedCount(0);
      setPlatesTotalCount(params.plates);

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Start plates stream in parallel with preview stream (shares abort signal)
      const platesPromise = fetchPlateImagesFromApi(currentFile, params, controller.signal);

      try {
        setProgressPct(0);
        setProgressStage("Separating colors");
        setPartialResults(false);
        setPlateProgressCurrent(0);
        setPlateProgressTotal(0);
        trackEvent('process_start', {
          version: params.version,
          plates: params.plates,
          upscale: params.upscale,
          upscaleScale: params.upscaleScale,
          dust: params.dust,
        });
        const processStartTime = performance.now();
        const result = await fetchPreviewStream(
          currentFile,
          params,
          (stage, pct) => {
            if (stage === "plate_complete") {
              // pct encodes progress as a percentage; derive current plate from it.
              // The backend also sends plate_index/total_plates but fetchPreviewStream
              // only surfaces (stage, pct) to this callback.
              setPlateProgressTotal((prevTotal) => {
                const total = prevTotal > 0 ? prevTotal : params.plates;
                const current = Math.round((pct / 100) * total);
                setPlateProgressCurrent(current);
                return total;
              });
              setProgressStage("Separating plates");
              setProgressPct(pct);
            } else if (stage === "heartbeat") {
              // Heartbeat — connection is alive. Swallow silently so no error appears.
              // The existing timer-based fallback continues unaffected.
            } else if (stage === "still_processing") {
              setProgressStage("Still processing...");
              if (pct >= 0) setProgressPct(pct);
            } else if (stage === "partial_complete") {
              setPartialResults(true);
              setPlateProgressTotal((prevTotal) => {
                const total = prevTotal > 0 ? prevTotal : params.plates;
                const completed = Math.round((pct / 100) * total);
                setPlateProgressCurrent(completed);
                return total;
              });
              setProgressStage("Partial results");
              setProgressPct(pct);
            } else {
              setProgressStage(stage);
              setProgressPct(pct);
            }
          },
          controller.signal
        );
        applyPreviewResult(result);
        trackEvent('process_complete', {
          version: params.version,
          plates: params.plates,
          durationMs: Math.round(performance.now() - processStartTime),
          cached: !!(result as { cached?: boolean }).cached,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Preview failed:", err);
        const appErr = toAppError(err);
        trackEvent('error', {
          message: appErr.message,
          endpoint: 'preview',
          code: err instanceof ApiError ? err.code : undefined,
        });
        setError(appErr);
        resetUiOnError();
        return;
      } finally {
        stopProgress();
        setIsLoading(false);
        if (abortRef.current === controller) abortRef.current = null;
      }

      // Await plates to surface errors (they log internally but don't block UI)
      await platesPromise;
    },
    [stopProgress, applyPreviewResult, fetchPlateImagesFromApi, resetUiOnError]
  );

  const schedulePreview = useCallback(
    (currentFile: File, params: SeparationParams) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        runPreview(currentFile, params);
      }, 1_200);
    },
    [runPreview]
  );

  const handleFileSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      setFile(f);
      setFileName(f.name);
      setError(null);
      const imgEl = new window.Image();
      const objUrl = URL.createObjectURL(f);
      imgEl.onload = () => {
        setImageInfo({
          width: imgEl.naturalWidth,
          height: imgEl.naturalHeight,
          size:
            f.size > 1024 * 1024
              ? (f.size / 1024 / 1024).toFixed(1) + "MB"
              : Math.round(f.size / 1024) + "KB",
          type: f.type.replace("image/", "") || "unknown",
        });
        trackEvent('file_upload', {
          width: imgEl.naturalWidth,
          height: imgEl.naturalHeight,
          sizeKb: Math.round(f.size / 1024),
          type: f.type,
          name: f.name,
        });
        URL.revokeObjectURL(objUrl);
      };
      imgEl.src = objUrl;
      setUpscaleHash(null);
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      const url = URL.createObjectURL(f);
      sourceUrlRef.current = url;
      setSourceUrl(url);
      setCompositeUrl(null);
      setManifest(null);
      setColors([]);
      setPlateImages([]);
      cleanupPlateUrls();

      if (upscale) {
        setIsUpscaling(true);
        fetchUpscale(f)
          .then((result) => setUpscaleHash(result.hash))
          .catch((err) => console.error("Upscale cache failed:", err))
          .finally(() => setIsUpscaling(false));
      }
    },
    [upscale, cleanupPlateUrls]
  );

  const handleProcess = useCallback(() => {
    if (!file) return;
    runPreview(file, getParams());
  }, [file, getParams, runPreview]);

  const handleReset = useCallback(() => {
    if (compositeUrlRef.current) {
      URL.revokeObjectURL(compositeUrlRef.current);
      compositeUrlRef.current = null;
    }
    setCompositeUrl(null);
    setManifest(null);
    setColors([]);
    setShowOriginal(false);
    setPlateImages([]);
    cleanupPlateUrls();
    setError(null);
    trackEvent('reset', {});
  }, [cleanupPlateUrls]);

  const handleParamChange = useCallback(
    (key: string, value: number | boolean) => {
      const setters: Record<string, (v: never) => void> = {
        plates: ((v: number) => setPlates(Math.max(2, v))) as (v: never) => void,
        dust: setDust as (v: never) => void,
        useEdges: setUseEdges as (v: never) => void,
        edgeSigma: setEdgeSigma as (v: never) => void,
        medianSize: setMedianSize as (v: never) => void,
        chromaBoost: setChromaBoost as (v: never) => void,
        shadowThreshold: setShadowThreshold as (v: never) => void,
        highlightThreshold: setHighlightThreshold as (v: never) => void,
        nSegments: setNSegments as (v: never) => void,
        compactness: setCompactness as (v: never) => void,
        crfSpatial: setCrfSpatial as (v: never) => void,
        crfColor: setCrfColor as (v: never) => void,
        crfCompat: setCrfCompat as (v: never) => void,
        sigmaS: setSigmaS as (v: never) => void,
        sigmaR: setSigmaR as (v: never) => void,
        meanshiftSp: setMeanshiftSp as (v: never) => void,
        meanshiftSr: setMeanshiftSr as (v: never) => void,
        detailStrength: setDetailStrength as (v: never) => void,
        upscaleScale: setUpscaleScale as (v: never) => void,
      };
      setters[key]?.(value as never);
      if (paramChangeTrackRef.current) clearTimeout(paramChangeTrackRef.current);
      paramChangeTrackRef.current = setTimeout(() => {
        trackEvent('param_change', { param: key, value, version });
      }, 1000);
      if (file && compositeUrl) {
        const overrides = { [key]: value };
        schedulePreview(file, getParams(overrides));
      }
    },
    [file, compositeUrl, schedulePreview, getParams, version]
  );

  const handleColorChange = useCallback((index: number, hex: string) => {
    const rgb = hexToRgb(hex);
    setColors((prev) => {
      const next = [...prev];
      if (next[index]) {
        next[index] = { rgb, locked: true };
      }
      return next;
    });
  }, []);

  const handleToggleLock = useCallback((index: number) => {
    setColors((prev) => {
      const next = [...prev];
      if (next[index]) {
        next[index] = { ...next[index], locked: !next[index].locked };
      }
      return next;
    });
  }, []);

  const handleRemoveColor = useCallback((index: number) => {
    setColors((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAddColor = useCallback(() => {
    setColors((prev) => [...prev, { rgb: [128, 128, 128], locked: true }]);
  }, []);

  const generateDiagram = useCallback(
    async (
      compositeImgUrl: string,
      plateImgs: PlateImage[],
      sourceImgUrl: string
    ): Promise<Blob> => {
      const [compositeImg, sourceImg] = await Promise.all([
        loadImage(compositeImgUrl),
        loadImage(sourceImgUrl),
      ]);
      const plateLoadedImgs: HTMLImageElement[] = [];
      for (const p of plateImgs) {
        plateLoadedImgs.push(await loadImage(p.url));
      }

      // Helper: pick shortest label that fits within maxWidth, truncating with ellipsis
      function fitLabel(c: CanvasRenderingContext2D, labels: string[], maxWidth: number): string {
        for (const label of labels) {
          if (c.measureText(label).width <= maxWidth) return label;
        }
        let s = labels[labels.length - 1] ?? "";
        while (s.length > 1 && c.measureText(s + "…").width > maxWidth) {
          s = s.slice(0, -1);
        }
        return s + "…";
      }

      // Helper: relative luminance (0–1) using perceptual weights
      function luminance(r: number, g: number, b: number): number {
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      }

      const padding = 32;
      const topLabelHeight = 28; // height reserved ABOVE each top-row image for "ORIGINAL"/"COMPOSITE"
      const plateLabelHeight = 28; // height reserved ABOVE each plate image for swatch bar
      const separatorH = 2; // visible separator line thickness
      const separatorGap = padding; // space above and below separator

      const cols = Math.min(plateImgs.length, 4);
      const rows = Math.ceil(plateImgs.length / cols);

      // Top row: original + composite side by side, scaled to composite height
      const topH = compositeImg.height;
      const sourceW = Math.round((sourceImg.width / sourceImg.height) * topH);
      const compositeW = compositeImg.width;
      const topRowW = sourceW + padding + compositeW;

      const canvasW = topRowW + padding * 2;

      // Plate grid spans full canvas width minus outer padding
      const plateW = Math.floor((canvasW - padding * (cols + 1)) / cols);
      const plateH = Math.floor((compositeImg.height / compositeImg.width) * plateW);

      // Layout from top to bottom:
      //   padding
      //   topLabelHeight        (text "ORIGINAL" / "COMPOSITE")
      //   topH                  (source + composite images)
      //   separatorGap
      //   separatorH            (divider line)
      //   separatorGap
      //   rows × (plateLabelHeight + plateH + padding)
      //   padding (bottom)
      const canvasH =
        padding +
        topLabelHeight +
        topH +
        separatorGap +
        separatorH +
        separatorGap +
        rows * (plateLabelHeight + plateH + padding) +
        padding;

      const canvas = document.createElement("canvas");
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext("2d")!;

      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvasW, canvasH);

      // --- Top row labels ABOVE images ---
      const topLabelFontSize = Math.max(14, Math.floor(canvasW / 40));
      ctx.font = `bold ${topLabelFontSize}px monospace`;
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#000";

      const origX = padding;
      const compX = padding + sourceW + padding;
      const topLabelY = padding + topLabelHeight / 2;

      ctx.fillText(fitLabel(ctx, ["ORIGINAL"], sourceW - 4), origX + 2, topLabelY);
      ctx.fillText(fitLabel(ctx, ["COMPOSITE"], compositeW - 4), compX + 2, topLabelY);

      // --- Top row images ---
      const imageY = padding + topLabelHeight;
      ctx.drawImage(sourceImg, origX, imageY, sourceW, topH);
      ctx.drawImage(compositeImg, compX, imageY, compositeW, topH);

      // Borders around top row images
      ctx.strokeStyle = "#ccc";
      ctx.lineWidth = 1;
      ctx.strokeRect(origX, imageY, sourceW, topH);
      ctx.strokeRect(compX, imageY, compositeW, topH);

      // --- Separator line ---
      const separatorY = imageY + topH + separatorGap;
      ctx.fillStyle = "#ddd";
      ctx.fillRect(padding, separatorY, canvasW - padding * 2, separatorH);

      // --- Plate grid ---
      const plateStartY = separatorY + separatorH + separatorGap;
      const plateLabelFontSize = Math.max(10, Math.floor(canvasW / 60));

      for (let i = 0; i < plateImgs.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = padding + col * (plateW + padding);
        // Each row: plateLabelHeight (swatch bar) + plateH (image) + padding (gap below)
        const rowY = plateStartY + row * (plateLabelHeight + plateH + padding);

        const hex = rgbToHex(plateImgs[i].color);
        const [r, g, b] = plateImgs[i].color;
        const lum = luminance(r, g, b);

        // Swatch bar ABOVE plate image
        ctx.fillStyle = hex;
        ctx.fillRect(x, rowY, plateW, plateLabelHeight);

        // Label text with contrast-aware color (threshold 0.45)
        ctx.font = `${plateLabelFontSize}px monospace`;
        ctx.textBaseline = "middle";
        ctx.fillStyle = lum > 0.25 ? "#000" : "#fff";
        const maxLabelW = plateW - 12;
        const fullLabel = `${plateImgs[i].name}  ${hex}  ${plateImgs[i].coverage.toFixed(1)}%`;
        const medLabel = `${hex}  ${plateImgs[i].coverage.toFixed(1)}%`;
        const shortLabel = hex;
        const label = fitLabel(ctx, [fullLabel, medLabel, shortLabel], maxLabelW);
        ctx.fillText(label, x + 6, rowY + plateLabelHeight / 2);

        // Plate image below swatch bar
        const plateImgY = rowY + plateLabelHeight;
        if (plateLoadedImgs[i]) {
          ctx.drawImage(plateLoadedImgs[i], x, plateImgY, plateW, plateH);
        }

        // Border around plate image only (not swatch)
        ctx.strokeStyle = "#ccc";
        ctx.lineWidth = 1;
        ctx.strokeRect(x, plateImgY, plateW, plateH);
      }

      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob!), "image/png");
      });
    },
    []
  );

  const handleDownload = useCallback(async () => {
    if (!file) return;
    setIsLoading(true);
    setError(null);
    setDownloadProgress("building ZIP...");
    setProgressStage("Building ZIP");
    setProgressPct(0);
    trackEvent('download_start', { plates: plateImages.length, hasUpscale: upscale });
    trackEvent('zip_download', { plates: getParams().plates, upscale: getParams().upscale });
    const zipStartTime = performance.now();
    const downloadStartTime = performance.now();
    try {
      // Build ZIP entirely client-side from cached composite + plates (no backend re-call)
      const JSZip = (await import("jszip")).default;
      const newZip = new JSZip();

      // Fetch composite blob from cached URL
      if (compositeUrl) {
        setDownloadProgress("adding composite...");
        setProgressPct(10);
        const compRes = await fetch(compositeUrl);
        const compBlob = await compRes.blob();
        newZip.file("composite.png", compBlob, { compression: "STORE" });
      }

      // Fetch all plate images in parallel from cached blob URLs
      setDownloadProgress(`adding ${plateImages.length} plates...`);
      const plateBlobs = await Promise.all(
        plateImages.map(async (plate, i) => {
          const res = await fetch(plate.url);
          const blob = await res.blob();
          return { plate, blob, index: i };
        })
      );
      setProgressPct(40);

      // Add plates to ZIP with color hex names
      for (const { plate, blob, index } of plateBlobs) {
        const hex = rgbToHex(plate.color).replace("#", "").toUpperCase();
        newZip.file(`png/${plate.name}_${hex}.png`, blob, { compression: "STORE" });
        if (index % 10 === 0) {
          setProgressPct(40 + Math.round((index / plateBlobs.length) * 20));
          setDownloadProgress(`adding plates ${index + 1}/${plateBlobs.length}`);
        }
      }

      // Fetch high-res SVGs from dedicated endpoint
      setDownloadProgress("fetching high-res SVGs...");
      try {
        const hiResSvgs = await fetchPlatesSvg(file, getParams());
        for (const svg of hiResSvgs) {
          const hex = rgbToHex(svg.color).replace("#", "").toUpperCase();
          newZip.file(`svg/${svg.name}_${hex}.svg`, svg.svg);
        }

        // Replace low-res PNGs with full-res ones from the SVG endpoint
        if (hiResSvgs.some((s) => s.png_b64)) {
          for (const { plate } of plateBlobs) {
            const hex = rgbToHex(plate.color).replace("#", "").toUpperCase();
            newZip.remove(`png/${plate.name}_${hex}.png`);
          }
          for (const svg of hiResSvgs) {
            if (svg.png_b64) {
              const hex = rgbToHex(svg.color).replace("#", "").toUpperCase();
              const bytes = Uint8Array.from(atob(svg.png_b64), (c) => c.charCodeAt(0));
              const blob = new Blob([bytes], { type: "image/png" });
              newZip.file(`png/${svg.name}_${hex}.png`, blob, { compression: "STORE" });
            }
          }
        }

        setProgressPct(65);
      } catch (err) {
        console.error("High-res SVG/PNG fetch failed:", err);
        setDownloadProgress("WARNING: high-res generation failed — ZIP contains low-res 800px thumbnails");
        await new Promise((r) => setTimeout(r, 3000)); // Show warning for 3s
        for (const { plate } of plateBlobs) {
          if (plate.svg) {
            const hex = rgbToHex(plate.color).replace("#", "").toUpperCase();
            newZip.file(`svg/${plate.name}_${hex}.svg`, plate.svg);
          }
        }
        setProgressPct(65);
      }

      // Add original source image
      newZip.file("original.png", file, { compression: "STORE" });

      // Add manifest
      if (manifest) {
        newZip.file("manifest.json", JSON.stringify(manifest, null, 2));
      }

      // Generate diagram
      if (compositeUrl && sourceUrl && plateImages.length > 0 && manifest) {
        setDownloadProgress("generating diagram...");
        setProgressPct(70);
        const diagramBlob = await generateDiagram(compositeUrl, plateImages, sourceUrl);
        newZip.file("diagram.png", diagramBlob, { compression: "STORE" });
      }
      setProgressPct(80);

      setDownloadProgress("compressing ZIP...");
      const finalBlob = await newZip.generateAsync(
        { type: "blob", compression: "DEFLATE", compressionOptions: { level: 1 } },
        (meta) => {
          const pct = 80 + Math.round(meta.percent * 0.2);
          setProgressPct(pct);
          setDownloadProgress(`compressing ${Math.round(meta.percent)}%`);
        }
      );
      setProgressPct(100);
      setDownloadProgress("done");

      trackEvent('zip_complete', { plates: getParams().plates, duration_ms: Math.round(performance.now() - zipStartTime) });
      trackEvent('download_complete', {
        plates: plateImages.length,
        durationMs: Math.round(performance.now() - downloadStartTime),
        zipSizeKb: Math.round(finalBlob.size / 1024),
      });
      const url = URL.createObjectURL(finalBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "color-separator-plates.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download failed:", err);
      const appErr = toAppError(err);
      trackEvent('error', {
        message: appErr.message,
        endpoint: 'download',
        code: err instanceof ApiError ? err.code : undefined,
      });
      setError(appErr);
    } finally {
      setIsLoading(false);
      setDownloadProgress(null);
      setProgressStage(null);
      setProgressPct(0);
    }
  }, [file, manifest, compositeUrl, sourceUrl, plateImages, generateDiagram, getParams]);

  const addMergeGroup = useCallback(() => {
    setMergeGroups((prev) => {
      const next = [...prev, []];
      setActiveMergeGroup(next.length - 1);
      return next;
    });
  }, []);

  const removeMergeGroup = useCallback((index: number) => {
    setMergeGroups((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setActiveMergeGroup((active) => {
        if (next.length === 0) return 0;
        return Math.min(active, next.length - 1);
      });
      return next;
    });
  }, []);

  const togglePlateInGroup = useCallback((displayIndex: number) => {
    // displayIndex is the position in plateImages array (NOT manifestIndex from stream)
    setMergeGroups((prev) => {
      // Always use group 0 — simplified single-selection model
      const group0 = prev[0] ?? [];
      const updated = group0.includes(displayIndex)
        ? group0.filter((p) => p !== displayIndex)
        : [...group0, displayIndex];
      return [updated];
    });
  }, []);

  const handleMerge = useCallback(async () => {
    const validGroups = mergeGroups.filter((g) => g.length >= 2);
    if (!file || validGroups.length === 0 || !manifest) return;
    setIsMerging(true);
    setIsLoading(true);
    setProgressStage("Merging plates...");
    setProgressPct(0);
    setError(null);
    trackEvent('merge', {
      plateIndices: validGroups.flat(),
      plateCount: plateImages.length,
      pair_count: mergeGroups.flat().length,
    });
    try {
      // mergeGroups stores DISPLAY indices (position in plateImages array).
      // Map to K-means centroid indices via manifest.plates[displayIdx].index.
      // manifest.plates is in brightness order — same order as plateImages display.
      const pairs: number[][] = [];
      for (const group of validGroups) {
        const centroidIndices = group.map((displayIdx) => {
          const plate = manifest.plates[displayIdx];
          // Fall back to displayIdx if backend didn't include index field
          return plate?.index ?? displayIdx;
        });
        console.debug("[merge] display indices:", group, "→ centroid indices:", centroidIndices);
        for (let i = 1; i < centroidIndices.length; i++) {
          pairs.push([centroidIndices[0]!, centroidIndices[i]!]);
        }
      }
      const result = await fetchMerge(file, getParams(), pairs, upscaleHash);
      if (compositeUrlRef.current) URL.revokeObjectURL(compositeUrlRef.current);
      compositeUrlRef.current = result.compositeUrl;
      setCompositeUrl(result.compositeUrl);
      setManifest(result.manifest);
      if (result.manifest.plates.length > 0) {
        setColors(result.manifest.plates.map((p) => ({ rgb: p.color, locked: false })));
      }
      setMergeMode(false);
      setMergeGroups([]);
      setActiveMergeGroup(0);
      setProgressStage("Loading merged plates...");
      setProgressPct(50);
      await fetchPlateImagesFromApi(file, getParams({ plates: result.manifest.plates.length }));
    } catch (err) {
      console.error("Merge failed:", err);
      const appErr = toAppError(err);
      trackEvent('error', {
        message: appErr.message,
        endpoint: 'merge',
        code: err instanceof ApiError ? err.code : undefined,
      });
      setError(appErr);
    } finally {
      setIsMerging(false);
      setIsLoading(false);
      setProgressStage(null);
      setProgressPct(0);
    }
  }, [file, mergeGroups, manifest, getParams, upscaleHash, fetchPlateImagesFromApi]);

  const handlePrepareCnc = useCallback(() => {
    if (!manifest || !compositeUrl) return;
    const cncPlates = plateImages.map((p, i) => {
      const manifestPlate = manifest.plates[i];
      return {
        name: manifestPlate?.name ?? p.name,
        color: p.color,
        // Use PNG data URL as fallback — CNC page accepts either SVG or PNG
        svg: p.svg ?? null,
        pngUrl: p.url,
      };
    });
    const payload = JSON.stringify({ plates: cncPlates, manifest });
    sessionStorage.setItem("cnc-plates", payload);
    window.location.href = "/cnc";
  }, [manifest, compositeUrl, plateImages]);

  const handlePlateZoom = useCallback((index: number | null) => {
    if (index !== null) {
      const plate = plateImages[index];
      trackEvent('plate_zoom', {
        plateIndex: index,
        color: plate ? rgbToHex(plate.color) : undefined,
      });
    }
    setZoomedPlate(index);
  }, [plateImages]);

  // Returns merge groups auto-selected from manifest.merge_suggestions where delta_e < threshold.
  // Groups connected plates (transitive closure) so A-B and B-C become one group [A,B,C].
  const autoSuggestMerge = useCallback(
    (deltaEThreshold = 10): number[][] => {
      const suggestions = manifest?.merge_suggestions;
      if (!suggestions || suggestions.length === 0) return [];

      const similar = suggestions.filter((s) => s.delta_e < deltaEThreshold);
      if (similar.length === 0) return [];

      // Union-find to group connected plates
      const parent = new Map<number, number>();
      const find = (x: number): number => {
        if (!parent.has(x)) parent.set(x, x);
        const p = parent.get(x)!;
        if (p !== x) {
          const root = find(p);
          parent.set(x, root);
          return root;
        }
        return x;
      };
      const union = (a: number, b: number) => {
        parent.set(find(a), find(b));
      };

      for (const s of similar) {
        union(s.plate_a, s.plate_b);
      }

      const groups = new Map<number, number[]>();
      const allPlates = new Set(similar.flatMap((s) => [s.plate_a, s.plate_b]));
      for (const p of allPlates) {
        const root = find(p);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root)!.push(p);
      }

      return Array.from(groups.values()).filter((g) => g.length >= 2);
    },
    [manifest]
  );

  // Pairs of similar plates from manifest, sorted by delta_e ascending (most similar first).
  const mergeSuggestions = manifest?.merge_suggestions
    ? [...manifest.merge_suggestions].sort((a, b) => a.delta_e - b.delta_e)
    : [];

  return {
    // File
    file,
    fileName,
    imageInfo,
    sourceUrl,
    compositeUrl,
    manifest,
    colors,
    // Loading / error
    isLoading,
    error,
    clearError,
    cancelRequest,
    // Params
    version,
    setVersion,
    plates,
    dust,
    useEdges,
    edgeSigma,
    upscale,
    setUpscale,
    upscaleScale,
    setUpscaleScale,
    medianSize,
    chromaBoost,
    shadowThreshold,
    highlightThreshold,
    nSegments,
    compactness,
    crfSpatial,
    crfColor,
    crfCompat,
    sigmaS,
    sigmaR,
    meanshiftSp,
    meanshiftSr,
    detailStrength,
    // Progress
    progressStage,
    progressPct,
    partialResults,
    plateProgressCurrent,
    plateProgressTotal,
    // UI
    showOriginal,
    setShowOriginal,
    navOpen,
    setNavOpen,
    showAbout,
    setShowAbout,
    mergeMode,
    setMergeMode,
    isMerging,
    mergeGroups,
    setMergeGroups,
    activeMergeGroup,
    setActiveMergeGroup,
    addMergeGroup,
    removeMergeGroup,
    togglePlateInGroup,
    zoomedPlate,
    setZoomedPlate: handlePlateZoom,
    plateImages,
    isLoadingPlates,
    platesLoadedCount,
    platesTotalCount,
    downloadProgress,
    isUpscaling,
    // Computed
    hasCrfSliders,
    hasSuperpixelSliders,
    hasV4Sliders,
    hasUpscaleToggle,
    hasChromaSlider,
    hasV9Sliders,
    canCompare,
    displayImage,
    // Handlers
    handleFileSelect,
    handleProcess,
    handleReset,
    handleParamChange,
    handleColorChange,
    handleToggleLock,
    handleRemoveColor,
    handleAddColor,
    handleDownload,
    handleMerge,
    handlePrepareCnc,
    autoSuggestMerge,
    mergeSuggestions,
    // Refs
    fileInputRef,
  };
}
