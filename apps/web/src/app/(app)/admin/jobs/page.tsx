"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  IngestionJobRecord,
  IngestionJobRunRequest,
} from "swatchwatch-shared";
import {
  getIngestionJob,
  listIngestionJobs,
  runIngestionJob,
} from "@/lib/api";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

const RUNNABLE_SOURCES = [
  "OpenBeautyFacts",
  "MakeupAPI",
  "HoloTacoShopify",
] as const;

type RunnableSource = (typeof RUNNABLE_SOURCES)[number];
type SourceFilter = "all" | RunnableSource;

const METRIC_PRIORITY_KEYS = [
  "processed",
  "inserted",
  "updated",
  "skipped",
  "variantRowsProcessed",
  "brandsCreated",
  "shadesCreated",
  "inventoryInserted",
  "inventoryUpdated",
  "hexOverwritten",
  "swatchesLinked",
  "imageCandidates",
  "imageUploads",
  "imageUploadFailures",
  "hexDetected",
  "hexDetectionFailures",
  "hexDetectionSkipped",
] as const;

function parseMetricNumber(
  metrics: Record<string, unknown> | undefined,
  key: string
): number | null {
  if (!metrics) return null;
  const value = metrics[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatDateTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDuration(startedAt: string, finishedAt?: string): string {
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return "—";

  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (Number.isNaN(end)) return "—";

  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${minutes}m ${remainingSeconds}s${finishedAt ? "" : " (running)"}`;
}

function statusClassName(status: IngestionJobRecord["status"]): string {
  switch (status) {
    case "queued":
      return "border-sky-500/40 bg-sky-500/10 text-sky-700";
    case "running":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700";
    case "succeeded":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700";
    case "failed":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "cancelled":
      return "border-border bg-muted text-muted-foreground";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function getPipelineStage(job: IngestionJobRecord): string | null {
  if (!job.metrics || typeof job.metrics !== "object") return null;
  const pipeline = job.metrics.pipeline;
  if (!pipeline || typeof pipeline !== "object") return null;
  return typeof (pipeline as Record<string, unknown>).stage === "string"
    ? ((pipeline as Record<string, unknown>).stage as string)
    : null;
}

function changeSummary(job: IngestionJobRecord): string {
  const stage = getPipelineStage(job);
  const processed = parseMetricNumber(job.metrics, "processed");
  const inserted = parseMetricNumber(job.metrics, "inserted");
  const updated = parseMetricNumber(job.metrics, "updated");
  const skipped = parseMetricNumber(job.metrics, "skipped");

  if (processed === null && inserted === null && updated === null && skipped === null) {
    if (stage) return stage;
    return "—";
  }

  const p = processed ?? 0;
  const i = inserted ?? 0;
  const u = updated ?? 0;
  const s = skipped ?? 0;
  return `${stage ? `${stage} • ` : ""}processed ${p} • +${i} / ~${u} / -${s}`;
}

export default function AdminJobsPage() {
  const [jobs, setJobs] = useState<IngestionJobRecord[]>([]);
  const [totalJobs, setTotalJobs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);

  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<IngestionJobRecord | null>(null);
  const [selectedJobError, setSelectedJobError] = useState<string | null>(null);

  const [runSource, setRunSource] = useState<RunnableSource>("HoloTacoShopify");
  const [runSearchTerm, setRunSearchTerm] = useState("recent");
  const [runPage, setRunPage] = useState("1");
  const [runPageSize, setRunPageSize] = useState("50");
  const [runMaxRecords, setRunMaxRecords] = useState("50");
  const [runRecentDays, setRunRecentDays] = useState("120");
  const [runMaterialize, setRunMaterialize] = useState<"true" | "false">("true");
  const [runDetectHex, setRunDetectHex] = useState<"true" | "false">("true");
  const [runOverwriteHex, setRunOverwriteHex] = useState<"true" | "false">("false");
  const [runBusy, setRunBusy] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const refreshJobs = useCallback(async () => {
    const response = await listIngestionJobs({
      limit: 50,
      source: sourceFilter === "all" ? undefined : sourceFilter,
    });

    setJobs(response.jobs);
    setTotalJobs(response.total);
    setSelectedJobId((currentJobId) => {
      if (
        currentJobId &&
        response.jobs.some((job) => job.jobId === currentJobId)
      ) {
        return currentJobId;
      }

      return response.jobs[0]?.jobId ?? null;
    });
  }, [sourceFilter]);

  const refreshSelectedJob = useCallback(async (jobId: string) => {
    const response = await getIngestionJob(jobId);
    setSelectedJob(response.job);
    setSelectedJobError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        setLoading(true);
        setLoadingError(null);
        await refreshJobs();
      } catch (error: unknown) {
        if (cancelled) return;
        setLoadingError(error instanceof Error ? error.message : "Failed to load ingestion jobs");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, [refreshJobs]);

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJob(null);
      return;
    }

    const currentJobId = selectedJobId;
    let cancelled = false;

    async function loadDetail() {
      try {
        await refreshSelectedJob(currentJobId);
      } catch (error: unknown) {
        if (cancelled) return;
        setSelectedJobError(error instanceof Error ? error.message : "Failed to load job details");
      }
    }

    loadDetail();

    return () => {
      cancelled = true;
    };
  }, [refreshSelectedJob, selectedJobId]);

  useEffect(() => {
    const intervalId = window.setInterval(async () => {
      try {
        await refreshJobs();
      } catch {
        // Keep last-known data on polling failures.
      }

      if (selectedJobId) {
        try {
          await refreshSelectedJob(selectedJobId);
        } catch {
          // Keep last-known detail on polling failures.
        }
      }
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [refreshJobs, refreshSelectedJob, selectedJobId]);

  const prioritizedMetrics = useMemo(() => {
    if (!selectedJob?.metrics) return [] as Array<[string, number]>;

    const metrics: Array<[string, number]> = [];
    for (const key of METRIC_PRIORITY_KEYS) {
      const value = parseMetricNumber(selectedJob.metrics, key);
      if (value !== null) {
        metrics.push([key, value]);
      }
    }
    return metrics;
  }, [selectedJob]);

  const hasActiveJobs = useMemo(
    () => jobs.some((job) => job.status === "running" || job.status === "queued"),
    [jobs]
  );

  async function handleRunJob() {
    try {
      setRunBusy(true);
      setRunMessage(null);
      setRunError(null);

      const page = Math.max(1, Number.parseInt(runPage, 10) || 1);
      const pageSize = Math.max(1, Number.parseInt(runPageSize, 10) || 20);
      const maxRecords = Math.max(1, Number.parseInt(runMaxRecords, 10) || 20);

      const recentDaysTrimmed = runRecentDays.trim();
      const parsedRecentDays =
        recentDaysTrimmed.length > 0
          ? Math.max(1, Number.parseInt(recentDaysTrimmed, 10) || 1)
          : undefined;

      const payload: IngestionJobRunRequest = {
        source: runSource,
        searchTerm: runSearchTerm.trim() || undefined,
        page,
        pageSize,
        maxRecords,
        recentDays: parsedRecentDays,
        materializeToInventory: runMaterialize === "true",
        detectHexFromImage: runDetectHex === "true",
        overwriteDetectedHex: runOverwriteHex === "true",
      };

      const response = await runIngestionJob(payload);
      setRunMessage(`Job #${response.job.jobId} queued (${response.job.status}).`);
      setSelectedJobId(response.job.jobId);
      setSelectedJob(response.job);

      await refreshJobs();
      await refreshSelectedJob(response.job.jobId);
    } catch (error: unknown) {
      setRunError(error instanceof Error ? error.message : "Failed to run ingestion job");
    } finally {
      setRunBusy(false);
    }
  }

  if (loading) {
    return <BrandSpinner label="Loading admin jobs…" />;
  }

  if (loadingError) {
    return <ErrorState message={loadingError} onRetry={() => window.location.reload()} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="heading-page">Admin Jobs</h1>
          <p className="text-muted-foreground">
            Run ingestion jobs, track status, and inspect per-run change metrics.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={hasActiveJobs ? "text-amber-700" : "text-muted-foreground"}>
            {hasActiveJobs ? "Auto refresh (active jobs)" : "Auto refresh (5s)"}
          </Badge>
          <Button variant="outline" onClick={() => void refreshJobs()}>
            Refresh list
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run Ingestion Job</CardTitle>
          <CardDescription>
            Trigger an on-demand connector pull and materialization job.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Source</p>
              <Select value={runSource} onValueChange={(value) => setRunSource(value as RunnableSource)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RUNNABLE_SOURCES.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Search term</p>
              <Input
                value={runSearchTerm}
                onChange={(event) => setRunSearchTerm(event.target.value)}
                placeholder="recent"
              />
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Page</p>
              <Input
                value={runPage}
                onChange={(event) => setRunPage(event.target.value)}
                inputMode="numeric"
              />
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Page size</p>
              <Input
                value={runPageSize}
                onChange={(event) => setRunPageSize(event.target.value)}
                inputMode="numeric"
              />
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Max records</p>
              <Input
                value={runMaxRecords}
                onChange={(event) => setRunMaxRecords(event.target.value)}
                inputMode="numeric"
              />
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Recent days</p>
              <Input
                value={runRecentDays}
                onChange={(event) => setRunRecentDays(event.target.value)}
                inputMode="numeric"
                placeholder="Optional"
              />
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Materialize to inventory</p>
              <Select
                value={runMaterialize}
                onValueChange={(value) => setRunMaterialize(value as "true" | "false")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Yes</SelectItem>
                  <SelectItem value="false">No</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Detect hex from image (AI)</p>
              <Select
                value={runDetectHex}
                onValueChange={(value) => setRunDetectHex(value as "true" | "false")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Yes</SelectItem>
                  <SelectItem value="false">No</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Overwrite detected hex</p>
              <Select
                value={runOverwriteHex}
                onValueChange={(value) => setRunOverwriteHex(value as "true" | "false")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="false">No (fill blanks only)</SelectItem>
                  <SelectItem value="true">Yes (refresh existing hex)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            AI hex detection runs only when Azure OpenAI settings are configured on the Functions app.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleRunJob} disabled={runBusy}>
              {runBusy ? "Queueing job…" : "Run Job"}
            </Button>
            {runMessage && <p className="text-sm text-emerald-700">{runMessage}</p>}
            {runError && <p className="text-sm text-destructive">{runError}</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle>Recent Jobs</CardTitle>
            <CardDescription>{totalJobs} total runs in filter scope.</CardDescription>
          </div>
          <div className="w-full max-w-xs space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Filter source</p>
            <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value as SourceFilter)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {RUNNABLE_SOURCES.map((source) => (
                  <SelectItem key={source} value={source}>
                    {source}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Finished</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Changes</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No jobs found for this filter.
                  </TableCell>
                </TableRow>
              )}
              {jobs.map((job) => (
                <TableRow key={job.jobId} data-state={selectedJobId === job.jobId ? "selected" : undefined}>
                  <TableCell className="font-medium">#{job.jobId}</TableCell>
                  <TableCell>{job.source}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={statusClassName(job.status)}>
                      {job.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDateTime(job.startedAt)}</TableCell>
                  <TableCell>{formatDateTime(job.finishedAt)}</TableCell>
                  <TableCell>{formatDuration(job.startedAt, job.finishedAt)}</TableCell>
                  <TableCell className="max-w-[320px] truncate" title={changeSummary(job)}>
                    {changeSummary(job)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant={selectedJobId === job.jobId ? "secondary" : "outline"}
                      onClick={() => setSelectedJobId(job.jobId)}
                    >
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Job Detail</CardTitle>
          <CardDescription>
            Selected run progress, outcome, and change metrics.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {selectedJobError && (
            <p className="text-sm text-destructive">{selectedJobError}</p>
          )}

          {!selectedJob && !selectedJobError && (
            <p className="text-sm text-muted-foreground">Select a job to inspect details.</p>
          )}

          {selectedJob && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">#{selectedJob.jobId}</Badge>
                <Badge variant="outline">{selectedJob.source}</Badge>
                <Badge variant="outline" className={statusClassName(selectedJob.status)}>
                  {selectedJob.status}
                </Badge>
                <Badge variant="outline">{formatDuration(selectedJob.startedAt, selectedJob.finishedAt)}</Badge>
              </div>

              <div className="grid gap-2 text-sm md:grid-cols-3">
                <p>
                  <span className="font-medium">Started:</span> {formatDateTime(selectedJob.startedAt)}
                </p>
                <p>
                  <span className="font-medium">Finished:</span> {formatDateTime(selectedJob.finishedAt)}
                </p>
                <p>
                  <span className="font-medium">Job type:</span> {selectedJob.jobType}
                </p>
                <p>
                  <span className="font-medium">Stage:</span> {getPipelineStage(selectedJob) || "—"}
                </p>
              </div>

              {selectedJob.error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  <p className="font-medium">Run Error</p>
                  <p>{selectedJob.error}</p>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-sm font-medium">Change Metrics</p>
                {prioritizedMetrics.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No numeric change metrics recorded.</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {prioritizedMetrics.map(([key, value]) => (
                      <div key={key} className="rounded-md border px-3 py-2 text-sm">
                        <p className="text-muted-foreground">{key}</p>
                        <p className="font-semibold">{value.toLocaleString()}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {selectedJob.metrics && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Raw Metrics JSON</p>
                  <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                    {JSON.stringify(selectedJob.metrics, null, 2)}
                  </pre>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
