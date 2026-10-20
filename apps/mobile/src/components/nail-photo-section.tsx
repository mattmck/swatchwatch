import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { NAIL_PHOTO_MAX_EDGE, type NailPhoto, type Polish } from "swatchwatch-shared";
import { ApiError, deleteNailPhoto, errorMessage, getNailPhoto, uploadNailPhoto } from "@/api/client";
import { confirmDestructive, pickPreparedPhoto, type PhotoSource } from "@/lib/pick-photo";
import { isOwnedPolish } from "@/lib/status";
import { useTheme } from "@/theme/theme";
import { PrivateImage } from "./private-image";
import { AppText, Button, Card, ErrorBanner } from "./ui";

type LoadState = "loading" | "ready" | "hidden" | "error";

/**
 * Private on-nail photo for an owned polish (#270, web: `NailPhotoPanel`). Owner-only on the
 * server (404 for anyone else); the image is a `v3` URL fetched with the bearer token and shown
 * from memory. Rendered only on the polish detail page, never in Collection rows.
 */
export function NailPhotoSection({ polish }: { polish: Polish }) {
  const inventoryItemId = isOwnedPolish(polish) ? polish.inventoryItemId : undefined;
  if (!inventoryItemId) return null;
  return <NailPhotoCard key={inventoryItemId} inventoryItemId={inventoryItemId} name={polish.name} />;
}

function NailPhotoCard({ inventoryItemId, name }: { inventoryItemId: string; name: string }) {
  const theme = useTheme();
  const [state, setState] = useState<LoadState>("loading");
  const [photo, setPhoto] = useState<NailPhoto | null>(null);
  const [busy, setBusy] = useState<"upload" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settle = useCallback((request: Promise<{ photo: NailPhoto | null }>) => {
    request
      .then((res) => {
        setPhoto(res.photo);
        setState("ready");
      })
      .catch((err: unknown) => {
        // 404: not the caller's item (or it was just removed) — nothing to show.
        if (err instanceof ApiError && err.status === 404) {
          setState("hidden");
          return;
        }
        setError(
          err instanceof ApiError && err.status === 0
            ? "You're offline. Your nail photo will load when you reconnect."
            : errorMessage(err, "Couldn't load your nail photo."),
        );
        setState("error");
      });
  }, []);

  useEffect(() => {
    settle(getNailPhoto(inventoryItemId));
  }, [inventoryItemId, settle]);

  function retry() {
    setState("loading");
    setError(null);
    settle(getNailPhoto(inventoryItemId));
  }

  async function add(from: PhotoSource) {
    setError(null);
    try {
      const prepared = await pickPreparedPhoto(from, { maxEdge: NAIL_PHOTO_MAX_EDGE, compress: 0.85 });
      if (!prepared) return;
      setBusy("upload");
      const res = await uploadNailPhoto(inventoryItemId, prepared.dataUrl);
      setPhoto(res.photo);
      setState("ready");
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the photo."));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const confirmed = await confirmDestructive("Delete this nail photo?", "It's removed from your account and can't be restored.", "Delete");
    if (!confirmed) return;
    setBusy("delete");
    setError(null);
    try {
      await deleteNailPhoto(inventoryItemId);
      setPhoto(null);
    } catch (err) {
      setError(errorMessage(err, "Couldn't delete the photo."));
    } finally {
      setBusy(null);
    }
  }

  if (state === "hidden") return null;

  return (
    <Card testID="nail-photo-section">
      <AppText variant="label" muted>
        On my nails
      </AppText>
      {state === "loading" && <PrivateImage url={null} style={{ width: "100%", aspectRatio: 4 / 3 }} accessibilityLabel="Loading your nail photo" />}
      {state === "error" && error && <ErrorBanner message={error} onRetry={retry} />}
      {state === "ready" && (
        <>
          {photo?.imageUrl ? (
            <PrivateImage url={photo.imageUrl} style={{ width: "100%", aspectRatio: 4 / 3 }} accessibilityLabel={`Your nail photo of ${name}`} />
          ) : photo ? (
            <AppText variant="small" muted>
              Your photo is saved but can&apos;t be shown right now.
            </AppText>
          ) : (
            <AppText variant="small" muted>
              Add a photo of this polish on your nails. Only you can see it.
            </AppText>
          )}
          {error && <ErrorBanner message={error} />}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
            <Button
              title={photo ? "Retake" : "Take a photo"}
              variant={photo ? "outline" : "brand"}
              compact
              loading={busy === "upload"}
              disabled={busy !== null}
              onPress={() => void add("camera")}
            />
            <Button
              title={photo ? "Replace from library" : "Choose photo"}
              variant="outline"
              compact
              disabled={busy !== null}
              onPress={() => void add("library")}
            />
            {photo && (
              <Button title="Delete" variant="ghost" compact loading={busy === "delete"} disabled={busy !== null} onPress={() => void remove()} />
            )}
          </View>
        </>
      )}
    </Card>
  );
}
