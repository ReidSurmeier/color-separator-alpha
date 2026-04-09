import { memo } from "react";
import { rgbToHex } from "@/lib/colors";
import type { PlateImage } from "@/constants";

interface PlatesGridProps {
  plateImages: PlateImage[];
  isLoadingPlates: boolean;
  platesLoadedCount: number;
  platesTotalCount: number;
  skeletonCount: number;
  mergeMode: boolean;
  mergeGroups: number[][];
  activeMergeGroup: number;
  onToggleMergeSelect: (index: number) => void;
  onZoomPlate: (index: number) => void;
  isMerging: boolean;
}

const SELECTED_COLOR = "#e05c5c";

const PlatesGrid = memo(function PlatesGrid({
  plateImages,
  isLoadingPlates,
  platesTotalCount,
  skeletonCount,
  mergeMode,
  mergeGroups,
  onToggleMergeSelect,
  onZoomPlate,
  isMerging,
}: PlatesGridProps) {
  if (plateImages.length === 0 && !isLoadingPlates) return null;

  // Selected display indices are in group 0
  const selectedIndices = mergeGroups[0] ?? [];

  return (
    <div className="plates-section">
      <h3 className="plates-section-title">
        plates ({plateImages.length}
        {isLoadingPlates && platesTotalCount > 0 ? ` of ${platesTotalCount}` : ""})
      </h3>

      {isMerging && (
        <div className="merge-progress-overlay">
          <div className="merge-spinner" />
          <span>merging plates...</span>
        </div>
      )}

      {/* Plate cards + trailing skeletons */}
      <div className="plates-grid">
        {plateImages.map((plate, i) => {
          const selected = mergeMode && selectedIndices.includes(i);

          return (
            <div
              className={`plate-card ${selected ? "plate-selected" : ""}`}
              key={i}
              onClick={() => {
                if (mergeMode) {
                  onToggleMergeSelect(i);
                } else {
                  onZoomPlate(i);
                }
              }}
              style={{
                cursor: "pointer",
                outline: selected ? `3px solid ${SELECTED_COLOR}` : undefined,
                outlineOffset: selected ? 2 : undefined,
                position: "relative",
                animationDelay: `${i * 60}ms`,
              }}
            >
              <div className="plate-card-image" style={{ borderColor: rgbToHex(plate.color) }}>
                <img
                  src={plate.url}
                  alt={plate.name}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.opacity = "0.3";
                  }}
                  onLoad={(e) => {
                    (e.currentTarget as HTMLImageElement).style.opacity = "1";
                  }}
                />
                <div
                  className="plate-card-color-overlay"
                  style={{ backgroundColor: rgbToHex(plate.color) }}
                />
              </div>
              <div className="plate-card-info">
                <span
                  className="plate-card-swatch"
                  style={{ backgroundColor: rgbToHex(plate.color) }}
                />
                <span className="plate-card-hex">{rgbToHex(plate.color).toUpperCase()}</span>
                <span className="plate-card-coverage">{plate.coverage.toFixed(1)}%</span>
              </div>
            </div>
          );
        })}

        {/* Remaining skeletons for plates still loading */}
        {isLoadingPlates &&
          Array.from({
            length: Math.max(
              0,
              platesTotalCount > 0
                ? platesTotalCount - plateImages.length
                : plateImages.length === 0
                  ? skeletonCount
                  : 0
            ),
          }).map((_, i) => (
            <div key={`skeleton-${i}`} className="plate-card plate-skeleton">
              <div className="plate-card-image plate-skeleton-img" />
              <div className="plate-card-info">
                <div className="plate-skeleton-swatch" />
                <div className="plate-skeleton-text" />
                <div className="plate-skeleton-text short" />
              </div>
            </div>
          ))}
      </div>
    </div>
  );
});

export default PlatesGrid;
