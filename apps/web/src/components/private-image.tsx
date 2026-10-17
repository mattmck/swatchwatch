"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { isPrivateImageUrl, usePrivateImage } from "@/lib/private-image";

interface PrivateImageProps {
  src: string;
  alt: string;
  className?: string;
  /** Rendered when a private image is denied (401/403) or fails to load. */
  fallback?: ReactNode;
}

/**
 * Renders an image that may be an owner-scoped private id (`/api/images/v3.*`).
 * Public URLs render as a plain `<img>`; private ones are fetched with the
 * bearer token and shown through an object URL. See `usePrivateImage`.
 */
export function PrivateImage({ src, alt, className, fallback }: PrivateImageProps) {
  const isPrivate = isPrivateImageUrl(src);
  const { status, objectUrl } = usePrivateImage(isPrivate ? src : null);

  if (!isPrivate) {
    // Plain <img>, matching the app's `unoptimized` image usage.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} className={className} />;
  }

  if (status === "ready" && objectUrl) {
    // Object URLs cannot go through next/image optimization.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={objectUrl} alt={alt} className={className} />;
  }

  if (status === "denied" || status === "error") {
    if (fallback !== undefined) {
      return <>{fallback}</>;
    }
    return <div role="img" aria-label={alt} className={cn("bg-muted", className)} />;
  }

  return <div aria-busy="true" className={cn("animate-pulse bg-muted", className)} />;
}
