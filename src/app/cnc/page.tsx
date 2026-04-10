"use client";

import { useCncProcessor } from "@/hooks/useCncProcessor";
import CncNavPanel from "@/components/CncNavPanel";
import PlatePreview from "@/components/PlatePreview";
import { convertUnits } from "@/lib/cnc-engine";
import "./cnc.css";

export default function CncPage() {
  const s = useCncProcessor();

  // CncNavPanel expects display-unit values
  const toDisplay = (mm: number) =>
    s.unit === "in" ? Math.round(convertUnits(mm, "mm", "in") * 10) / 10 : Math.round(mm);

  const printWidth = toDisplay(s.printSize.width_mm);
  const printHeight = toDisplay(s.printSize.height_mm);
  const margin = toDisplay(s.printSize.margin_mm);

  return (
    <>
      {/* Nav bar */}
      <div className="back-to-tools">
        <a href="/">
          &larr; color.separator
        </a>
        <a href="https://tools.reidsurmeier.wtf">
          tools.reidsurmeier.wtf
        </a>
      </div>

      {/* Hamburger (mobile) */}
      <button
        className="hamburger"
        onClick={() => s.setNavOpen((o) => !o)}
        aria-label="Toggle menu"
      >
        <span />
        <span />
        <span />
      </button>

      {/* Sidebar */}
      <CncNavPanel
        navOpen={s.navOpen}
        fileInputRef={s.fileInputRef}
        fileName={s.fileName}
        onFileUpload={s.handleFileUpload}
        printWidth={printWidth}
        printHeight={printHeight}
        margin={margin}
        unit={s.unit}
        onPrintSizeChange={s.handlePrintSizeChange}
        onUnitToggle={s.handleUnitToggle}
        kentoEnabled={s.kentoConfig.enabled}
        kentoOffset={toDisplay(s.kentoConfig.offset_mm)}
        kentoSize={toDisplay(s.kentoConfig.size_mm)}
        onKentoToggle={s.handleKentoToggle}
        onKentoChange={s.handleKentoChange}
        selectedToolId={s.selectedTool.id}
        onToolChange={s.handleToolChange}
        onProcess={s.handleProcess}
        onReset={s.handleReset}
        isProcessing={s.isProcessing}
        exportFormat={s.exportFormat}
        exportLayout={s.exportLayout}
        onExportFormatChange={s.handleExportFormatChange}
        onExportLayoutChange={s.handleExportLayoutChange}
        onExport={s.handleExport}
        hasProcessed={s.hasProcessed}
        plates={s.plates}
        selectedPlateIndex={s.selectedPlateIndex}
        onSelectPlate={s.handleSelectPlate}
        onReorderPlates={s.handleReorderPlates}
        stats={s.stats}
      />

      {/* Mobile nav overlay */}
      {s.navOpen && (
        <div className="nav-overlay" onClick={() => s.setNavOpen(false)} />
      )}

      {/* Preview area */}
      <div className="cnc-preview-area">
        <PlatePreview
          plates={s.plates}
          selectedPlateIndex={s.selectedPlateIndex}
          viewMode={s.viewMode}
          onViewModeChange={s.handleViewModeChange}
          onSelectPlate={s.handleSelectPlate}
          printSize={s.printSize}
          kentoConfig={s.kentoConfig}
          unit={s.unit}
        />
      </div>
    </>
  );
}
