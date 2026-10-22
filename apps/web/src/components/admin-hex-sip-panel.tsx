"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Pipette } from "lucide-react";
import { toast } from "sonner";
import {
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
  type HexLabelPromoteResponse,
  type HexLabelQueueItem,
  type HexLabelRequest,
  type HexLabelSaveResponse,
} from "swatchwatch-shared";
import { deleteHexLabel, getHexLabelShade, saveHexLabel } from "@/lib/api";
import { useAuth, useDevAuth, useUnconfiguredAuth } from "@/hooks/use-auth";
import { buildMsalConfig } from "@/lib/msal-config";
import { undoHexLabelSave } from "@/lib/hex-sampling";
import { applyPromotionResponse } from "@/lib/vendor-hex-promotion";
import { ShadeLabeler } from "@/components/shade-hex-labeler";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";
const HAS_B2C_CONFIG = buildMsalConfig() !== null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Renders its children for admins only; everyone else gets nothing (no markup, no request).
 * Picks the auth hook for the current mode (dev bypass / unconfigured / B2C) the same way the
 * admin and polishes pages do, because `useAuth()` may only run inside `<MsalProvider>`.
 */
function AdminOnly({ children }: { children: ReactNode }) {
  if (IS_DEV_BYPASS) return <DevAdminOnly>{children}</DevAdminOnly>;
  if (!HAS_B2C_CONFIG) return <UnconfiguredAdminOnly>{children}</UnconfiguredAdminOnly>;
  return <B2CAdminOnly>{children}</B2CAdminOnly>;
}

function DevAdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useDevAuth();
  return isAdmin ? children : null;
}

function B2CAdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : null;
}

function UnconfiguredAdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useUnconfiguredAuth();
  return isAdmin ? children : null;
}

/** `AdminHexSipPanel` for admins only. */
export function AdminHexSipSection({ shadeId }: { shadeId: string }) {
  return (
    <AdminOnly>
      <AdminHexSipPanel shadeId={shadeId} />
    </AdminOnly>
  );
}

/**
 * Admin-only provenance hint next to the vendor hex on the polish detail page (#321): shows
 * "manual label" when the vendor hex was promoted from a ground-truth label. User-facing polish
 * responses do not carry the provenance, so it is read from the admin labeling endpoint.
 */
export function AdminVendorHexSourceHint({ shadeId }: { shadeId: string }) {
  return (
    <AdminOnly>
      <VendorHexSourceHint shadeId={shadeId} />
    </AdminOnly>
  );
}

function VendorHexSourceHint({ shadeId }: { shadeId: string }) {
  const [promoted, setPromoted] = useState<{ shadeId: string; value: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    getHexLabelShade(shadeId)
      .then((item) => {
        if (!cancelled) setPromoted({ shadeId, value: item.vendorHexSource === "manual_label" });
      })
      .catch(() => {
        // A hint only: no label data (e.g. a private shade) means no hint.
      });
    return () => {
      cancelled = true;
    };
  }, [shadeId]);
  if (!promoted || promoted.shadeId !== shadeId || !promoted.value) return null;
  return (
    <span
      className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
      title="Promoted from an admin ground-truth label; ingestion does not overwrite it"
    >
      manual label
    </span>
  );
}

/**
 * Admin-only "Sip ground-truth hex" panel for the polish detail page (#351). Collapsed by default;
 * expanding it loads the shade's catalog images and current manual label
 * (`GET /api/hex-labels-admin/shades/{shadeId}`) and shows the same eyedropper as the admin
 * Hex Labeling tab. Save / Remove write the shade's one `manual` `color_training_sample` label;
 * they never change its vendor or detected hex. Only the explicit, confirmed "Promote to vendor hex"
 * action (#321) writes the saved label's hex to `vendor_hex`. The caller renders this for admins only, so
 * non-admins never mount it and never trigger the request.
 */
export function AdminHexSipPanel({ shadeId }: { shadeId: string }) {
  const [open, setOpen] = useState(false);
  // Keyed by shade + retry count, so a stale response never shows and "loading" is derived.
  const [result, setResult] = useState<{ key: string; item: HexLabelQueueItem | null; error: string | null } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [sampleSize, setSampleSize] = useState(5);
  const [saving, setSaving] = useState(false);
  // The last save, so U / Undo can revert it (same flow as the Hex Labeling tab).
  const [lastSave, setLastSave] = useState<HexLabelSaveResponse | null>(null);

  const key = `${shadeId}#${reloadToken}`;

  // Lazy: nothing is requested until the panel is expanded.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getHexLabelShade(shadeId)
      .then((item) => {
        if (!cancelled) setResult({ key, item, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ key, item: null, error: errorMessage(error, "Failed to load the shade") });
      });
    return () => {
      cancelled = true;
    };
  }, [open, shadeId, key]);

  const current = result?.key === key ? result : null;

  const setLabel = useCallback((label: HexLabelQueueItem["label"]) => {
    setResult((prev) => (prev?.item ? { ...prev, item: { ...prev.item, label } } : prev));
  }, []);

  const handlePromotionChange = useCallback((response: HexLabelPromoteResponse) => {
    setResult((prev) => (prev?.item ? { ...prev, item: applyPromotionResponse(prev.item, response) } : prev));
  }, []);

  const handleSave = useCallback(
    async (request: HexLabelRequest) => {
      setSaving(true);
      try {
        const response = await saveHexLabel(request);
        setLabel(response.label);
        setLastSave(response);
        toast.success(response.label.unreliable ? "Flagged as unreliable" : `Saved ${response.label.hex}`, {
          description: response.previous ? "Replaced the previous label." : undefined,
        });
      } catch (error) {
        toast.error("Failed to save label", { description: errorMessage(error, "Request failed") });
      } finally {
        setSaving(false);
      }
    },
    [setLabel]
  );

  const handleRemove = useCallback(async () => {
    const label = current?.item?.label ?? null;
    if (!label) return;
    setSaving(true);
    try {
      await deleteHexLabel(label.trainingSampleId);
      setLabel(null);
      // The removed label is gone, so the last save can no longer be undone.
      setLastSave(null);
      toast.success("Label removed");
    } catch (error) {
      toast.error("Failed to remove label", { description: errorMessage(error, "Request failed") });
    } finally {
      setSaving(false);
    }
  }, [current, setLabel]);

  const handleUndo = useCallback(async () => {
    if (!lastSave || saving) return;
    setSaving(true);
    try {
      const { plan, label } = await undoHexLabelSave(lastSave, { saveHexLabel, deleteHexLabel });
      setLabel(label);
      setLastSave(null);
      toast.success(plan.kind === "delete" ? "Label removed" : "Previous label restored");
    } catch (error) {
      toast.error("Undo failed", { description: errorMessage(error, "Request failed") });
    } finally {
      setSaving(false);
    }
  }, [lastSave, saving, setLabel]);

  return (
    <Card data-testid="admin-hex-sip-panel">
      <CardHeader>
        <CardTitle>
          <button
            type="button"
            className="-my-3 flex w-full items-center gap-2 py-3 text-left"
            aria-expanded={open}
            aria-controls="admin-hex-sip-body"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            <Pipette className="size-4" />
            Sip ground-truth hex
            <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Admin
            </span>
          </button>
        </CardTitle>
        <CardDescription>
          Sample this shade&apos;s true colour from its catalog images for the hex-detection eval. Saves the shade&apos;s
          label only; vendor and AI hexes change only if you explicitly promote a saved label to the vendor hex.
        </CardDescription>
      </CardHeader>
      {open ? (
        <CardContent id="admin-hex-sip-body">
          {!current ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading catalog images…</p>
          ) : current.error !== null || !current.item ? (
            <div className="space-y-2 py-4 text-center">
              <p className="text-sm text-destructive">{current.error ?? "Failed to load the shade"}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)}>
                Retry
              </Button>
            </div>
          ) : (
            <ShadeLabeler
              key={current.item.shadeId}
              item={current.item}
              threshold={MEDIUM_CONFIDENCE_MAX_DISTANCE}
              sampleSize={sampleSize}
              onSampleSizeChange={setSampleSize}
              saving={saving}
              onSave={handleSave}
              onRemove={handleRemove}
              onPromotionChange={handlePromotionChange}
              canUndo={lastSave !== null}
              onUndo={handleUndo}
              layout="stacked"
              shortcutScope="panel"
            />
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}
