import type { ChangeEvent, RefObject } from "react";
import { TOOLS } from "@/lib/cnc-types";
import type { CncPlate, ProcessingStats } from "@/lib/cnc-types";

interface CncNavPanelProps {
  // Source
  onFileUpload: (e: ChangeEvent<HTMLInputElement>) => void;
  fileName: string;
  fileInputRef: RefObject<HTMLInputElement | null>;

  // Print size
  printWidth: number;
  printHeight: number;
  margin: number;
  unit: "mm" | "in";
  onPrintSizeChange: (key: "width" | "height" | "margin", value: number) => void;
  onUnitToggle: () => void;

  // Kento
  kentoEnabled: boolean;
  kentoOffset: number;
  kentoSize: number;
  onKentoToggle: () => void;
  onKentoChange: (key: string, value: number) => void;

  // Tool
  selectedToolId: string;
  onToolChange: (toolId: string) => void;

  // Actions
  onProcess: () => void;
  onReset: () => void;
  isProcessing: boolean;

  // Export
  exportFormat: "svg" | "dxf" | "eps";
  exportLayout: "individual" | "sheet";
  onExportFormatChange: (format: "svg" | "dxf" | "eps") => void;
  onExportLayoutChange: (layout: "individual" | "sheet") => void;
  onExport: () => void;
  hasProcessed: boolean;

  // Plates
  plates: CncPlate[];
  selectedPlateIndex: number | null;
  onSelectPlate: (index: number | null) => void;
  onReorderPlates: (fromIndex: number, toIndex: number) => void;

  // Stats
  stats: ProcessingStats | null;

  // Nav
  navOpen: boolean;
}

function rgbToCss([r, g, b]: [number, number, number]): string {
  return `rgb(${r},${g},${b})`;
}

export default function CncNavPanel({
  onFileUpload,
  fileName,
  fileInputRef,
  printWidth,
  printHeight,
  margin,
  unit,
  onPrintSizeChange,
  onUnitToggle,
  kentoEnabled,
  kentoOffset,
  kentoSize,
  onKentoToggle,
  onKentoChange,
  selectedToolId,
  onToolChange,
  onProcess,
  onReset,
  isProcessing,
  exportFormat,
  exportLayout,
  onExportFormatChange,
  onExportLayoutChange,
  onExport,
  hasProcessed,
  plates,
  selectedPlateIndex,
  onSelectPlate,
  stats,
  navOpen,
}: CncNavPanelProps) {
  const marginMax = unit === "mm" ? 50 : 2;
  const marginStep = unit === "mm" ? 1 : 0.1;

  return (
    <div className={`nav-panel${navOpen ? " nav-open" : ""}`}>
      <h3 className="app-title">
        <span>CNC.TOOLPATH</span>
      </h3>

      {/* Source */}
      <h3>source</h3>
      <button
        className="source-btn"
        onClick={() => fileInputRef.current?.click()}
      >
        {fileName || "choose file"}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,.svg"
        onChange={onFileUpload}
      />

      {/* Print size */}
      <h3>print size</h3>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
        <input
          type="number"
          value={printWidth}
          min={1}
          step={unit === "mm" ? 1 : 0.1}
          onChange={(e) => onPrintSizeChange("width", Number(e.target.value))}
          style={{ width: 54 }}
        />
        <span style={{ fontSize: 11, color: "#999" }}>&times;</span>
        <input
          type="number"
          value={printHeight}
          min={1}
          step={unit === "mm" ? 1 : 0.1}
          onChange={(e) => onPrintSizeChange("height", Number(e.target.value))}
          style={{ width: 54 }}
        />
        <span style={{ fontSize: 11, color: "#999" }}>{unit}</span>
      </div>

      <h3>margin {margin}{unit}</h3>
      <input
        type="range"
        min={0}
        max={marginMax}
        step={marginStep}
        value={margin}
        onChange={(e) => onPrintSizeChange("margin", Number(e.target.value))}
      />

      <div className="upscale-toggle" style={{ marginTop: 6 }}>
        <button
          data-active={unit === "mm" ? "true" : "false"}
          onClick={() => {
            if (unit !== "mm") onUnitToggle();
          }}
        >
          mm
        </button>
        <button
          data-active={unit === "in" ? "true" : "false"}
          onClick={() => {
            if (unit !== "in") onUnitToggle();
          }}
        >
          in
        </button>
      </div>

      {/* Kento marks */}
      <h3>kento marks</h3>
      <div className="upscale-toggle">
        <button
          data-active={!kentoEnabled ? "true" : "false"}
          onClick={() => {
            if (kentoEnabled) onKentoToggle();
          }}
        >
          off
        </button>
        <button
          data-active={kentoEnabled ? "true" : "false"}
          onClick={() => {
            if (!kentoEnabled) onKentoToggle();
          }}
        >
          on
        </button>
      </div>

      {kentoEnabled && (
        <>
          <h3>offset {kentoOffset}{unit}</h3>
          <input
            type="range"
            min={0}
            max={unit === "mm" ? 20 : 0.8}
            step={unit === "mm" ? 0.5 : 0.05}
            value={kentoOffset}
            onChange={(e) => onKentoChange("offset", Number(e.target.value))}
          />
          <h3>size {kentoSize}{unit}</h3>
          <input
            type="range"
            min={unit === "mm" ? 2 : 0.1}
            max={unit === "mm" ? 20 : 0.8}
            step={unit === "mm" ? 0.5 : 0.05}
            value={kentoSize}
            onChange={(e) => onKentoChange("size", Number(e.target.value))}
          />
        </>
      )}

      {/* Tool */}
      <h3>tool</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 2,
        }}
      >
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            data-active={selectedToolId === tool.id ? "true" : "false"}
            onClick={() => onToolChange(tool.id)}
            title={tool.description}
            style={{ fontSize: 11, padding: "2px 3px" }}
          >
            {tool.label}
          </button>
        ))}
      </div>

      {/* Actions */}
      <h3>actions</h3>
      <button
        className="process-btn"
        onClick={onProcess}
        disabled={isProcessing || !fileName}
      >
        {isProcessing ? "processing..." : "process"}
      </button>
      <button onClick={onReset}>reset</button>

      {/* Export */}
      <h3>export</h3>
      <div className="upscale-toggle">
        {(["svg", "dxf", "eps"] as const).map((fmt) => (
          <button
            key={fmt}
            data-active={exportFormat === fmt ? "true" : "false"}
            onClick={() => onExportFormatChange(fmt)}
          >
            {fmt}
          </button>
        ))}
      </div>
      <div className="upscale-toggle" style={{ marginTop: 4 }}>
        <button
          data-active={exportLayout === "individual" ? "true" : "false"}
          onClick={() => onExportLayoutChange("individual")}
        >
          individual
        </button>
        <button
          data-active={exportLayout === "sheet" ? "true" : "false"}
          onClick={() => onExportLayoutChange("sheet")}
          disabled={exportFormat !== "svg"}
          title={exportFormat !== "svg" ? "Sheet layout only available for SVG format" : undefined}
        >
          sheet
        </button>
      </div>
      <button
        style={{ marginTop: 6 }}
        onClick={onExport}
        disabled={!hasProcessed}
      >
        download
      </button>

      {/* Plates */}
      {plates.length > 0 && (
        <>
          <h3>plates</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {plates
              .slice()
              .sort((a, b) => a.printOrder - b.printOrder)
              .map((plate, i) => {
                const origIndex = plates.indexOf(plate);
                const isSelected = selectedPlateIndex === origIndex;
                return (
                  <div
                    key={i}
                    onClick={() =>
                      onSelectPlate(isSelected ? null : origIndex)
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 4px",
                      cursor: "pointer",
                      background: isSelected ? "#14ff00" : "transparent",
                      fontSize: 12,
                    }}
                  >
                    <div
                      style={{
                        width: 12,
                        height: 12,
                        background: rgbToCss(plate.color),
                        flexShrink: 0,
                        border: "1px solid rgba(0,0,0,0.15)",
                      }}
                    />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {plate.name}
                    </span>
                    <span style={{ color: "#999", flexShrink: 0 }}>
                      #{plate.printOrder}
                    </span>
                  </div>
                );
              })}
          </div>
        </>
      )}

      {/* Stats */}
      {stats && (
        <div className="data-box">
          <h3>stats</h3>
          <div className="data-row">
            <span>boundary rects removed</span>
            <span>{stats.boundary_rects_removed}</span>
          </div>
          <div className="data-row">
            <span>paths closed</span>
            <span>{stats.paths_closed}</span>
          </div>
          <div className="data-row">
            <span>kento added</span>
            <span>{stats.kento_marks_added}</span>
          </div>
          <div className="data-row">
            <span>tool compensation</span>
            <span>{stats.tool_compensation_applied}</span>
          </div>
          <div className="data-row">
            <span>nodes</span>
            <span>
              {stats.nodes_before}&rarr;{stats.nodes_after}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
