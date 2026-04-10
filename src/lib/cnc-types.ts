export type ToolType = "endmill" | "vbit";

export interface Tool {
  id: string;
  label: string;
  type: ToolType;
  diameter_mm: number;
  radius_mm: number;
  vbit_angle?: number;
  description: string;
}

export const TOOLS: Tool[] = [
  { id: "1/8-end", label: '1/8" end', type: "endmill", diameter_mm: 3.175, radius_mm: 1.5875, description: "General cutting (upcut)" },
  { id: "1/4-end", label: '1/4" end', type: "endmill", diameter_mm: 6.35, radius_mm: 3.175, description: "Rough clearing (upcut)" },
  { id: "1/8-down", label: '1/8" down', type: "endmill", diameter_mm: 3.175, radius_mm: 1.5875, description: "Detail, clean print surface" },
  { id: "1/4-down", label: '1/4" down', type: "endmill", diameter_mm: 6.35, radius_mm: 3.175, description: "Clearing, clean print surface" },
  { id: "60v", label: "60° V", type: "vbit", diameter_mm: 0.4, radius_mm: 0.2, vbit_angle: 60, description: "Fine lines, detail carving" },
  { id: "30v", label: "30° V", type: "vbit", diameter_mm: 0.2, radius_mm: 0.1, vbit_angle: 30, description: "Ultra-fine detail" },
];

export interface CncPlate {
  name: string;
  color: [number, number, number];
  svgRaw: string;
  svgCleaned?: string;
  dimensions_mm: { width: number; height: number };
  nodeCount: number;
  printOrder: number;
  material: "cherry" | "shina" | "mdf" | "other";
  cutStatus: "pending" | "cutting" | "done";
}

export interface KentoConfig {
  enabled: boolean;
  offset_mm: number;
  depth_mm: number;
  size_mm: number;
  style: "traditional" | "pin";
}

export interface PrintSize {
  width_mm: number;
  height_mm: number;
  margin_mm: number;
}

export interface SupportIsland {
  x: number;
  y: number;
  width_mm: number;
  height_mm: number;
}

export interface ProcessingStats {
  boundary_rects_removed: number;
  paths_closed: number;
  kento_marks_added: number;
  support_islands_suggested: number;
  nodes_before: number;
  nodes_after: number;
}

export interface ProjectState {
  plates: CncPlate[];
  printSize: PrintSize;
  kentoConfig: KentoConfig;
  selectedTool: Tool;
  unit: "mm" | "in";
  exportFormat: "svg" | "dxf" | "eps";
}
