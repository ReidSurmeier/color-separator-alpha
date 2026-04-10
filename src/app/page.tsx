"use client";

import { useColorSeparator } from "@/hooks/useColorSeparator";
import NavPanel from "@/components/NavPanel";
import PlatesGrid from "@/components/PlatesGrid";
import PlateZoom from "@/components/PlateZoom";
import ProgressBar from "@/components/ProgressBar";

export default function ColorSeparator() {
  const s = useColorSeparator();

  const handleToggleUpscale = () => s.setUpscale((u) => !u);
  const handleToggleOriginal = () => s.setShowOriginal((o) => !o);
  const handleToggleMergeMode = () => {
    s.setMergeMode((m) => !m);
    // Reset to empty selection (group 0 is always the active selection)
    s.setMergeGroups([[]]);
    s.setActiveMergeGroup(0);
  };
  const handleToggleAbout = () => s.setShowAbout((a) => !a);

  const handleToggleMergeSelect = (index: number) => {
    s.togglePlateInGroup(index);
  };

  const handleAutoSuggestMerge = () => {
    const groups = s.autoSuggestMerge();
    if (groups.length > 0) {
      s.setMergeGroups(groups);
      s.setActiveMergeGroup(0);
    }
  };

  const handleZoomPlate = (index: number) => s.setZoomedPlate(index);
  const handleCloseZoom = () => s.setZoomedPlate(null);

  return (
    <>
      {/* Back to tools bar */}
      <div className="back-to-tools">
        <a href="https://tools.reidsurmeier.wtf">
          &larr; tools.reidsurmeier.wtf
        </a>
        <a href="/cnc">
          cnc.toolpath &rarr;
        </a>
      </div>

      {/* Hamburger button (mobile only) */}
      <button
        className="hamburger"
        onClick={() => s.setNavOpen((o) => !o)}
        aria-label="Toggle menu"
      >
        <span />
        <span />
        <span />
      </button>

      {/* Nav panel */}
      <NavPanel
        navOpen={s.navOpen}
        version={s.version}
        onVersionChange={s.setVersion}
        upscale={s.upscale}
        onToggleUpscale={handleToggleUpscale}
        hasUpscaleToggle={s.hasUpscaleToggle}
        fileName={s.fileName}
        fileInputRef={s.fileInputRef}
        onFileSelect={s.handleFileSelect}
        plates={s.plates}
        colors={s.colors}
        onColorChange={s.handleColorChange}
        onToggleLock={s.handleToggleLock}
        onRemoveColor={s.handleRemoveColor}
        onAddColor={s.handleAddColor}
        dust={s.dust}
        useEdges={s.useEdges}
        edgeSigma={s.edgeSigma}
        hasCrfSliders={s.hasCrfSliders}
        crfSpatial={s.crfSpatial}
        crfColor={s.crfColor}
        crfCompat={s.crfCompat}
        hasV9Sliders={s.hasV9Sliders}
        sigmaS={s.sigmaS}
        sigmaR={s.sigmaR}
        meanshiftSp={s.meanshiftSp}
        meanshiftSr={s.meanshiftSr}
        hasV4Sliders={s.hasV4Sliders}
        medianSize={s.medianSize}
        shadowThreshold={s.shadowThreshold}
        highlightThreshold={s.highlightThreshold}
        hasSuperpixelSliders={s.hasSuperpixelSliders}
        nSegments={s.nSegments}
        compactness={s.compactness}
        hasChromaSlider={s.hasChromaSlider}
        chromaBoost={s.chromaBoost}
        detailStrength={s.detailStrength}
        onParamChange={s.handleParamChange}
        file={s.file}
        onProcess={s.handleProcess}
        onReset={s.handleReset}
        showOriginal={s.showOriginal}
        onToggleOriginal={handleToggleOriginal}
        canCompare={s.canCompare}
        compositeUrl={s.compositeUrl}
        isLoading={s.isLoading}
        downloadProgress={s.downloadProgress}
        onDownload={s.handleDownload}
        mergeMode={s.mergeMode}
        onToggleMergeMode={handleToggleMergeMode}
        manifest={s.manifest}
        plateImages={s.plateImages}
        mergeGroups={s.mergeGroups}
        activeMergeGroup={s.activeMergeGroup}
        onSetActiveMergeGroup={s.setActiveMergeGroup}
        onAddMergeGroup={s.addMergeGroup}
        onRemoveMergeGroup={s.removeMergeGroup}
        isMerging={s.isMerging}
        onMerge={s.handleMerge}
        mergeSuggestions={s.mergeSuggestions}
        onAutoSuggestMerge={handleAutoSuggestMerge}
        showAbout={s.showAbout}
        onToggleAbout={handleToggleAbout}
        imageInfo={s.imageInfo}
        error={s.error}
        onClearError={s.clearError}
        onRetry={s.handleProcess}
        onCancel={s.cancelRequest}
        upscaleScale={s.upscaleScale}
        onUpscaleScaleChange={s.setUpscaleScale}
        onPrepareCnc={s.handlePrepareCnc}
      />

      {/* About overlay */}
      {s.showAbout && (
        <div className="about-overlay">
          <div className="about-content">
            <pre className="about-ascii">{`  ∧＿∧\n （｡･ω･｡)つ━☆・*。\n ⊂　ノ　・゜+.\n 　しーＪ　°。+ *´¨)\n 　.· ´¸.·*´¨) ¸.·*¨)\n 　(¸.·´ (¸.·'* ☆`}</pre>
            <div className="about-box">
              <div className="about-label">ABOUT</div>
              <div>reid surmeier</div>
              <div className="about-separator" />
              <a href="https://www.instagram.com/reidsurmeier/" target="_blank" rel="noreferrer">
                @reidsurmeier
              </a>
              <a href="https://reidsurmeier.wtf" target="_blank" rel="noreferrer">
                reidsurmeier.wtf
              </a>
              <a href="https://www.are.na/reid-surmeier/channels" target="_blank" rel="noreferrer">
                are.na
              </a>
            </div>
            <div className="about-box">
              <div className="about-label">TECH</div>
              <div>Frontend: Next.js 16 + React 19 + TypeScript</div>
              <div>Backend: Python 3.12 + FastAPI + uvicorn</div>
              <div>Separation: K-means++ in CIELAB color space</div>
              <div>Upscaling: Real-ESRGAN 4x (GPU)</div>
              <div>Segmentation: SAM 2.1 (Segment Anything Model)</div>
              <div>Smoothing: bilateral filter + mean-shift clustering</div>
              <div>Edge detection: Canny + CRF refinement</div>
              <div>Line detection: adaptive thresholding + HSV analysis</div>
              <div>Hosting: Linux + systemd + Cloudflare tunnel</div>
            </div>
            <div className="about-box">
              <div className="about-label">ALGORITHMS</div>
              <div className="about-dim">v2: CIELAB K-means++, label map cleanup</div>
              <div className="about-dim">v3: key block extraction (Taohuawu paper)</div>
              <div className="about-dim">v4: Real-ESRGAN 4x upscale + AI assessment</div>
              <div className="about-dim">v5: targeted line noise removal</div>
              <div className="about-dim">v6: SLIC superpixel separation</div>
              <div className="about-dim">v7-v8: CRF smoothing + bilateral filter</div>
              <div className="about-dim">v9-v10: edge-preserving + mean-shift</div>
              <div className="about-dim">v11: plate merging + caching</div>
              <div className="about-dim">v12: vectorized + MiniBatchKMeans (2.5x faster)</div>
              <div className="about-dim">v13: raw pixels + Canny edges (detail mode)</div>
              <div className="about-dim">v14: two-pass gradient-aware fusion</div>
              <div className="about-dim">v15: SAM-guided object-aware separation</div>
              <div className="about-dim">v16: SAM + morphological closing</div>
              <div className="about-dim">
                v17: SAM + line detection + color-aware post-processing
              </div>
              <div className="about-dim">v18: SAM + local contrast + two-pass stroke fill</div>
              <div className="about-dim">v19: SAM + guided filter (neutral plates only)</div>
              <div className="about-dim">v20: SAM + guided filter + diff-based hole correction</div>
            </div>
            <div className="about-box">
              <div className="about-label">REFERENCES</div>
              <a href="https://www.mdpi.com/2076-3417/15/16/9081" target="_blank" rel="noreferrer">
                Taohuawu Woodblock Restoration (MDPI 2025)
              </a>
              <a href="https://www.mdpi.com/1424-8220/22/16/6043" target="_blank" rel="noreferrer">
                Superpixel Color Quantization (MDPI 2022)
              </a>
              <a href="https://segment-anything.com" target="_blank" rel="noreferrer">
                Segment Anything Model (Meta AI)
              </a>
              <a href="https://colorshift.theretherenow.com/" target="_blank" rel="noreferrer">
                color/shift risograph profiles
              </a>
              <div className="about-separator" />
              <a
                href="https://github.com/ReidSurmeier/color-separator"
                target="_blank"
                rel="noreferrer"
              >
                GitHub &middot; source code
              </a>
            </div>
            <div className="about-box">
              <div className="about-label">PRIVACY</div>
              <div className="about-dim">
                all processing server-side. no analytics. no tracking.
              </div>
              <div className="about-dim">no cookies. uploaded images are not stored.</div>
            </div>
            <button className="about-close" onClick={() => s.setShowAbout(false)}>
              close
            </button>
          </div>
        </div>
      )}

      {/* Overlay to close mobile nav */}
      {s.navOpen && <div className="nav-overlay" onClick={() => s.setNavOpen(false)} />}

      {/* Progress bar */}
      <ProgressBar
        isLoading={s.isLoading}
        progressStage={s.progressStage}
        progressPct={s.progressPct}
        plateProgress={
          s.plateProgressTotal > 0
            ? { current: s.plateProgressCurrent, total: s.plateProgressTotal }
            : undefined
        }
        partialResults={s.partialResults}
        downloadProgress={s.downloadProgress}
      />

      {/* Main scrollable area */}
      <div className={`main-canvas ${s.isLoading ? "is-loading" : ""}`}>
        {/* Composite image */}
        {s.displayImage && (
          <div className="canvas-wrapper">
            <img src={s.displayImage} alt="preview" />
            {s.compositeUrl && !s.showOriginal && <div className="paper-texture" />}
            {s.showOriginal && s.canCompare && <div className="compare-label">ORIGINAL</div>}
          </div>
        )}

        {/* AI Score */}
        {s.manifest?.ai_analysis && (
          <div className="ai-score-inline" title={s.manifest.ai_analysis.summary}>
            AI: {s.manifest.ai_analysis.quality_score}/100
          </div>
        )}

        {/* Plate images grid */}
        <PlatesGrid
          plateImages={s.plateImages}
          isLoadingPlates={s.isLoadingPlates}
          platesLoadedCount={s.platesLoadedCount}
          platesTotalCount={s.platesTotalCount}
          skeletonCount={s.plates}
          mergeMode={s.mergeMode}
          mergeGroups={s.mergeGroups}
          activeMergeGroup={s.activeMergeGroup}
          onToggleMergeSelect={handleToggleMergeSelect}
          onZoomPlate={handleZoomPlate}
          isMerging={s.isMerging}
        />

        {/* Plate zoom overlay */}
        <PlateZoom
          zoomedPlate={s.zoomedPlate}
          plateImages={s.plateImages}
          onClose={handleCloseZoom}
        />
      </div>

      {/* Upscaling status */}
      {s.isUpscaling && <div className="upscale-status">upscaling...</div>}
    </>
  );
}
