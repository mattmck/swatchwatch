"use client";

import { useMemo, useState } from "react";
import { ImageOff, Loader2, Lock, Plus, Trash2, X } from "lucide-react";
import type { Manicure, ManicureMutationResponse, ManicurePolishRole, Polish } from "swatchwatch-shared";
import { MAX_MANICURE_NOTES_LENGTH, MAX_MANICURE_POLISHES } from "swatchwatch-shared";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ColorDot } from "@/components/color-dot";
import { PhotoPickerButtons } from "@/components/photo-picker-buttons";
import { PrivateImage } from "@/components/private-image";
import { ApiError, createManicure, deleteManicurePhoto, updateManicure, uploadManicurePhoto } from "@/lib/api";
import { trackManiLogged } from "@/lib/metrics-events";
import { describeNailPhotoError, prepareNailPhotoUpload } from "@/lib/nail-photo";
import {
  MANICURE_ROLE_LABELS,
  MANICURE_ROLE_OPTIONS,
  addDays,
  buildManicureRequest,
  entryFromManicurePolish,
  entryFromPolish,
  filterPickable,
  initialManiPhotoDraft,
  maniPhotoSaveAction,
  pickablePolishes,
  validateManiForm,
  type ManiFormEntry,
  type ManiPhotoDraft,
} from "@/lib/mani-log";

const MAX_PICKER_RESULTS = 8;

/** Photo upload failures in mani-log wording (the nail-photo 403/404 text is about inventory). */
function photoErrorMessage(error: unknown): string {
  if (error instanceof ApiError && [401, 413, 415, 503].includes(error.status)) {
    return describeNailPhotoError(error.status);
  }
  return error instanceof Error ? error.message : describeNailPhotoError(undefined);
}

interface ManiLogFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Today's local date (`YYYY-MM-DD`). */
  todayIso: string;
  /** The user's polishes (any status); the picker offers owned + destash ones. */
  collection: Polish[];
  collectionLoading: boolean;
  /** Edit this manicure; omit to log a new one. */
  manicure?: Manicure | null;
  /** New mani: preset date (defaults to today). */
  initialDate?: string;
  /** New mani: polishes to start with (e.g. from the polish detail page). */
  initialShadeIds?: string[];
  /** New mani: polishes with roles to start with (e.g. "Wear this" on `/polishes/looks`); wins over `initialShadeIds`. */
  initialEntries?: { shadeId: string; role: ManicurePolishRole }[];
  onSaved: (saved: ManicureMutationResponse) => void;
}

/**
 * "Log a mani" / "Edit mani" dialog (issue #269): date, polishes with roles, notes and an optional
 * private photo (#327). The photo is prepared on pick (HEIC converted, metadata stripped, see
 * `prepareNailPhotoUpload`) and uploaded right after the manicure is saved.
 */
export function ManiLogForm(props: ManiLogFormProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {/* Remount per open so the fields start from the current props. */}
        {open && <ManiLogFormBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function ManiLogFormBody({
  onOpenChange,
  todayIso,
  collection,
  collectionLoading,
  manicure,
  initialDate,
  initialShadeIds,
  initialEntries,
  onSaved,
}: ManiLogFormProps) {
  const editing = Boolean(manicure);
  const pickable = useMemo(() => pickablePolishes(collection), [collection]);
  const [wornOn, setWornOn] = useState(manicure?.wornOn ?? initialDate ?? todayIso);
  const [notes, setNotes] = useState(manicure?.notes ?? "");
  const [entries, setEntries] = useState<ManiFormEntry[]>(() => {
    if (manicure) return manicure.polishes.map(entryFromManicurePolish);
    const initial = initialEntries ?? (initialShadeIds ?? []).map((shadeId) => ({ shadeId, role: undefined }));
    return initial.flatMap(({ shadeId, role }) => {
      const polish = collection.find((p) => p.id === shadeId);
      return polish ? [entryFromPolish(polish, role)] : [];
    });
  });
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<ManiPhotoDraft>(() => initialManiPhotoDraft(manicure));
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const results = useMemo(
    () => (search.trim() ? filterPickable(pickable, search).slice(0, MAX_PICKER_RESULTS) : []),
    [pickable, search]
  );

  function addPolish(polish: Polish) {
    setEntries((current) => {
      const entry = entryFromPolish(polish);
      if (current.some((e) => e.shadeId === entry.shadeId && e.role === entry.role)) return current;
      return [...current, entry];
    });
    setSearch("");
    setError(null);
  }

  function setRole(index: number, role: ManicurePolishRole) {
    setEntries((current) => current.map((entry, i) => (i === index ? { ...entry, role } : entry)));
  }

  function removeEntry(index: number) {
    setEntries((current) => current.filter((_, i) => i !== index));
  }

  async function handlePhotoFile(file: File) {
    if (preparingPhoto || saving) return;
    setPreparingPhoto(true);
    setPhotoError(null);
    try {
      setPhoto({ kind: "pending", dataUrl: await prepareNailPhotoUpload(file) });
    } catch (err: unknown) {
      setPhotoError(photoErrorMessage(err));
    } finally {
      setPreparingPhoto(false);
    }
  }

  /** Apply the photo change to the just-saved manicure; returns it updated, or an error message. */
  async function savePhoto(saved: ManicureMutationResponse): Promise<{ saved: ManicureMutationResponse; error?: string }> {
    const action = maniPhotoSaveAction(photo, manicure);
    try {
      if (action.kind === "upload") {
        const uploaded = await uploadManicurePhoto(saved.id, action.dataUrl);
        return { saved: { ...saved, photoImageId: uploaded.photoImageId, photoUrl: uploaded.photoUrl } };
      }
      if (action.kind === "delete") {
        await deleteManicurePhoto(saved.id);
        return { saved: { ...saved, photoImageId: null, photoUrl: null } };
      }
    } catch (err: unknown) {
      return { saved, error: photoErrorMessage(err) };
    }
    return { saved };
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const values = { wornOn, entries, notes };
    const problem = validateManiForm(values, todayIso);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const request = buildManicureRequest(values);
      const written = manicure ? await updateManicure(manicure.id, request) : await createManicure(request);
      if (!manicure) trackManiLogged({ polishCount: written.polishes.length, via: "form" });
      const { saved, error: photoFailure } = await savePhoto(written);
      toast.success(editing ? "Mani updated" : "Mani logged", {
        description: `${saved.polishes.length} polish${saved.polishes.length === 1 ? "" : "es"} · ${saved.wornOn}`,
      });
      if (photoFailure) {
        toast.error("The mani was saved, but its photo wasn't", {
          description: `${photoFailure} Edit the mani to try again.`,
        });
      }
      onSaved(saved);
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not save the mani.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{editing ? "Edit mani" : "Log a mani"}</DialogTitle>
        <DialogDescription>
          Pick the polishes you wore. Logging updates each polish&apos;s wear count and last-worn date.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <label htmlFor="mani-worn-on" className="text-sm font-medium">
          Date
        </label>
        <Input
          id="mani-worn-on"
          type="date"
          value={wornOn}
          max={addDays(todayIso, 1)}
          onChange={(event) => setWornOn(event.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="mani-polish-search" className="text-sm font-medium">
          Polishes ({entries.length}/{MAX_MANICURE_POLISHES})
        </label>
        <Input
          id="mani-polish-search"
          placeholder={collectionLoading ? "Loading your collection…" : "Search your collection by brand or name"}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={collectionLoading || entries.length >= MAX_MANICURE_POLISHES}
          autoComplete="off"
        />
        {search.trim() && (
          <ul className="max-h-56 overflow-y-auto rounded-lg border" aria-label="Matching polishes">
            {results.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">No owned polish matches.</li>
            ) : (
              results.map((polish) => {
                const entry = entryFromPolish(polish);
                return (
                  <li key={polish.id}>
                    <button
                      type="button"
                      onClick={() => addPolish(polish)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60"
                    >
                      <ColorDot hex={entry.hex} size="sm" />
                      <span className="flex-1 truncate">
                        <span className="font-medium">{polish.brand}</span> {polish.name}
                      </span>
                      <Plus className="size-4 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}

        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No polishes picked yet.</p>
        ) : (
          <ol className="space-y-1.5">
            {entries.map((entry, index) => (
              <li
                key={`${entry.shadeId}-${entry.role}-${index}`}
                className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5"
              >
                <ColorDot hex={entry.hex} size="sm" />
                <span className="flex-1 truncate text-sm">
                  <span className="font-medium">{entry.brand}</span> {entry.name}
                </span>
                <Select value={entry.role} onValueChange={(value) => setRole(index, value as ManicurePolishRole)}>
                  <SelectTrigger className="h-8 w-28" aria-label={`Role for ${entry.brand} ${entry.name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MANICURE_ROLE_OPTIONS.map((role) => (
                      <SelectItem key={role} value={role}>
                        {MANICURE_ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => removeEntry(index)}
                  aria-label={`Remove ${entry.brand} ${entry.name}`}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="mani-notes" className="text-sm font-medium">
          Notes
        </label>
        <textarea
          id="mani-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          maxLength={MAX_MANICURE_NOTES_LENGTH}
          rows={3}
          placeholder="Wear time, chips, layering…"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">
          Photo <span className="font-normal text-muted-foreground">(optional)</span>
        </p>
        {photo.kind !== "none" && (
          <div className="size-28 overflow-hidden rounded-lg border shadow-sm">
            {photo.kind === "pending" ? (
              // A local, already re-encoded data URL; nothing to optimize or authorize.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo.dataUrl} alt="New mani photo" className="size-full object-cover" />
            ) : photo.url ? (
              <PrivateImage
                src={photo.url}
                alt="Mani photo"
                className="size-full object-cover"
                fallback={<PhotoUnavailable />}
              />
            ) : (
              <PhotoUnavailable />
            )}
          </div>
        )}
        <PhotoPickerButtons
          onFile={(file) => void handlePhotoFile(file)}
          disabled={saving || preparingPhoto}
          chooseLabel={preparingPhoto ? "Preparing…" : photo.kind === "none" ? "Add photo" : "Replace photo"}
        >
          {photo.kind !== "none" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving || preparingPhoto}
              onClick={() => setPhoto({ kind: "none" })}
            >
              <Trash2 aria-hidden="true" />
              Remove photo
            </Button>
          )}
        </PhotoPickerButtons>
        {photoError && (
          <p role="alert" className="text-sm text-destructive">
            {photoError}
          </p>
        )}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5" aria-hidden="true" />
          Private to you. Location and camera details are removed before it&apos;s stored.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || preparingPhoto}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          {editing ? "Save changes" : "Log mani"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function PhotoUnavailable() {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1 bg-muted p-2 text-center text-xs text-muted-foreground">
      <ImageOff className="size-5" aria-hidden="true" />
      <span>Photo unavailable</span>
    </div>
  );
}
