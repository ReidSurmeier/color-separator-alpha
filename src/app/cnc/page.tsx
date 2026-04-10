"use client";

export default function CncPage() {
  return (
    <>
      <a href="/" className="back-to-tools">
        &larr; color.separator
      </a>
      <div style={{ padding: 40, fontFamily: "AUTHENTICSans-90, sans-serif" }}>
        <h1 style={{ fontFamily: "DepartureMono, monospace", fontSize: 18 }}>CNC.TOOLPATH</h1>
        <p>Upload plate SVGs to prepare for CNC machining.</p>
      </div>
    </>
  );
}
