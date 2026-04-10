"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { CncPlate, KentoConfig, PrintSize, ProcessingStats, Tool } from "@/lib/cnc-types";
import { TOOLS } from "@/lib/cnc-types";
import {
  countNodes,
  parseSvg,
  sortPlatesByLuminance,
  stripCanvasBoundary,
  setPhysicalDimensions,
  generateKentoMarks,
  insertKentoIntoSvg,
  convertUnits,
} from "@/lib/cnc-engine";
import { exportProjectZip } from "@/lib/cnc-export";
import { trackEvent } from "@/lib/api";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PRINT_SIZE: PrintSize = {
  width_mm: 200,
  height_mm: 270,
  margin_mm: 10,
};

const DEFAULT_KENTO: KentoConfig = {
  enabled: true,
  offset_mm: 5,
  depth_mm: 1,
  size_mm: 8,
  style: "traditional",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSvgDimensions(svgString: string): { width_mm: number; height_mm: number } {
  const { width, height } = parseSvg(svgString);
  if (width > 0 && height > 0) {
    return {
      width_mm: Math.round(convertUnits(width, "px", "mm")),
      height_mm: Math.round(convertUnits(height, "px", "mm")),
    };
  }
  return { width_mm: DEFAULT_PRINT_SIZE.width_mm, height_mm: DEFAULT_PRINT_SIZE.height_mm };
}

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace("#", "");
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return [128, 128, 128];
  return [r, g, b];
}

function randomColor(): [number, number, number] {
  return [
    Math.floor(Math.random() * 200),
    Math.floor(Math.random() * 200),
    Math.floor(Math.random() * 200),
  ];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCncProcessor() {
  // File
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");

  // Plates
  const [plates, setPlates] = useState<CncPlate[]>([]);
  const [selectedPlateIndex, setSelectedPlateIndex] = useState<number | null>(null);

  // Print size
  const [printSize, setPrintSize] = useState<PrintSize>(DEFAULT_PRINT_SIZE);
  const [unit, setUnit] = useState<"mm" | "in">("mm");

  // Kento
  const [kentoConfig, setKentoConfig] = useState<KentoConfig>(DEFAULT_KENTO);

  // Tool
  const [selectedTool, setSelectedTool] = useState<Tool>(TOOLS[0]);

  // Processing
  const [isProcessing, setIsProcessing] = useState(false);
  const [hasProcessed, setHasProcessed] = useState(false);
  const [stats, setStats] = useState<ProcessingStats | null>(null);

  // Export
  const [exportFormat, setExportFormat] = useState<"svg" | "dxf" | "eps">("svg");
  const [exportLayout, setExportLayout] = useState<"individual" | "sheet">("individual");

  // View
  const [viewMode, setViewMode] = useState<"composite" | "plate">("composite");

  // Nav (mobile)
  const [navOpen, setNavOpen] = useState(false);

  // ---------------------------------------------------------------------------
  // SessionStorage loading on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const raw = sessionStorage.getItem("cnc-plates");
    if (!raw) return;

    sessionStorage.removeItem("cnc-plates");

    try {
      const parsed = JSON.parse(raw) as {
        plates: Array<{ name: string; color: string | [number, number, number]; svg: string }>;
        manifest?: { printWidth_mm?: number; printHeight_mm?: number };
      };

      if (!Array.isArray(parsed.plates) || parsed.plates.length === 0) return;

      const loaded: CncPlate[] = parsed.plates.map((p, i) => {
        const color: [number, number, number] =
          typeof p.color === "string" ? hexToRgb(p.color) : p.color;
        return {
          name: p.name,
          color,
          svgRaw: p.svg,
          dimensions_mm: { width: DEFAULT_PRINT_SIZE.width_mm, height: DEFAULT_PRINT_SIZE.height_mm },
          nodeCount: countNodes(p.svg),
          printOrder: i + 1,
          material: "shina",
          cutStatus: "pending",
        };
      });

      const sorted = sortPlatesByLuminance(loaded).map((p, i) => ({ ...p, printOrder: i + 1 }));
      setPlates(sorted);
      trackEvent("cnc_session_load", {
        plateCount: sorted.length,
        hasManifest: !!(parsed.manifest?.printWidth_mm),
      });

      if (parsed.manifest?.printWidth_mm && parsed.manifest?.printHeight_mm) {
        setPrintSize((prev) => ({
          ...prev,
          width_mm: parsed.manifest!.printWidth_mm!,
          height_mm: parsed.manifest!.printHeight_mm!,
        }));
      } else if (sorted.length > 0) {
        const dims = parseSvgDimensions(sorted[0].svgRaw);
        setPrintSize((prev) => ({ ...prev, ...dims }));
      }

      setFileName("Loaded from session");
    } catch {
      // ignore malformed session data
    }
  }, []);

  // ---------------------------------------------------------------------------
  // File upload
  // ---------------------------------------------------------------------------

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setFileName(file.name);
      setHasProcessed(false);
      setStats(null);
      setSelectedPlateIndex(null);

      if (file.name.endsWith(".svg")) {
        const text = await file.text();
        const dims = parseSvgDimensions(text);
        const plate: CncPlate = {
          name: file.name.replace(/\.svg$/i, ""),
          color: [30, 30, 30],
          svgRaw: text,
          dimensions_mm: { width: dims.width_mm, height: dims.height_mm },
          nodeCount: countNodes(text),
          printOrder: 1,
          material: "shina",
          cutStatus: "pending",
        };
        setPlates([plate]);
        setPrintSize((prev) => ({ ...prev, ...dims }));
        trackEvent("cnc_file_upload", {
          fileName: file.name,
          fileType: "svg",
          plateCount: 1,
          fileSizeKb: Math.round(file.size / 1024),
        });
        return;
      }

      if (file.name.endsWith(".zip")) {
        const JSZip = (await import("jszip")).default;
        const arrayBuffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);

        // Try to load manifest.json
        let manifest: {
          plates?: Array<{ name: string; color: string | number[]; printOrder?: number; file?: string; index?: number }>;
          printWidth_mm?: number;
          printHeight_mm?: number;
        } | null = null;

        const manifestFile = zip.file("manifest.json");
        if (manifestFile) {
          try {
            manifest = JSON.parse(await manifestFile.async("text"));
          } catch {
            // ignore
          }
        }

        // Collect SVG files from svg/ directory
        const svgEntries: Array<{ name: string; content: string }> = [];
        const svgFiles = zip.folder("svg");

        if (svgFiles) {
          const promises: Promise<void>[] = [];
          svgFiles.forEach((relativePath, zipEntry) => {
            if (relativePath.endsWith(".svg") && !zipEntry.dir) {
              promises.push(
                zipEntry.async("text").then((content) => {
                  svgEntries.push({ name: relativePath, content });
                })
              );
            }
          });
          await Promise.all(promises);
        }

        // Fallback: scan root and all paths for .svg
        if (svgEntries.length === 0) {
          const promises: Promise<void>[] = [];
          zip.forEach((relativePath, zipEntry) => {
            if (relativePath.endsWith(".svg") && !zipEntry.dir) {
              promises.push(
                zipEntry.async("text").then((content) => {
                  svgEntries.push({ name: relativePath, content });
                })
              );
            }
          });
          await Promise.all(promises);
        }

        if (svgEntries.length === 0) return;

        // Sort entries by name for stable ordering
        svgEntries.sort((a, b) => a.name.localeCompare(b.name));

        const loaded: CncPlate[] = svgEntries.map((entry, i) => {
          const baseName = entry.name.replace(/^svg\//, "").replace(/\.svg$/i, "");

          // Match against manifest entry — baseName is "plate1_513837", manifest name is "plate1"
          const manifestEntry = manifest?.plates?.find(
            (p) => p.file === entry.name || p.name === baseName || baseName.startsWith(p.name ?? "")
          );

          // Color can be hex string OR RGB array from manifest
          let color: [number, number, number] = randomColor();
          if (manifestEntry?.color) {
            if (Array.isArray(manifestEntry.color)) {
              color = manifestEntry.color as [number, number, number];
            } else if (typeof manifestEntry.color === "string") {
              color = hexToRgb(manifestEntry.color);
            }
          }

          const name = manifestEntry?.name ?? baseName;
          const printOrder = manifestEntry?.printOrder ?? i + 1;

          return {
            name,
            color,
            svgRaw: entry.content,
            dimensions_mm: { width: DEFAULT_PRINT_SIZE.width_mm, height: DEFAULT_PRINT_SIZE.height_mm },
            nodeCount: countNodes(entry.content),
            printOrder,
            material: "shina" as const,
            cutStatus: "pending" as const,
          };
        });

        const sorted = sortPlatesByLuminance(loaded).map((p, i) => ({ ...p, printOrder: i + 1 }));
        setPlates(sorted);

        if (manifest?.printWidth_mm && manifest?.printHeight_mm) {
          setPrintSize((prev) => ({
            ...prev,
            width_mm: manifest!.printWidth_mm!,
            height_mm: manifest!.printHeight_mm!,
          }));
        } else if (sorted.length > 0) {
          const dims = parseSvgDimensions(sorted[0].svgRaw);
          setPrintSize((prev) => ({ ...prev, ...dims }));
        }

        trackEvent("cnc_file_upload", {
          fileName: file.name,
          fileType: "zip",
          plateCount: sorted.length,
          fileSizeKb: Math.round(file.size / 1024),
        });
      }
    },
    []
  );

  // ---------------------------------------------------------------------------
  // Print size
  // ---------------------------------------------------------------------------

  const handlePrintSizeChange = useCallback(
    (key: "width" | "height" | "margin", value: number) => {
      // value is in current display unit; convert to mm for storage
      const mm = unit === "in" ? convertUnits(value, "in", "mm") : value;
      setPrintSize((prev) => ({
        ...prev,
        [`${key}_mm`]: mm,
      }));
      trackEvent("cnc_print_size_change", { key, value, unit });
    },
    [unit]
  );

  const handleUnitToggle = useCallback(() => {
    // Just flip the display unit — internal state stays in mm
    setUnit((prev) => {
      const next = prev === "mm" ? "in" : "mm";
      trackEvent("cnc_unit_toggle", { unit: next });
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Kento
  // ---------------------------------------------------------------------------

  const handleKentoToggle = useCallback(() => {
    setKentoConfig((prev) => {
      const next = { ...prev, enabled: !prev.enabled };
      trackEvent("cnc_kento_toggle", { enabled: next.enabled });
      return next;
    });
  }, []);

  const handleKentoChange = useCallback((key: string, value: number) => {
    setKentoConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  // ---------------------------------------------------------------------------
  // Tool
  // ---------------------------------------------------------------------------

  const handleToolChange = useCallback((toolId: string) => {
    const tool = TOOLS.find((t) => t.id === toolId);
    if (tool) {
      setSelectedTool(tool);
      trackEvent("cnc_tool_change", { toolId, toolLabel: tool.label, toolType: tool.type });
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Processing
  // ---------------------------------------------------------------------------

  const handleProcess = useCallback(async () => {
    if (plates.length === 0) return;
    setIsProcessing(true);
    const processStart = performance.now();
    trackEvent("cnc_process_start", {
      plateCount: plates.length,
      kentoEnabled: kentoConfig.enabled,
      toolId: selectedTool.id,
      printWidth: printSize.width_mm,
      printHeight: printSize.height_mm,
    });

    try {
      let totalBoundariesRemoved = 0;
      let totalNodesBefore = 0;
      let totalNodesAfter = 0;
      let totalKentoMarks = 0;

      const processed = plates.map((plate) => {
        const { paths, width, height } = parseSvg(plate.svgRaw);

        const nodesBefore = countNodes(plate.svgRaw);
        totalNodesBefore += nodesBefore;

        // 1. Strip canvas boundary
        const { cleaned, removed } = stripCanvasBoundary(paths, width, height);
        totalBoundariesRemoved += removed;

        // Rebuild SVG with cleaned paths
        const pathElements = cleaned
          .map((d) => `<path d="${d}" fill="inherit" stroke="inherit"/>`)
          .join("\n");

        // Preserve the <svg> wrapper from raw
        const svgOpenMatch = /<svg[^>]*>/.exec(plate.svgRaw);
        const svgOpen = svgOpenMatch ? svgOpenMatch[0] : `<svg xmlns="http://www.w3.org/2000/svg">`;
        let rebuiltSvg = `${svgOpen}\n${pathElements}\n</svg>`;

        // 2. Set physical dimensions
        rebuiltSvg = setPhysicalDimensions(
          rebuiltSvg,
          printSize.width_mm,
          printSize.height_mm
        );

        // 3. Insert kento marks
        if (kentoConfig.enabled) {
          const kentoMark = generateKentoMarks(
            printSize.width_mm,
            printSize.height_mm,
            kentoConfig
          );
          rebuiltSvg = insertKentoIntoSvg(rebuiltSvg, kentoMark);
          totalKentoMarks++;
        }

        const nodesAfter = countNodes(rebuiltSvg);
        totalNodesAfter += nodesAfter;

        return {
          ...plate,
          svgCleaned: rebuiltSvg,
          nodeCount: nodesAfter,
          dimensions_mm: {
            width: printSize.width_mm,
            height: printSize.height_mm,
          },
        };
      });

      setPlates(processed);
      setHasProcessed(true);
      setStats({
        boundary_rects_removed: totalBoundariesRemoved,
        paths_closed: 0,
        kento_marks_added: totalKentoMarks,
        support_islands_suggested: 0,
        nodes_before: totalNodesBefore,
        nodes_after: totalNodesAfter,
      });
      trackEvent("cnc_process_complete", {
        plateCount: plates.length,
        durationMs: Math.round(performance.now() - processStart),
        boundariesRemoved: totalBoundariesRemoved,
        nodesBefore: totalNodesBefore,
        nodesAfter: totalNodesAfter,
        kentoMarks: totalKentoMarks,
        compressionRatio: totalNodesBefore > 0 ? +(totalNodesAfter / totalNodesBefore).toFixed(3) : null,
      });
    } finally {
      setIsProcessing(false);
    }
  }, [plates, printSize, kentoConfig]);

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  const handleReset = useCallback(() => {
    trackEvent("cnc_reset", { plateCount: plates.length });
    setPlates([]);
    setFileName("");
    setHasProcessed(false);
    setStats(null);
    setSelectedPlateIndex(null);
    setPrintSize(DEFAULT_PRINT_SIZE);
    setKentoConfig(DEFAULT_KENTO);
    setSelectedTool(TOOLS[0]);
    setExportFormat("svg");
    setExportLayout("individual");
    setViewMode("composite");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [plates.length]);

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  const handleExportFormatChange = useCallback((fmt: "svg" | "dxf" | "eps") => {
    setExportFormat(fmt);
    trackEvent("cnc_format_change", { format: fmt });
  }, []);

  const handleExportLayoutChange = useCallback((layout: "individual" | "sheet") => {
    setExportLayout(layout);
    trackEvent("cnc_layout_change", { layout });
  }, []);

  const handleExport = useCallback(async () => {
    if (plates.length === 0) return;

    const exportStart = performance.now();
    trackEvent("cnc_export_start", {
      format: exportFormat,
      layout: exportLayout,
      plateCount: plates.length,
    });

    const blob = await exportProjectZip(
      plates,
      printSize,
      kentoConfig,
      exportFormat,
      exportLayout
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cnc-plates.zip";
    a.click();
    URL.revokeObjectURL(url);
    trackEvent("cnc_export_complete", {
      format: exportFormat,
      layout: exportLayout,
      plateCount: plates.length,
      durationMs: Math.round(performance.now() - exportStart),
      zipSizeKb: Math.round(blob.size / 1024),
    });
  }, [plates, printSize, kentoConfig, exportFormat, exportLayout]);

  // ---------------------------------------------------------------------------
  // Plate management
  // ---------------------------------------------------------------------------

  const handleSelectPlate = useCallback((index: number | null) => {
    setSelectedPlateIndex(index);
    trackEvent("cnc_plate_select", { plateIndex: index });
  }, []);

  const handleReorderPlates = useCallback((fromIndex: number, toIndex: number) => {
    setPlates((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next.map((p, i) => ({ ...p, printOrder: i + 1 }));
    });
  }, []);

  // ---------------------------------------------------------------------------
  // View
  // ---------------------------------------------------------------------------

  const handleViewModeChange = useCallback((mode: "composite" | "plate") => {
    setViewMode(mode);
    trackEvent("cnc_view_change", { mode });
  }, []);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    // File upload
    fileInputRef,
    fileName,
    handleFileUpload,

    // Print size
    printSize,
    unit,
    handlePrintSizeChange,
    handleUnitToggle,

    // Kento
    kentoConfig,
    handleKentoToggle,
    handleKentoChange,

    // Tool
    selectedTool,
    handleToolChange,

    // Processing
    isProcessing,
    hasProcessed,
    handleProcess,
    handleReset,

    // Export
    exportFormat,
    exportLayout,
    handleExportFormatChange,
    handleExportLayoutChange,
    handleExport,

    // Plates
    plates,
    selectedPlateIndex,
    handleSelectPlate,
    handleReorderPlates,

    // View
    viewMode,
    handleViewModeChange,

    // Stats
    stats,

    // Nav (mobile)
    navOpen,
    setNavOpen,
  };
}
