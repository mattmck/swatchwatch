"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FinishNormalization, FinishType, ReferenceHarmonyType } from "swatchwatch-shared";
import {
  createFinishNormalization,
  createFinishType,
  createHarmonyType,
  deleteFinishNormalization,
  deleteFinishType,
  deleteHarmonyType,
  listFinishNormalizations,
  listFinishTypes,
  listHarmonyTypes,
  updateFinishNormalization,
  updateFinishType,
  updateHarmonyType,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ReferenceRecord = FinishType | ReferenceHarmonyType;

interface ReferenceFormValues {
  name: string;
  displayName: string;
  description: string;
  sortOrder: string;
}

interface FinishNormalizationFormValues {
  sourceValue: string;
  normalizedFinishName: string;
}

interface ReferenceSectionProps<T extends ReferenceRecord> {
  title: string;
  description: string;
  singularLabel: string;
  rows: T[];
  loading: boolean;
  error: string | null;
  getId: (record: T) => number;
  onRefresh: () => Promise<void>;
  onCreate: (payload: {
    name: string;
    displayName: string;
    description?: string;
    sortOrder?: number;
  }) => Promise<void>;
  onUpdate: (
    id: number,
    payload: {
      name?: string;
      displayName?: string;
      description?: string;
      sortOrder?: number;
    }
  ) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

function toFormValues(record?: ReferenceRecord): ReferenceFormValues {
  return {
    name: record?.name ?? "",
    displayName: record?.displayName ?? "",
    description: record?.description ?? "",
    sortOrder: String(record?.sortOrder ?? 0),
  };
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function toFinishNormalizationFormValues(
  record?: FinishNormalization
): FinishNormalizationFormValues {
  return {
    sourceValue: record?.sourceValue ?? "",
    normalizedFinishName: record?.normalizedFinishName ?? "",
  };
}

/**
 * Reusable CRUD section for reference tables (finish/harmony).
 * @template T Reference row shape with shared display fields.
 * @param props Section metadata, rows, loading/error state, and CRUD callbacks.
 * @returns Config card with filtering, create/edit dialog, and delete confirmation.
 */
function ReferenceSection<T extends ReferenceRecord>({
  title,
  description,
  singularLabel,
  rows,
  loading,
  error,
  getId,
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
}: ReferenceSectionProps<T>) {
  const [query, setQuery] = useState("");
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editMode, setEditMode] = useState<"create" | "update">("create");
  const [formValues, setFormValues] = useState<ReferenceFormValues>(toFormValues());
  const [editingRecord, setEditingRecord] = useState<T | null>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<T | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return rows;

    return rows.filter((row) => {
      const haystack = `${row.name} ${row.displayName} ${row.description ?? ""}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [rows, query]);

  function openCreateDialog() {
    setEditMode("create");
    setEditingRecord(null);
    setFormValues(toFormValues());
    setFormError(null);
    setIsEditOpen(true);
  }

  function openEditDialog(record: T) {
    setEditMode("update");
    setEditingRecord(record);
    setFormValues(toFormValues(record));
    setFormError(null);
    setIsEditOpen(true);
  }

  async function handleSubmit() {
    const name = formValues.name.trim();
    const displayName = formValues.displayName.trim();
    const description = formValues.description.trim();
    const parsedSortOrder = Number.parseInt(formValues.sortOrder, 10);

    if (!name || !displayName) {
      setFormError("Name and display name are required.");
      return;
    }

    if (!Number.isFinite(parsedSortOrder)) {
      setFormError("Sort order must be a number.");
      return;
    }

    try {
      setPending(true);
      setFormError(null);

      const payload = {
        name,
        displayName,
        description: description || undefined,
        sortOrder: parsedSortOrder,
      };

      if (editMode === "create") {
        await onCreate(payload);
      } else if (editingRecord) {
        await onUpdate(getId(editingRecord), payload);
      }

      setIsEditOpen(false);
      setEditingRecord(null);
      setFormValues(toFormValues());
    } catch (submitError: unknown) {
      setFormError(submitError instanceof Error ? submitError.message : `Failed to save ${singularLabel}`);
    } finally {
      setPending(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;

    try {
      setDeletePending(true);
      setDeleteError(null);
      await onDelete(getId(deleteTarget));
      setDeleteTarget(null);
      setDeleteError(null);
    } catch (submitError: unknown) {
      setDeleteError(
        submitError instanceof Error
          ? submitError.message
          : `Failed to delete ${singularLabel}`
      );
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void onRefresh()} disabled={loading}>
            Refresh
          </Button>
          <Button onClick={openCreateDialog}>Add {singularLabel}</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder={`Filter ${title.toLowerCase()}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Display name</TableHead>
                <TableHead>Sort order</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-40">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && filteredRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No records found.
                  </TableCell>
                </TableRow>
              )}
              {!loading && filteredRows.map((row) => (
                <TableRow key={getId(row)}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>{row.displayName}</TableCell>
                  <TableCell>{row.sortOrder}</TableCell>
                  <TableCell>{formatDateTime(row.updatedAt)}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEditDialog(row)}>
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setDeleteError(null);
                          setDeleteTarget(row);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editMode === "create" ? `Create ${singularLabel}` : `Update ${singularLabel}`}
            </DialogTitle>
            <DialogDescription>
              Save changes to keep reference data in sync across admin and user workflows.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              placeholder="Name"
              value={formValues.name}
              onChange={(event) => setFormValues((prev) => ({ ...prev, name: event.target.value }))}
            />
            <Input
              placeholder="Display name"
              value={formValues.displayName}
              onChange={(event) => setFormValues((prev) => ({ ...prev, displayName: event.target.value }))}
            />
            <Input
              placeholder="Description"
              value={formValues.description}
              onChange={(event) => setFormValues((prev) => ({ ...prev, description: event.target.value }))}
            />
            <Input
              placeholder="Sort order"
              value={formValues.sortOrder}
              onChange={(event) => setFormValues((prev) => ({ ...prev, sortOrder: event.target.value }))}
              type="number"
            />
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {singularLabel}?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. Confirm deletion of
              {" "}
              <span className="font-semibold">{deleteTarget?.displayName}</span>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deletePending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deletePending}>
              {deletePending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
          {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

interface FinishNormalizationsSectionProps {
  rows: FinishNormalization[];
  finishTypes: FinishType[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onCreate: (payload: FinishNormalizationFormValues) => Promise<void>;
  onUpdate: (id: number, payload: FinishNormalizationFormValues) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

/**
 * CRUD section for finish normalization aliases used by AI/vendor ingestion.
 * @param props Rows, finish-type options, loading/error state, and CRUD callbacks.
 * @returns Config card with alias mapping create/edit/delete workflows.
 */
function FinishNormalizationsSection({
  rows,
  finishTypes,
  loading,
  error,
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
}: FinishNormalizationsSectionProps) {
  const [query, setQuery] = useState("");
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editMode, setEditMode] = useState<"create" | "update">("create");
  const [formValues, setFormValues] = useState<FinishNormalizationFormValues>(
    toFinishNormalizationFormValues()
  );
  const [editingRecord, setEditingRecord] = useState<FinishNormalization | null>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<FinishNormalization | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const finishTypeOptions = useMemo(
    () =>
      [...finishTypes].sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })
      ),
    [finishTypes]
  );

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return rows;

    return rows.filter((row) =>
      `${row.sourceValue} ${row.normalizedFinishName}`.toLowerCase().includes(normalizedQuery)
    );
  }, [rows, query]);

  function openCreateDialog() {
    setEditMode("create");
    setEditingRecord(null);
    setFormValues(toFinishNormalizationFormValues());
    setFormError(null);
    setIsEditOpen(true);
  }

  function openEditDialog(record: FinishNormalization) {
    setEditMode("update");
    setEditingRecord(record);
    setFormValues(toFinishNormalizationFormValues(record));
    setFormError(null);
    setIsEditOpen(true);
  }

  async function handleSubmit() {
    const sourceValue = formValues.sourceValue.trim().toLowerCase();
    const normalizedFinishName = formValues.normalizedFinishName.trim().toLowerCase();

    if (!sourceValue || !normalizedFinishName) {
      setFormError("Source value and normalized finish are required.");
      return;
    }

    try {
      setPending(true);
      setFormError(null);

      if (editMode === "create") {
        await onCreate({ sourceValue, normalizedFinishName });
      } else if (editingRecord) {
        await onUpdate(editingRecord.finishNormalizationId, { sourceValue, normalizedFinishName });
      }

      setIsEditOpen(false);
      setEditingRecord(null);
      setFormValues(toFinishNormalizationFormValues());
    } catch (submitError: unknown) {
      setFormError(
        submitError instanceof Error ? submitError.message : "Failed to save finish normalization"
      );
    } finally {
      setPending(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;

    try {
      setDeletePending(true);
      setDeleteError(null);
      await onDelete(deleteTarget.finishNormalizationId);
      setDeleteTarget(null);
      setDeleteError(null);
    } catch (submitError: unknown) {
      setDeleteError(
        submitError instanceof Error ? submitError.message : "Failed to delete finish normalization"
      );
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Finish Normalizations</CardTitle>
          <CardDescription>
            Map vendor- or AI-reported finish text to canonical finish names (for example,
            &quot;linear holo&quot; → &quot;holographic&quot;).
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void onRefresh()} disabled={loading}>
            Refresh
          </Button>
          <Button onClick={openCreateDialog}>Add normalization</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder="Filter finish normalizations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source value</TableHead>
                <TableHead>Normalized finish</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-40">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && filteredRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No records found.
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                filteredRows.map((row) => (
                  <TableRow key={row.finishNormalizationId}>
                    <TableCell className="font-medium">{row.sourceValue}</TableCell>
                    <TableCell>{row.normalizedFinishName}</TableCell>
                    <TableCell>{formatDateTime(row.updatedAt)}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => openEditDialog(row)}>
                          Edit
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteTarget(row);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editMode === "create"
                ? "Create finish normalization"
                : "Update finish normalization"}
            </DialogTitle>
            <DialogDescription>
              Keep finish parsing resilient as new aliases and misspellings appear.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              placeholder="Source value (e.g. crushed holo)"
              value={formValues.sourceValue}
              onChange={(event) =>
                setFormValues((prev) => ({
                  ...prev,
                  sourceValue: event.target.value,
                }))
              }
            />
            <Select
              value={formValues.normalizedFinishName}
              onValueChange={(value) =>
                setFormValues((prev) => ({ ...prev, normalizedFinishName: value }))
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select canonical finish" />
              </SelectTrigger>
              <SelectContent>
                {finishTypeOptions.map((finishType) => (
                  <SelectItem key={finishType.finishTypeId} value={finishType.name}>
                    {finishType.displayName} ({finishType.name})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete finish normalization?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. Confirm deletion of{" "}
              <span className="font-semibold">{deleteTarget?.sourceValue}</span>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deletePending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deletePending}>
              {deletePending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
          {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Reference-data configuration tab for admin CRUD workflows.
 * Loads finish types, harmony types, and finish normalizations and wires section handlers.
 */
export function ConfigTab() {
  const [finishTypes, setFinishTypes] = useState<FinishType[]>([]);
  const [harmonyTypes, setHarmonyTypes] = useState<ReferenceHarmonyType[]>([]);
  const [finishNormalizations, setFinishNormalizations] = useState<FinishNormalization[]>([]);
  const [finishLoading, setFinishLoading] = useState(true);
  const [harmonyLoading, setHarmonyLoading] = useState(true);
  const [normalizationsLoading, setNormalizationsLoading] = useState(true);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [harmonyError, setHarmonyError] = useState<string | null>(null);
  const [normalizationsError, setNormalizationsError] = useState<string | null>(null);

  const loadFinishTypes = useCallback(async () => {
    try {
      setFinishLoading(true);
      setFinishError(null);
      const response = await listFinishTypes();
      setFinishTypes(response.finishTypes);
    } catch (error: unknown) {
      setFinishError(error instanceof Error ? error.message : "Failed to load finish types");
    } finally {
      setFinishLoading(false);
    }
  }, []);

  const loadHarmonyTypes = useCallback(async () => {
    try {
      setHarmonyLoading(true);
      setHarmonyError(null);
      const response = await listHarmonyTypes();
      setHarmonyTypes(response.harmonyTypes);
    } catch (error: unknown) {
      setHarmonyError(error instanceof Error ? error.message : "Failed to load harmony types");
    } finally {
      setHarmonyLoading(false);
    }
  }, []);

  const loadFinishNormalizations = useCallback(async () => {
    try {
      setNormalizationsLoading(true);
      setNormalizationsError(null);
      const response = await listFinishNormalizations();
      setFinishNormalizations(response.finishNormalizations);
    } catch (error: unknown) {
      setNormalizationsError(
        error instanceof Error ? error.message : "Failed to load finish normalizations"
      );
    } finally {
      setNormalizationsLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadFinishTypes(), loadHarmonyTypes(), loadFinishNormalizations()]);
  }, [loadFinishTypes, loadHarmonyTypes, loadFinishNormalizations]);

  return (
    <div className="space-y-4">
      <ReferenceSection<FinishType>
        title="Finish Types"
        description="Manage available polish finishes used by forms and analytics."
        singularLabel="finish type"
        rows={finishTypes}
        loading={finishLoading}
        error={finishError}
        getId={(record) => record.finishTypeId}
        onRefresh={loadFinishTypes}
        onCreate={async (payload) => {
          await createFinishType(payload);
          await loadFinishTypes();
        }}
        onUpdate={async (id, payload) => {
          await updateFinishType(id, payload);
          await loadFinishTypes();
        }}
        onDelete={async (id) => {
          await deleteFinishType(id);
          await loadFinishTypes();
        }}
      />

      <ReferenceSection<ReferenceHarmonyType>
        title="Harmony Types"
        description="Manage color harmony options used by palette tooling and discovery."
        singularLabel="harmony type"
        rows={harmonyTypes}
        loading={harmonyLoading}
        error={harmonyError}
        getId={(record) => record.harmonyTypeId}
        onRefresh={loadHarmonyTypes}
        onCreate={async (payload) => {
          await createHarmonyType(payload);
          await loadHarmonyTypes();
        }}
        onUpdate={async (id, payload) => {
          await updateHarmonyType(id, payload);
          await loadHarmonyTypes();
        }}
        onDelete={async (id) => {
          await deleteHarmonyType(id);
          await loadHarmonyTypes();
        }}
      />

      <FinishNormalizationsSection
        rows={finishNormalizations}
        finishTypes={finishTypes}
        loading={normalizationsLoading}
        error={normalizationsError}
        onRefresh={loadFinishNormalizations}
        onCreate={async (payload) => {
          await createFinishNormalization(payload);
          await loadFinishNormalizations();
        }}
        onUpdate={async (id, payload) => {
          await updateFinishNormalization(id, payload);
          await loadFinishNormalizations();
        }}
        onDelete={async (id) => {
          await deleteFinishNormalization(id);
          await loadFinishNormalizations();
        }}
      />
    </div>
  );
}
