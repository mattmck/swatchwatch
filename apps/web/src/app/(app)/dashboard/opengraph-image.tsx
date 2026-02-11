import { ImageResponse } from "next/og";

export const alt = "SwatchWatch Dashboard";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";
export const dynamic = "force-static";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px",
          background:
            "linear-gradient(135deg, #ffd7f0 0%, #c5a6ff 45%, #ffb3e3 100%)",
          color: "#22123b",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: "-0.02em",
          }}
        >
          SwatchWatch
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 58, fontWeight: 800, letterSpacing: "-0.03em" }}>
            Dashboard Snapshot
          </div>
          <div
            style={{
              fontSize: 28,
              color: "#42107e",
              maxWidth: "78%",
              lineHeight: 1.3,
            }}
          >
            Collection stats, finish breakdowns, and recent additions in one view.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
