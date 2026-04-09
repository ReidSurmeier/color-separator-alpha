export interface PlateInfo {
  name: string;
  color: [number, number, number];
  coverage: number;
  index?: number; // K-means centroid index for merge operations
}

export interface AiAnalysis {
  quality_score: number;
  problem_regions: { x: number; y: number; width: number; height: number; description: string }[];
  color_accuracy: string;
  boundary_quality: string;
  suggestions: string[];
  summary: string;
}

export interface MergeSuggestion {
  plate_a: number;
  plate_b: number;
  delta_e: number;
}

export interface Manifest {
  width: number;
  height: number;
  plates: PlateInfo[];
  ai_analysis?: AiAnalysis | null;
  upscaled?: boolean;
  upscale_scale?: number;
  merge_suggestions?: MergeSuggestion[];
}

export interface SeparationParams {
  plates: number;
  dust: number;
  useEdges: boolean;
  edgeSigma: number;
  lockedColors: [number, number, number][];
  version:
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
  upscale?: boolean;
  upscaleScale?: 2 | 4;
  medianSize?: number;
  chromaBoost?: number;
  shadowThreshold?: number;
  highlightThreshold?: number;
  nSegments?: number;
  compactness?: number;
  crfSpatial?: number;
  crfColor?: number;
  crfCompat?: number;
  sigmaS?: number;
  sigmaR?: number;
  meanshiftSp?: number;
  meanshiftSr?: number;
  detailStrength?: number;
}

export interface PreviewResult {
  compositeUrl: string;
  manifest: Manifest;
}

export interface PrintColor {
  name: string;
  rgb: [number, number, number];
  category: "woodblock" | "screenprint" | "riso";
}

export interface OptimizeIteration {
  iteration: number;
  score?: number;
  issues?: string[];
  reasoning?: string;
  params?: Record<string, number | boolean | string>;
  done?: boolean;
  best_score?: number;
  best_params?: Record<string, number | boolean | string>;
  manifest?: Manifest;
  error?: string;
}
