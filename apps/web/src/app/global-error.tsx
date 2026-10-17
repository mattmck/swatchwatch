"use client";

import { useEffect } from "react";
import { trackException } from "@/lib/telemetry";

/**
 * Last-resort boundary for errors in the root layout. It replaces the root
 * layout, so it renders its own document without globals.css or the theme
 * class; inline styles follow the OS color scheme.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    trackException(error, { boundary: "global", digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          colorScheme: "light dark",
          textAlign: "center",
          padding: "1rem",
        }}
      >
        <title>Something went wrong | SwatchWatch</title>
        <main style={{ maxWidth: "28rem" }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>Something went wrong</h1>
          <p style={{ opacity: 0.75, marginTop: 0 }}>
            SwatchWatch hit an unexpected error. Try again, or reload the page if it keeps happening.
          </p>
          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", marginTop: "1rem" }}>
            <button type="button" onClick={reset} style={{ padding: "0.5rem 1rem", cursor: "pointer" }}>
              Try again
            </button>
            {/* Full reload on purpose: the root layout is what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" style={{ padding: "0.5rem 1rem", color: "inherit" }}>
              Go home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
