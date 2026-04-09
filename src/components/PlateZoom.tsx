import { memo } from "react";
import { rgbToHex } from "@/lib/colors";
import type { PlateImage } from "@/constants";

interface PlateZoomProps {
  zoomedPlate: number | null;
  plateImages: PlateImage[];
  onClose: () => void;
}

const PlateZoom = memo(function PlateZoom({ zoomedPlate, plateImages, onClose }: PlateZoomProps) {
  if (zoomedPlate === null || !plateImages[zoomedPlate]) return null;

  const plate = plateImages[zoomedPlate];

  return (
    <div className="plate-zoom-overlay" onClick={onClose}>
      <div className="plate-zoom-content" onClick={(e) => e.stopPropagation()}>
        <img src={plate.url} alt="plate" className="plate-zoom-img" />
        <div className="plate-zoom-info">
          <span className="plate-zoom-swatch" style={{ backgroundColor: rgbToHex(plate.color) }} />
          <span className="plate-zoom-hex">{rgbToHex(plate.color).toUpperCase()}</span>
          <span className="plate-zoom-name">{plate.name}</span>
          <span className="plate-zoom-coverage">{plate.coverage.toFixed(1)}%</span>
        </div>
        <button className="about-close" onClick={onClose}>
          close
        </button>
      </div>
    </div>
  );
});

export default PlateZoom;
