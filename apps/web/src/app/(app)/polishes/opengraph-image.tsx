import { ImageResponse } from "next/og";

export const alt = "SwatchWatch Collection";
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
            "linear-gradient(135deg, #22123b 0%, #42107e 52%, #7b2eff 100%)",
          color: "#fdf7ff",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "#ffb3e3",
          }}
        >
          SwatchWatch
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 58, fontWeight: 800, letterSpacing: "-0.03em" }}>
            Polish Collection
          </div>
          <div
            style={{
              fontSize: 28,
              color: "#ffd7f0",
              maxWidth: "78%",
              lineHeight: 1.3,
            }}
          >
            Search, filter, and compare shades with branded color intelligence tools.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
