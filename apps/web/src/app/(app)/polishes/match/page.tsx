"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { PolishImageMatchResponse } from "swatchwatch-shared";
import { ImageUp, X } from "lucide-react";
import { matchPolishesToImage } from "@/lib/api";
import { downscaleImageFile, type DownscaledImage } from "@/lib/image-downscale";
import { BrandSpinner } from "@/components/brand-spinner";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { useOwnedCount } from "@/hooks/use-owned-count";
import { trackOnboardingStepClicked } from "@/lib/metrics-events";
import { CATALOG_SEARCH_HREF } from "@/lib/onboarding";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ExtractedPalette,
  ImageDropZone,
  ImagePreview,
  MatchResultsList,
} from "./match-components";
import { countMatchesByColor, filterMatchesByColor } from "./match-utils";

type Status = "idle" | "processing" | "done" | "error";

/**
 * Photo → polish matching. The user picks, drops, or shoots a photo; it is
 * downscaled in the browser, sent to `POST /api/polishes/match-image`, and the
 * extracted palette plus the closest owned polishes are shown. Clicking a
 * palette swatch filters the results to polishes matched to that color.
 */
export default function PolishImageMatchPage() {
  const [image, setImage] = useState<DownscaledImage | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PolishImageMatchResponse | null>(null);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  // Matching only searches owned polishes: with none, say so before the user uploads a photo.
  const ownedCount = useOwnedCount();

  const runMatch = useCallback(async (prepared: DownscaledImage) => {
    const requestId = ++requestIdRef.current;
    setStatus("processing");
    setError(null);
    setResult(null);
    setSelectedHex(null);
    try {
      const response = await matchPolishesToImage(prepared.dataUrl);
      if (requestId !== requestIdRef.current) return;
      setResult(response);
      setStatus("done");
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to match colors");
      setStatus("error");
    }
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      const requestId = ++requestIdRef.current;
      setStatus("processing");
      setError(null);
      setResult(null);
      setSelectedHex(null);
      try {
        const prepared = await downscaleImageFile(file);
        if (requestId !== requestIdRef.current) return;
        setImage(prepared);
        await runMatch(prepared);
      } catch (err: unknown) {
        if (requestId !== requestIdRef.current) return;
        setImage(null);
        setError(err instanceof Error ? err.message : "Couldn't read that image");
        setStatus("error");
      }
    },
    [runMatch],
  );

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    setImage(null);
    setResult(null);
    setError(null);
    setSelectedHex(null);
    setStatus("idle");
  }, []);

  const matchCounts = useMemo(
    () => countMatchesByColor(result?.matches ?? []),
    [result],
  );
  const visibleMatches = useMemo(
    () => filterMatchesByColor(result?.matches ?? [], selectedHex),
    [result, selectedHex],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="heading-page">Match from Photo</h1>
          <p className="text-muted-foreground">
            Upload a photo and find the polishes in your collection that match its colors.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/polishes/search">Open Color Search</Link>
        </Button>
      </div>

      {ownedCount === 0 && !image && (
        <EmptyState
          icon={ImageUp}
          title="Photo matching needs a collection"
          description="Upload a photo and this page finds the polishes you own in its colors, so add a few polishes first."
          actionLabel="Search the catalog"
          actionHref={CATALOG_SEARCH_HREF}
          onAction={() => trackOnboardingStepClicked({ step: "search", surface: "match_empty", ownedCount: 0 })}
        />
      )}

      {ownedCount !== 0 && !image && status !== "processing" && (
        <>
          <ImageDropZone onFile={handleFile} />
          {status === "error" && error && (
            <ErrorState title="Couldn't use that image" message={error} className="min-h-0 py-2" />
          )}
        </>
      )}

      {!image && status === "processing" && <BrandSpinner label="Preparing photo…" />}

      {image && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <Card className="relative h-fit overflow-hidden border border-brand-purple/20 bg-card/95">
            <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-pink-soft via-brand-lilac to-brand-purple" />
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div>
                <CardTitle>Your photo</CardTitle>
                <CardDescription>Analyzed in memory, never saved.</CardDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Clear photo"
                title="Clear photo"
                onClick={reset}
              >
                <X />
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <ImagePreview src={image.dataUrl} width={image.width} height={image.height} />
              <ImageDropZone onFile={handleFile} disabled={status === "processing"} compact />
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden border border-brand-purple/20 bg-card/95">
            <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-pink-soft via-brand-lilac to-brand-purple" />
            <CardHeader>
              <CardTitle>Matches in your collection</CardTitle>
              <CardDescription>
                Tap a color to see only the polishes closest to it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {status === "processing" && (
                <BrandSpinner label="Finding matching polishes…" className="min-h-[240px]" />
              )}

              {status === "error" && error && (
                <ErrorState
                  message={error}
                  onRetry={() => runMatch(image)}
                  className="min-h-[240px]"
                />
              )}

              {status === "done" && result && (
                <MatchResults
                  result={result}
                  selectedHex={selectedHex}
                  onSelectHex={setSelectedHex}
                  matchCounts={matchCounts}
                  visibleMatches={visibleMatches}
                />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function MatchResults({
  result,
  selectedHex,
  onSelectHex,
  matchCounts,
  visibleMatches,
}: {
  result: PolishImageMatchResponse;
  selectedHex: string | null;
  onSelectHex: (hex: string | null) => void;
  matchCounts: Map<string, number>;
  visibleMatches: PolishImageMatchResponse["matches"];
}) {
  if (result.extractedColors.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        We couldn&apos;t find any colors in that image. Try a different photo.
      </p>
    );
  }

  return (
    <>
      <ExtractedPalette
        colors={result.extractedColors}
        selectedHex={selectedHex}
        matchCounts={matchCounts}
        onSelect={onSelectHex}
      />

      {result.candidateCount === 0 ? (
        <EmptyState
          title="No colors in your collection yet"
          description="Add polishes (with a known color) to your collection to match them against photos."
          actionLabel="+ Add Polish"
          actionHref="/polishes/new"
          className="min-h-[240px] px-0"
        />
      ) : visibleMatches.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          None of your top matches are closest to this color.
          {" "}
          <button
            type="button"
            className="font-medium text-brand-purple underline-offset-4 hover:underline dark:text-brand-lilac"
            onClick={() => onSelectHex(null)}
          >
            Show all colors
          </button>
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {visibleMatches.length} of {result.candidateCount} owned{" "}
            {result.candidateCount === 1 ? "polish" : "polishes"}
          </p>
          <MatchResultsList matches={visibleMatches} />
        </div>
      )}
    </>
  );
}
