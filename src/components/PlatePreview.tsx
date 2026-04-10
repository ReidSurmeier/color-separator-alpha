"use client";

import { generateKentoMarks, convertUnits } from "@/lib/cnc-engine";
import type { CncPlate, KentoConfig, PrintSize } from "@/lib/cnc-types";

export interface Problem {
  plateIndex: number;
  message: string;
  severity: "warning" | "error";
}

interface PlatePreviewProps {
  plates: CncPlate[];
  selectedPlateIndex: number | null;
  viewMode: "composite" | "plate";
  onViewModeChange: (mode: "composite" | "plate") => void;
  onSelectPlate: (index: number | null) => void;
  printSize: PrintSize;
  kentoConfig: KentoConfig;
  unit: "mm" | "in";
  problems?: Problem[];
}

function formatDim(valueMm: number, unit: "mm" | "in"): string {
  if (unit === "mm") {
    return `${Math.round(valueMm)}mm`;
  }
  const inches = convertUnits(valueMm, "mm", "in");
  return `${inches.toFixed(1)}in`;
}

/** Strip outer <svg> wrapper and return inner markup only */
function extractSvgInner(svg: string): string {
  // Remove the <svg ...> opening tag and </svg> closing tag
  return svg
    .replace(/<svg[^>]*>/i, "")
    .replace(/<\/svg>/i, "")
    .trim();
}

/** Get viewBox string from an SVG string, or null */
function extractViewBox(svg: string): string | null {
  const m = /viewBox="([^"]+)"/.exec(svg);
  return m ? m[1] : null;
}

export default function PlatePreview({
  plates,
  selectedPlateIndex,
  viewMode,
  onViewModeChange,
  onSelectPlate,
  printSize,
  kentoConfig,
  unit,
  problems,
}: PlatePreviewProps) {
  const { width_mm, height_mm, margin_mm } = printSize;
  const aspectRatio = width_mm / height_mm;
  const kentoPath = generateKentoMarks(width_mm, height_mm, kentoConfig);

  const widthLabel = formatDim(width_mm, unit);
  const heightLabel = formatDim(height_mm, unit);

  const totalPlates = plates.length;
  const currentPlateIndex = selectedPlateIndex ?? 0;
  const currentPlate = totalPlates > 0 ? plates[currentPlateIndex] : null;

  function handlePrev() {
    if (totalPlates === 0) return;
    const next = (currentPlateIndex - 1 + totalPlates) % totalPlates;
    onSelectPlate(next);
  }

  function handleNext() {
    if (totalPlates === 0) return;
    const next = (currentPlateIndex + 1) % totalPlates;
    onSelectPlate(next);
  }

  // Build composite SVG: stack all plates in printOrder
  function renderComposite() {
    if (plates.length === 0) {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            color: "#bbb",
            fontSize: 12,
            fontFamily: "monospace",
          }}
        >
          no plates loaded
        </div>
      );
    }

    const sorted = [...plates].sort((a, b) => a.printOrder - b.printOrder);

    const layers = sorted.map((plate, i) => {
      const svgSrc = plate.svgCleaned ?? plate.svgRaw;
      const vb = extractViewBox(svgSrc) ?? `0 0 ${width_mm} ${height_mm}`;
      const inner = extractSvgInner(svgSrc);
      const [r, g, b] = plate.color;

      return (
        <svg
          key={i}
          viewBox={vb}
          preserveAspectRatio="xMidYMid meet"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: 0.8,
          }}
        >
          <g
            fill={`rgb(${r},${g},${b})`}
            dangerouslySetInnerHTML={{ __html: inner }}
          />
        </svg>
      );
    });

    // Kento overlay
    const kentoOverlay = kentoConfig.enabled ? (
      <svg
        key="kento"
        viewBox={`0 0 ${width_mm} ${height_mm}`}
        preserveAspectRatio="xMidYMid meet"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
        dangerouslySetInnerHTML={{ __html: kentoPath }}
      />
    ) : null;

    return (
      <>
        {layers}
        {kentoOverlay}
      </>
    );
  }

  // Build per-plate SVG
  function renderPlate() {
    if (!currentPlate) {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            color: "#bbb",
            fontSize: 12,
            fontFamily: "monospace",
          }}
        >
          no plate selected
        </div>
      );
    }

    const svgSrc = currentPlate.svgCleaned ?? currentPlate.svgRaw;
    const vb = extractViewBox(svgSrc) ?? `0 0 ${width_mm} ${height_mm}`;
    const inner = extractSvgInner(svgSrc);
    const [r, g, b] = currentPlate.color;

    return (
      <svg
        viewBox={vb}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "100%" }}
      >
        <g
          fill={`rgb(${r},${g},${b})`}
          dangerouslySetInnerHTML={{ __html: inner }}
        />
        {kentoConfig.enabled && (
          <g dangerouslySetInnerHTML={{ __html: kentoPath }} />
        )}
      </svg>
    );
  }

  // Plate name + color swatch bar (plate mode only)
  function renderPlateInfo() {
    if (!currentPlate) return null;
    const [r, g, b] = currentPlate.color;
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          fontFamily: "AUTHENTICSans-90, sans-serif",
          fontSize: 13,
        }}
      >
        <span
          style={{
            width: 16,
            height: 16,
            background: `rgb(${r},${g},${b})`,
            border: "1px solid #ddd",
            display: "inline-block",
            flexShrink: 0,
          }}
        />
        <span>{currentPlate.name}</span>
        <span
          style={{
            color: "#999",
            fontFamily: "monospace",
            fontSize: 11,
          }}
        >
          #{r.toString(16).padStart(2, "0")}
          {g.toString(16).padStart(2, "0")}
          {b.toString(16).padStart(2, "0")}
        </span>
      </div>
    );
  }

  const marginPercent = `${(margin_mm / width_mm) * 100}%`;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        fontFamily: "AUTHENTICSans-90, sans-serif",
        fontSize: 13,
      }}
    >
      {/* Toggle bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        {/* View mode toggle */}
        <div style={{ display: "flex", gap: 2 }}>
          <button
            data-active={viewMode === "composite" ? "true" : "false"}
            onClick={() => onViewModeChange("composite")}
          >
            composite
          </button>
          <button
            data-active={viewMode === "plate" ? "true" : "false"}
            onClick={() => onViewModeChange("plate")}
          >
            plate
          </button>
        </div>

        {/* Plate nav (plate mode only) */}
        {viewMode === "plate" && totalPlates > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginLeft: 8,
              fontFamily: "monospace",
              fontSize: 11,
              color: "#666",
            }}
          >
            <span>
              plate {currentPlateIndex + 1} of {totalPlates}
            </span>
            <button onClick={handlePrev} style={{ fontSize: 11 }}>
              ← prev
            </button>
            <button onClick={handleNext} style={{ fontSize: 11 }}>
              next →
            </button>
          </div>
        )}

        {/* Problems indicator */}
        {problems && problems.length > 0 && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 11,
              color: problems.some((p) => p.severity === "error") ? "#c00" : "#c90",
              fontFamily: "monospace",
            }}
          >
            {problems.length} issue{problems.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Plate info bar (plate mode) */}
      {viewMode === "plate" && renderPlateInfo()}

      {/* Canvas area */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 0,
        }}
      >
        {/* Dimension labels + plate container */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Height label (rotated, left side) */}
          <div
            style={{
              writingMode: "vertical-rl",
              transform: "rotate(180deg)",
              fontFamily: "DepartureMono, monospace",
              fontSize: 11,
              color: "#999",
              userSelect: "none",
              whiteSpace: "nowrap",
            }}
          >
            {heightLabel}
          </div>

          {/* Plate + width label column */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            {/* Width label */}
            <div
              style={{
                fontFamily: "DepartureMono, monospace",
                fontSize: 11,
                color: "#999",
                userSelect: "none",
              }}
            >
              {widthLabel}
            </div>

            {/* The actual plate preview */}
            <div
              style={{
                position: "relative",
                background: "white",
                border: "1px solid #e0e0e0",
                aspectRatio: `${aspectRatio}`,
                maxWidth: "min(600px, 70vw)",
                maxHeight: "min(500px, 60vh)",
                width: "100%",
                overflow: "hidden",
              }}
            >
              {/* Margin indicator */}
              <div
                style={{
                  position: "absolute",
                  inset: marginPercent,
                  border: "1px dashed #e0e0e0",
                  pointerEvents: "none",
                  zIndex: 1,
                }}
              />

              {/* Content */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "stretch",
                  justifyContent: "stretch",
                }}
              >
                {viewMode === "composite" ? renderComposite() : renderPlate()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
