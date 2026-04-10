import type { Manifest, PreviewResult, SeparationParams, OptimizeIteration } from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "";

// Per-endpoint timeout defaults (ms)
const TIMEOUTS = {
  health: 5_000,
  preview: 120_000,
  previewStream: 600_000, // was 180_000 -- needed for 35-plate SAM runs
  separate: 600_000, // was 180_000
  merge: 120_000,
  upscale: 300_000,
  autoOptimize: 300_000,
  platesStream: 600_000, // was 180_000
} as const;

// Retry configuration
const RETRY_STATUS_CODES = new Set([408, 429, 502, 503, 524]);
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "SERVER_OVERLOADED"
  | "GPU_COLD_START"
  | "BACKEND_DOWN"
  | "RATE_LIMITED"
  | "REQUEST_CANCELLED"
  | "STREAM_ERROR"
  | "UNKNOWN";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: ApiErrorCode,
    status: number | null = null,
    retryable = false
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------
// Request deduplication
// ---------------------------------------------------------------------------

const inflightRequests = new Map<string, Promise<unknown>>();

function deduplicationKey(endpoint: string, file: File, params?: SeparationParams): string {
  const parts = [endpoint, file.name, file.size.toString(), file.lastModified.toString()];
  if (params) {
    parts.push(params.version, String(params.plates), String(params.dust));
  }
  return parts.join("|");
}

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

function logRequest(method: string, url: string, extra?: Record<string, unknown>) {
  console.debug(`[api] ${method} ${url}`, extra ?? "");
}

function logResponse(url: string, status: number, durationMs: number) {
  console.debug(`[api] ${url} → ${status} (${durationMs}ms)`);
}

function logError(url: string, err: unknown) {
  console.debug(`[api] ${url} ERROR:`, err);
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxRetries = MAX_RETRIES
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Merge caller signal with our timeout (cleanup listener to avoid leak)
    const onCallerAbort = () => controller.abort();
    if (init.signal) {
      init.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const start = performance.now();

    try {
      logRequest(init.method ?? "GET", url, { attempt });
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      logResponse(url, res.status, Math.round(performance.now() - start));

      // Don't retry on success or non-retryable status
      if (res.ok || !RETRY_STATUS_CODES.has(res.status) || attempt === maxRetries) {
        return res;
      }

      // Retryable error — wait and try again
      const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.debug(`[api] Retrying ${url} in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, delay));
      lastError = new ApiError(
        `Server returned ${res.status}`,
        res.status === 429 ? "RATE_LIMITED" : "SERVER_OVERLOADED",
        res.status,
        true
      );
    } catch (err) {
      clearTimeout(timer);
      logError(url, err);

      if (err instanceof DOMException && err.name === "AbortError") {
        // Check if the caller cancelled vs our timeout
        if (init.signal?.aborted) {
          throw new ApiError("Request cancelled", "REQUEST_CANCELLED");
        }
        throw new ApiError(`Request timed out after ${timeoutMs}ms`, "TIMEOUT", null, true);
      }

      // Network errors are retryable
      if (attempt < maxRetries) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.debug(`[api] Retrying ${url} in ${delay}ms after network error`);
        await new Promise((r) => setTimeout(r, delay));
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }

      throw new ApiError(err instanceof Error ? err.message : "Network error", "NETWORK_ERROR");
    }
  }

  throw lastError ?? new ApiError("Request failed after retries", "UNKNOWN");
}

// ---------------------------------------------------------------------------
// Response error handling
// ---------------------------------------------------------------------------

function throwForStatus(res: Response, context: string): void {
  if (res.ok) return;

  if (res.status === 503) {
    throw new ApiError(
      "Server overloaded — not enough memory for processing",
      "SERVER_OVERLOADED",
      503,
      true
    );
  }
  if (res.status === 504) {
    throw new ApiError(
      "GPU worker is starting up (~30s cold start). Please try again in a moment.",
      "GPU_COLD_START",
      504,
      true
    );
  }
  if (res.status === 429) {
    throw new ApiError("Too many requests — please wait a moment", "RATE_LIMITED", 429, true);
  }
  throw new ApiError(`${context} failed: ${res.status}`, "UNKNOWN", res.status);
}

// For 503 responses that may have a JSON body with details
async function throwForStatusWithBody(res: Response, context: string): Promise<void> {
  if (res.ok) return;

  if (res.status === 503) {
    try {
      const err = await res.json();
      const retryMsg = err.retry_after_seconds ? ` Try again in ${err.retry_after_seconds}s.` : "";
      throw new ApiError(
        (err.error || "Server overloaded — not enough memory for SAM processing") + retryMsg,
        "SERVER_OVERLOADED",
        503,
        true
      );
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(
        "Server overloaded — not enough memory for processing",
        "SERVER_OVERLOADED",
        503,
        true
      );
    }
  }

  throwForStatus(res, context);
}

// ---------------------------------------------------------------------------
// Manifest parsing (shared between preview/merge)
// ---------------------------------------------------------------------------

function parseManifestHeader(res: Response): Manifest {
  const manifestHeader = res.headers.get("X-Manifest");
  const raw = manifestHeader ? JSON.parse(manifestHeader) : { width: 0, height: 0, plates: [] };
  return {
    width: raw.width,
    height: raw.height,
    plates: (raw.plates || []).map((p: Record<string, unknown>) => ({
      name: p.name,
      color: p.color,
      coverage: p.coverage_pct ?? p.coverage ?? 0,
      index: p.index,
    })),
    ai_analysis: raw.ai_analysis ?? null,
    upscaled: raw.upscaled ?? false,
    merge_suggestions: raw.merge_suggestions ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// FormData builders
// ---------------------------------------------------------------------------

function buildFormData(file: File, params: SeparationParams): FormData {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("plates", String(params.plates));
  fd.append("dust", String(params.dust));
  fd.append("use_edges", String(params.useEdges));
  fd.append("edge_sigma", String(params.edgeSigma));
  fd.append("version", params.version);
  if (params.version === "v4") {
    if (params.upscale !== undefined) fd.append("upscale", String(params.upscale));
    if (params.upscaleScale !== undefined) fd.append("upscale_scale", String(params.upscaleScale));
    if (params.medianSize !== undefined) fd.append("median_size", String(params.medianSize));
    if (params.chromaBoost !== undefined) fd.append("chroma_boost", String(params.chromaBoost));
    if (params.shadowThreshold !== undefined)
      fd.append("shadow_threshold", String(params.shadowThreshold));
    if (params.highlightThreshold !== undefined)
      fd.append("highlight_threshold", String(params.highlightThreshold));
  }
  if (params.version === "v6") {
    if (params.nSegments !== undefined) fd.append("n_segments", String(params.nSegments));
    if (params.compactness !== undefined) fd.append("compactness", String(params.compactness));
    if (params.chromaBoost !== undefined) fd.append("chroma_boost", String(params.chromaBoost));
    if (params.upscale !== undefined) fd.append("upscale", String(params.upscale));
    if (params.upscaleScale !== undefined) fd.append("upscale_scale", String(params.upscaleScale));
    if (params.shadowThreshold !== undefined)
      fd.append("shadow_threshold", String(params.shadowThreshold));
    if (params.highlightThreshold !== undefined)
      fd.append("highlight_threshold", String(params.highlightThreshold));
  }
  if (params.version === "v7" || params.version === "v8") {
    if (params.crfSpatial !== undefined) fd.append("crf_spatial", String(params.crfSpatial));
    if (params.crfColor !== undefined) fd.append("crf_color", String(params.crfColor));
    if (params.crfCompat !== undefined) fd.append("crf_compat", String(params.crfCompat));
    if (params.chromaBoost !== undefined) fd.append("chroma_boost", String(params.chromaBoost));
    if (params.shadowThreshold !== undefined)
      fd.append("shadow_threshold", String(params.shadowThreshold));
    if (params.highlightThreshold !== undefined)
      fd.append("highlight_threshold", String(params.highlightThreshold));
  }
  if (["v9", "v10", "v11", "v12", "v13"].includes(params.version)) {
    if (params.sigmaS !== undefined) fd.append("sigma_s", String(params.sigmaS));
    if (params.sigmaR !== undefined) fd.append("sigma_r", String(params.sigmaR));
    if (params.meanshiftSp !== undefined) fd.append("meanshift_sp", String(params.meanshiftSp));
    if (params.meanshiftSr !== undefined) fd.append("meanshift_sr", String(params.meanshiftSr));
    if (params.chromaBoost !== undefined) fd.append("chroma_boost", String(params.chromaBoost));
    if (params.upscale !== undefined) fd.append("upscale", String(params.upscale));
    if (params.upscaleScale !== undefined) fd.append("upscale_scale", String(params.upscaleScale));
  }
  if (params.version === "v14") {
    if (params.sigmaS !== undefined) fd.append("sigma_s", String(params.sigmaS));
    if (params.sigmaR !== undefined) fd.append("sigma_r", String(params.sigmaR));
    if (params.meanshiftSp !== undefined) fd.append("meanshift_sp", String(params.meanshiftSp));
    if (params.meanshiftSr !== undefined) fd.append("meanshift_sr", String(params.meanshiftSr));
    if (params.chromaBoost !== undefined) fd.append("chroma_boost", String(params.chromaBoost));
    if (params.upscale !== undefined) fd.append("upscale", String(params.upscale));
    if (params.upscaleScale !== undefined) fd.append("upscale_scale", String(params.upscaleScale));
    if (params.detailStrength !== undefined)
      fd.append("detail_strength", String(params.detailStrength));
  }
  if (["v15", "v16", "v17", "v18", "v19", "v20"].includes(params.version)) {
    if (params.upscale !== undefined) fd.append("upscale", String(params.upscale));
    if (params.upscaleScale !== undefined) fd.append("upscale_scale", String(params.upscaleScale));
    if (params.chromaBoost !== undefined) fd.append("chroma_boost", String(params.chromaBoost));
    if (params.shadowThreshold !== undefined)
      fd.append("shadow_threshold", String(params.shadowThreshold));
    if (params.highlightThreshold !== undefined)
      fd.append("highlight_threshold", String(params.highlightThreshold));
    if (params.medianSize !== undefined) fd.append("median_size", String(params.medianSize));
  }
  if (params.lockedColors.length > 0) {
    fd.append("locked_colors", JSON.stringify(params.lockedColors));
  }
  return fd;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export interface HealthStatus {
  ok: boolean;
  ram_gb?: number;
  swap_gb?: number;
  sam_cached?: boolean;
  error?: string;
}

export async function checkHealth(): Promise<HealthStatus> {
  try {
    const res = await fetchWithRetry(
      `${BACKEND_URL}/api/health`,
      { method: "GET" },
      TIMEOUTS.health,
      1 // only 1 retry for health check
    );
    if (!res.ok) {
      return { ok: false, error: `Health check returned ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, ...data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Backend unreachable",
    };
  }
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function fetchPreview(
  file: File,
  params: SeparationParams,
  signal?: AbortSignal
): Promise<PreviewResult> {
  const key = deduplicationKey("preview", file, params);

  const existing = inflightRequests.get(key);
  if (existing) {
    console.debug("[api] Deduplicating preview request");
    return existing as Promise<PreviewResult>;
  }

  const promise = (async () => {
    try {
      const fd = buildFormData(file, params);
      const res = await fetchWithRetry(
        `${BACKEND_URL}/api/preview`,
        { method: "POST", body: fd, signal },
        TIMEOUTS.preview
      );
      await throwForStatusWithBody(res, "Preview");

      const manifest = parseManifestHeader(res);
      const blob = await res.blob();
      const compositeUrl = URL.createObjectURL(blob);
      return { compositeUrl, manifest };
    } finally {
      inflightRequests.delete(key);
    }
  })();

  inflightRequests.set(key, promise);
  return promise;
}

export async function fetchSeparation(
  file: File,
  params: SeparationParams,
  signal?: AbortSignal
): Promise<Blob> {
  const key = deduplicationKey("separate", file, params);

  const existing = inflightRequests.get(key);
  if (existing) {
    console.debug("[api] Deduplicating separation request");
    return existing as Promise<Blob>;
  }

  const promise = (async () => {
    try {
      const fd = buildFormData(file, params);
      const res = await fetchWithRetry(
        `${BACKEND_URL}/api/separate`,
        { method: "POST", body: fd, signal },
        TIMEOUTS.separate
      );
      await throwForStatusWithBody(res, "Separation");
      return res.blob();
    } finally {
      inflightRequests.delete(key);
    }
  })();

  inflightRequests.set(key, promise);
  return promise;
}

export async function fetchAutoOptimize(
  file: File,
  plates: number,
  onIteration: (data: OptimizeIteration) => void,
  signal?: AbortSignal
): Promise<void> {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("plates", String(plates));

  const res = await fetchWithRetry(
    `${BACKEND_URL}/api/auto-optimize`,
    { method: "POST", body: fd, signal },
    TIMEOUTS.autoOptimize,
    0 // no retries for streaming endpoints
  );

  if (!res.ok) {
    throw new ApiError(`Auto-optimize failed: ${res.status}`, "UNKNOWN", res.status);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new ApiError("No response body", "STREAM_ERROR");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice(6)) as OptimizeIteration;
        onIteration(data);
      }
    }
  }
}

export async function fetchUpscale(
  file: File,
  signal?: AbortSignal
): Promise<{ hash: string; cached: boolean; upscaled: boolean }> {
  const fd = new FormData();
  fd.append("image", file);
  const res = await fetchWithRetry(
    `${BACKEND_URL}/api/upscale`,
    { method: "POST", body: fd, signal },
    TIMEOUTS.upscale
  );
  if (!res.ok) {
    throw new ApiError(`Upscale failed: ${res.status}`, "UNKNOWN", res.status);
  }
  return res.json();
}

export async function fetchMerge(
  file: File,
  params: SeparationParams,
  mergePairs: number[][],
  imgHash?: string | null,
  signal?: AbortSignal
): Promise<PreviewResult> {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("merge_pairs", JSON.stringify(mergePairs));
  fd.append("plates", String(params.plates));
  fd.append("dust", String(params.dust));
  fd.append("version", params.version);
  if (params.sigmaS !== undefined) fd.append("sigma_s", String(params.sigmaS));
  if (params.sigmaR !== undefined) fd.append("sigma_r", String(params.sigmaR));
  if (params.meanshiftSp !== undefined) fd.append("meanshift_sp", String(params.meanshiftSp));
  if (params.meanshiftSr !== undefined) fd.append("meanshift_sr", String(params.meanshiftSr));
  if (params.chromaBoost !== undefined) fd.append("chroma_boost", String(params.chromaBoost));
  if (params.upscale !== undefined) fd.append("upscale", String(params.upscale));
  if (params.lockedColors.length > 0) {
    fd.append("locked_colors", JSON.stringify(params.lockedColors));
  }
  if (imgHash) fd.append("img_hash", imgHash);

  const res = await fetchWithRetry(
    `${BACKEND_URL}/api/merge`,
    { method: "POST", body: fd, signal },
    TIMEOUTS.merge
  );
  await throwForStatusWithBody(res, "Merge");

  const manifest = parseManifestHeader(res);
  const blob = await res.blob();
  const compositeUrl = URL.createObjectURL(blob);
  return { compositeUrl, manifest };
}

// ---------------------------------------------------------------------------
// Streaming endpoints
// ---------------------------------------------------------------------------

export interface PlateStreamEvent {
  type: "count" | "plate" | "done" | "error";
  total: number;
  index?: number;
  name?: string;
  color?: [number, number, number];
  coverage?: number;
  image?: string;
  svg?: string;
}

export async function fetchPlatesStream(
  file: File,
  params: SeparationParams,
  onEvent: (evt: PlateStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("plates", String(params.plates));
  fd.append("dust", String(params.dust));
  fd.append("version", params.version);
  fd.append("upscale", String(params.upscale ?? true));
  fd.append("chroma_boost", String(params.chromaBoost ?? 1.3));
  if (params.sigmaS !== undefined) fd.append("sigma_s", String(params.sigmaS));
  if (params.sigmaR !== undefined) fd.append("sigma_r", String(params.sigmaR));
  if (params.meanshiftSp !== undefined) fd.append("meanshift_sp", String(params.meanshiftSp));
  if (params.meanshiftSr !== undefined) fd.append("meanshift_sr", String(params.meanshiftSr));
  if (params.lockedColors.length > 0)
    fd.append("locked_colors", JSON.stringify(params.lockedColors));

  const res = await fetchWithRetry(
    `${BACKEND_URL}/api/plates-stream`,
    { method: "POST", body: fd, signal },
    TIMEOUTS.platesStream,
    0 // no retries for streaming
  );

  if (!res.ok)
    throw new ApiError(`Plates stream failed: ${res.status}`, "STREAM_ERROR", res.status);

  const reader = res.body?.getReader();
  if (!reader) throw new ApiError("No response body", "STREAM_ERROR");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      if (chunk.startsWith("data: ")) {
        const data = JSON.parse(chunk.slice(6)) as PlateStreamEvent;
        if (data.type === "error") {
          throw new ApiError(
            (data as unknown as { error: string }).error || "Stream error",
            "STREAM_ERROR"
          );
        }
        onEvent(data);
        if (data.type === "done") return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// High-res SVG endpoint
// ---------------------------------------------------------------------------

export interface PlateSvgResult {
  name: string;
  color: [number, number, number];
  svg: string;
  png_b64?: string; // Full-res plate PNG as base64
}

export async function fetchPlatesSvg(
  file: File,
  params: SeparationParams,
  signal?: AbortSignal
): Promise<PlateSvgResult[]> {
  // Send ALL params so cache-miss fallback uses correct settings (BUG-04 fix)
  const fd = buildFormData(file, params);

  const res = await fetchWithRetry(
    `${BACKEND_URL}/api/plates-svg`,
    { method: "POST", body: fd, signal },
    600_000 // 600s — potrace at full resolution (4000px+) is slow but produces best quality
  );
  if (!res.ok) throw new ApiError(`SVG fetch failed: ${res.status}`, "UNKNOWN", res.status);
  return res.json();
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

// Fire-and-forget analytics event — never throws, never blocks UI
export function trackEvent(event: string, data?: Record<string, unknown>): void {
  fetch(`${BACKEND_URL}/api/analytics/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, data }),
  }).catch(() => {}); // Silent — analytics must never affect UX
}

// Pattern note: Production image processing apps (Canva, Figma, Remove.bg) handle
// long-running requests via: (1) server-sent progress events, (2) optimistic UI
// with skeleton placeholders, (3) client-side timeout with "still processing"
// messaging, and (4) request deduplication to prevent duplicate work from
// button-mashing. This implementation follows those patterns.

export async function fetchPreviewStream(
  file: File,
  params: SeparationParams,
  onProgress: (stage: string, pct: number) => void,
  signal?: AbortSignal
): Promise<PreviewResult> {
  const fd = buildFormData(file, params);

  const res = await fetchWithRetry(
    `${BACKEND_URL}/api/preview-stream`,
    { method: "POST", body: fd, signal },
    TIMEOUTS.previewStream,
    0 // no retries for streaming
  );
  await throwForStatusWithBody(res, "Preview stream");

  const reader = res.body?.getReader();
  if (!reader) throw new ApiError("No response body", "STREAM_ERROR");

  const decoder = new TextDecoder();
  let buffer = "";
  let result: PreviewResult | null = null;
  let lastEventTime = Date.now();

  // Heartbeat: if no SSE event arrives for 30s, notify caller that processing
  // is still happening (Cloudflare/proxy may be buffering events)
  const heartbeatInterval = setInterval(() => {
    if (Date.now() - lastEventTime > 30_000) {
      onProgress("still_processing", -1);
    }
  }, 10_000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastEventTime = Date.now();
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        if (chunk.startsWith("data: ")) {
          const data = JSON.parse(chunk.slice(6));
          if (data.stage === "complete") {
            let compositeUrl: string;
            if (data.result_id) {
              const imgRes = await fetch(`${BACKEND_URL}/api/result/${data.result_id as string}`);
              if (!imgRes.ok)
                throw new ApiError("Failed to fetch result image", "STREAM_ERROR", imgRes.status);
              const blob = await imgRes.blob();
              compositeUrl = URL.createObjectURL(blob);
            } else {
              const bytes = Uint8Array.from(atob(data.image as string), (c) => c.charCodeAt(0));
              const blob = new Blob([bytes], { type: "image/png" });
              compositeUrl = URL.createObjectURL(blob);
            }
            const manifest: Manifest = {
              width: data.manifest.width,
              height: data.manifest.height,
              plates: (data.manifest.plates || []).map((p: Record<string, unknown>) => ({
                name: p.name,
                color: p.color,
                coverage: (p.coverage_pct ?? p.coverage ?? 0) as number,
                index: p.index as number | undefined,
              })),
              ai_analysis: (data.manifest.ai_analysis as Manifest["ai_analysis"]) ?? null,
              upscaled: (data.manifest.upscaled as boolean) ?? false,
              merge_suggestions: data.manifest.merge_suggestions as Manifest["merge_suggestions"],
            };
            // Revoke previous result blob URL to prevent leak (BUG-09)
            if (result?.compositeUrl) URL.revokeObjectURL(result.compositeUrl);
            result = { compositeUrl, manifest };
          } else if (data.stage === "partial_complete") {
            // Partial results -- some plates completed before memory pressure
            if ((data.result_id || data.image) && data.manifest) {
              let compositeUrl: string;
              if (data.result_id) {
                const imgRes = await fetch(`${BACKEND_URL}/api/result/${data.result_id as string}`);
                if (!imgRes.ok)
                  throw new ApiError(
                    "Failed to fetch partial result image",
                    "STREAM_ERROR",
                    imgRes.status
                  );
                const blob = await imgRes.blob();
                compositeUrl = URL.createObjectURL(blob);
              } else {
                const bytes = Uint8Array.from(atob(data.image as string), (c) => c.charCodeAt(0));
                const blob = new Blob([bytes], { type: "image/png" });
                compositeUrl = URL.createObjectURL(blob);
              }
              const manifest: Manifest = {
                width: data.manifest.width,
                height: data.manifest.height,
                plates: (data.manifest.plates || []).map((p: Record<string, unknown>) => ({
                  name: p.name,
                  color: p.color,
                  coverage: (p.coverage_pct ?? p.coverage ?? 0) as number,
                  index: p.index as number | undefined,
                })),
                ai_analysis: (data.manifest.ai_analysis as Manifest["ai_analysis"]) ?? null,
                upscaled: (data.manifest.upscaled as boolean) ?? false,
                merge_suggestions: data.manifest.merge_suggestions as Manifest["merge_suggestions"],
              };
              result = { compositeUrl, manifest };
            }
            onProgress(data.stage as string, data.pct as number);
          } else {
            // Passes through "plate_complete", "heartbeat", and all other stages
            onProgress(data.stage as string, data.pct as number);
          }
        }
      }
    }

    // Flush residual buffer — the final SSE event may not end with \n\n
    // if the connection closes immediately after the last byte
    if (buffer.trim()) {
      const remaining = buffer.split("\n\n");
      for (const chunk of remaining) {
        const trimmed = chunk.trim();
        if (trimmed.startsWith("data: ")) {
          const data = JSON.parse(trimmed.slice(6));
          if (data.stage === "complete") {
            let compositeUrl: string;
            if (data.result_id) {
              const imgRes = await fetch(`${BACKEND_URL}/api/result/${data.result_id as string}`);
              if (!imgRes.ok)
                throw new ApiError("Failed to fetch result image", "STREAM_ERROR", imgRes.status);
              const blob = await imgRes.blob();
              compositeUrl = URL.createObjectURL(blob);
            } else {
              const bytes = Uint8Array.from(atob(data.image as string), (c) => c.charCodeAt(0));
              const blob = new Blob([bytes], { type: "image/png" });
              compositeUrl = URL.createObjectURL(blob);
            }
            const manifest: Manifest = {
              width: data.manifest.width,
              height: data.manifest.height,
              plates: (data.manifest.plates || []).map((p: Record<string, unknown>) => ({
                name: p.name,
                color: p.color,
                coverage: (p.coverage_pct ?? p.coverage ?? 0) as number,
                index: p.index as number | undefined,
              })),
              ai_analysis: (data.manifest.ai_analysis as Manifest["ai_analysis"]) ?? null,
              upscaled: (data.manifest.upscaled as boolean) ?? false,
              merge_suggestions: data.manifest.merge_suggestions as Manifest["merge_suggestions"],
            };
            if (result?.compositeUrl) URL.revokeObjectURL(result.compositeUrl);
            result = { compositeUrl, manifest };
          } else if (data.stage !== "heartbeat") {
            onProgress(data.stage as string, data.pct as number);
          }
        }
      }
    }
  } finally {
    clearInterval(heartbeatInterval);
  }

  if (!result) throw new ApiError("No result received from stream", "STREAM_ERROR");
  return result;
}
