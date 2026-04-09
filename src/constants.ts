export type VersionId =
  | "v2"
  | "v3"
  | "v4"
  | "v5"
  | "v6"
  | "v7"
  | "v8"
  | "v9"
  | "v10"
  | "v11"
  | "v12"
  | "v13"
  | "v14"
  | "v15"
  | "v16"
  | "v17"
  | "v18"
  | "v19"
  | "v20";

export const VERSIONS: { id: VersionId; label: string }[] = [
  { id: "v2", label: "v2 — CIELAB K-means++" },
  { id: "v3", label: "v3 — key block extraction" },
  { id: "v4", label: "v4 — RealESRGAN upscale" },
  { id: "v5", label: "v5 — line noise removal" },
  { id: "v6", label: "v6 — SLIC superpixel" },
  { id: "v7", label: "v7 — CRF smoothing" },
  { id: "v8", label: "v8 — bilateral filter" },
  { id: "v9", label: "v9 — edge-preserving" },
  { id: "v10", label: "v10 — mean-shift" },
  { id: "v11", label: "v11 — plate merging + caching" },
  { id: "v12", label: "v12 — MiniBatchKMeans" },
  { id: "v13", label: "v13 — Canny edges" },
  { id: "v14", label: "v14 — gradient-aware fusion" },
  { id: "v15", label: "v15 — SAM-guided" },
  { id: "v16", label: "v16 — SAM + morphological" },
  { id: "v17", label: "v17 — SAM + line detection" },
  { id: "v18", label: "v18 — SAM + local contrast" },
  { id: "v19", label: "v19 — SAM + guided filter" },
  { id: "v20", label: "v20 — SAM + hole correction" },
];

export interface PaletteColor {
  rgb: [number, number, number];
  locked: boolean;
}

export interface PlateImage {
  name: string;
  url: string;
  color: [number, number, number];
  coverage: number;
  manifestIndex: number;
  svg?: string;
}

export interface AppError {
  message: string;
  retryable: boolean;
}
