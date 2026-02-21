"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  IngestionJobRecord,
  IngestionJobRunRequest,
  IngestionLogEntry,
  IngestionLogLevel,
} from "swatchwatch-shared";
import {
  cancelIngestionJob,
  getGlobalSettings,
  getIngestionJob,
  getQueueStats,
  listDataSources,
  listIngestionJobs,
  purgeQueue,
  runIngestionJob,
  type DataSource,
  type IngestionSettings,
  type QueueStatsResponse,
  updateGlobalSettings,
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
import {
  ChevronDown,
  ChevronRight,
  AlertCircle,
  AlertTriangle,
  Info,
  Bug,
  Settings,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Switch } from "@/components/ui/switch";

type SourceFilter = "all" | string;

export default function AdminJobsPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin?tab=admin-jobs");
  }, [router]);

  return <BrandSpinner label="Redirecting to Admin…" />;
}




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

function formatLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
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

function logLevelClassName(level: IngestionLogLevel): string {
  switch (level) {
    case "error":
      return "text-red-600";
    case "warn":
      return "text-amber-600";
    case "info":
      return "text-sky-600";
    case "debug":
      return "text-gray-500";
    default:
      return "text-gray-600";
  }
}

function LogLevelIcon({ level }: { level: IngestionLogLevel }) {
  const className = "h-3.5 w-3.5 flex-shrink-0";
  switch (level) {
    case "error":
      return <AlertCircle className={`${className} text-red-500`} />;
    case "warn":
      return <AlertTriangle className={`${className} text-amber-500`} />;
    case "info":
      return <Info className={`${className} text-sky-500`} />;
    case "debug":
      return <Bug className={`${className} text-gray-400`} />;
    default:
      return <Info className={`${className} text-gray-400`} />;
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

function getPipelineUpdatedAt(job: IngestionJobRecord): number {
  if (!job.metrics || typeof job.metrics !== "object") return 0;
  const pipeline = job.metrics.pipeline;
  if (!pipeline || typeof pipeline !== "object") return 0;
  const raw = (pipeline as Record<string, unknown>).updatedAt;
  if (typeof raw !== "string") return 0;
  const value = Date.parse(raw);
  return Number.isNaN(value) ? 0 : value;
}

function getJobLogs(job: IngestionJobRecord): IngestionLogEntry[] {
  if (!job.metrics || typeof job.metrics !== "object") return [];
  const logs = job.metrics.logs;
  if (!Array.isArray(logs)) return [];
  return logs.filter(
    (entry): entry is IngestionLogEntry =>
      entry &&
      typeof entry === "object" &&
      typeof entry.ts === "string" &&
      typeof entry.level === "string" &&
      typeof entry.msg === "string"
  );
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

function JobLogPanel({ job, autoScroll }: { job: IngestionJobRecord; autoScroll?: boolean }) {
  const logs = getJobLogs(job);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLogCount = useRef(logs.length);

  useEffect(() => {
    if (autoScroll && scrollRef.current && logs.length > prevLogCount.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLogCount.current = logs.length;
  }, [logs.length, autoScroll]);

  if (logs.length === 0) {
    return (
      <p className="py-2 text-xs text-muted-foreground italic">
        No logs recorded yet.
      </p>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="max-h-64 w-full min-w-0 max-w-full overflow-x-auto overflow-y-auto rounded border bg-gray-950 p-2 font-mono text-xs"
    >
      <div className="min-w-max">
        {logs.map((entry, idx) => (
          <div key={idx} className="flex min-w-max gap-2 whitespace-nowrap py-0.5 leading-relaxed">
            <span className="flex-shrink-0 text-gray-500">
              {formatLogTime(entry.ts)}
            </span>
            <LogLevelIcon level={entry.level} />
            <span className={logLevelClassName(entry.level)}>{entry.msg}</span>
            {entry.data && (
              <span className="text-gray-500">
                {JSON.stringify(entry.data)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AdminJobsContent() {
  const [jobs, setJobs] = useState<IngestionJobRecord[]>([]);
  const [totalJobs, setTotalJobs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [availableSources, setAvailableSources] = useState<DataSource[]>([]);
  const [globalSettings, setGlobalSettings] = useState<IngestionSettings>({ downloadImages: true, detectHex: true });
  const [settingsLoading, setSettingsLoading] = useState(false);

  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set());
  const [jobDetails, setJobDetails] = useState<Map<string, IngestionJobRecord>>(new Map());

  const [runSource, setRunSource] = useState<string>("HoloTacoShopify");
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
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);

  const [queueStats, setQueueStats] = useState<QueueStatsResponse | null>(null);
  const [queueStatsLoading, setQueueStatsLoading] = useState(true);
  const [queueStatsError, setQueueStatsError] = useState<string | null>(null);
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeMessage, setPurgeMessage] = useState<string | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  const refreshJobs = useCallback(async () => {
    const response = await listIngestionJobs({
      limit: 50,
      source: sourceFilter === "all" ? undefined : sourceFilter,
    });

    setJobs(response.jobs);
    setTotalJobs(response.total);
  }, [sourceFilter]);

  const refreshJobDetail = useCallback(async (jobId: string) => {
    try {
      const response = await getIngestionJob(jobId);
      setJobDetails((prev) => new Map(prev).set(jobId, response.job));
    } catch {
      // Keep stale data on error
    }
  }, []);

  const refreshQueueStats = useCallback(async () => {
    try {
      setQueueStatsError(null);
      const stats = await getQueueStats();
      setQueueStats(stats);
    } catch (error: unknown) {
      setQueueStatsError(error instanceof Error ? error.message : "Failed to load queue stats");
    }
  }, []);

  // Toggle expanded state for a job
  const toggleExpanded = useCallback((jobId: string) => {
    setExpandedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
        // Fetch detail when expanding
        void refreshJobDetail(jobId);
      }
      return next;
    });
  }, [refreshJobDetail]);

  // Auto-expand running/queued jobs
  useEffect(() => {
    const activeJobIds = jobs
      .filter((job) => job.status === "running" || job.status === "queued")
      .map((job) => job.jobId);

    if (activeJobIds.length > 0) {
      setExpandedJobIds((prev) => {
        const next = new Set(prev);
        for (const jobId of activeJobIds) {
          next.add(jobId);
        }
        return next;
      });
    }
  }, [jobs]);

  // Load global settings
  useEffect(() => {
    async function loadSettings() {
      try {
        const settings = await getGlobalSettings();
        setGlobalSettings(settings.settings);
      } catch (error) {
        console.error("Failed to load global settings:", error);
      }
    }
    loadSettings();
  }, []);

  async function handleToggleGlobalSetting(key: keyof IngestionSettings, value: boolean) {
    try {
      setSettingsLoading(true);
      await updateGlobalSettings({ [key]: value });
      setGlobalSettings((prev) => ({ ...prev, [key]: value }));
    } catch (error) {
      console.error("Failed to update global setting:", error);
    } finally {
      setSettingsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        setLoading(true);
        setLoadingError(null);
        setQueueStatsLoading(true);

        // Load data sources, jobs, and queue stats in parallel
        const [sourcesResponse] = await Promise.all([
          listDataSources(),
          refreshJobs(),
          refreshQueueStats(),
        ]);

        if (!cancelled) {
          setAvailableSources(sourcesResponse.sources);
          setQueueStatsLoading(false);
        }
      } catch (error: unknown) {
        if (cancelled) return;
        setLoadingError(error instanceof Error ? error.message : "Failed to load ingestion jobs");
        setQueueStatsLoading(false);
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


  // Poll for updates
  useEffect(() => {
    const intervalId = window.setInterval(async () => {
      try {
        await refreshJobs();
        await refreshQueueStats();
      } catch {
        // Keep last-known data on polling failures.
      }

      // Refresh expanded job details
      for (const jobId of expandedJobIds) {
        void refreshJobDetail(jobId);
      }
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [refreshJobs, refreshJobDetail, expandedJobIds, refreshQueueStats]);

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
        source: runSource as IngestionJobRunRequest["source"],
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

      // Auto-expand the new job
      setExpandedJobIds((prev) => new Set(prev).add(response.job.jobId));
      setJobDetails((prev) => new Map(prev).set(response.job.jobId, response.job));

      await refreshJobs();
    } catch (error: unknown) {
      setRunError(error instanceof Error ? error.message : "Failed to run ingestion job");
    } finally {
      setRunBusy(false);
    }
  }

  async function handleCancelJob(jobId: string) {
    try {
      setCancellingJobId(jobId);
      await cancelIngestionJob(jobId, "Cancelled by admin via jobs page");
      await refreshJobDetail(jobId);
      await refreshJobs();
    } catch (error: unknown) {
      console.error("Failed to cancel job:", error);
    } finally {
      setCancellingJobId(null);
    }
  }

  async function handlePurgeQueue() {
    try {
      setPurging(true);
      setPurgeError(null);
      setPurgeMessage(null);
      await purgeQueue();
      setPurgeMessage("Queue purged successfully");
      setPurgeDialogOpen(false);
      await refreshQueueStats();
    } catch (error: unknown) {
      setPurgeError(error instanceof Error ? error.message : "Failed to purge queue");
    } finally {
      setPurging(false);
    }
  }

  // Get the best job data (prefer detail over list item)
  const getJobData = useCallback(
    (job: IngestionJobRecord): IngestionJobRecord => {
      const detail = jobDetails.get(job.jobId);
      if (!detail) return job;

      const listLogsCount = getJobLogs(job).length;
      const detailLogsCount = getJobLogs(detail).length;
      if (listLogsCount !== detailLogsCount) {
        return listLogsCount > detailLogsCount ? job : detail;
      }

      const listUpdatedAt = getPipelineUpdatedAt(job);
      const detailUpdatedAt = getPipelineUpdatedAt(detail);
      if (listUpdatedAt !== detailUpdatedAt) {
        return listUpdatedAt > detailUpdatedAt ? job : detail;
      }

      return detail;
    },
    [jobDetails]
  );

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
            Run ingestion jobs, track status, and inspect per-run logs and metrics.
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
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Queue Status</CardTitle>
            <CardDescription>
              Monitor Azure Storage Queue messages and purge stuck jobs.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {queueStatsLoading ? (
              <Badge variant="outline">Loading…</Badge>
            ) : queueStats ? (
              <Badge variant="outline" className={queueStats.messageCount > 0 ? "text-amber-700" : "text-muted-foreground"}>
                {queueStats.messageCount} messages
              </Badge>
            ) : (
              <Badge variant="outline" className="text-destructive">Error</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {queueStatsError && (
            <p className="text-sm text-destructive">{queueStatsError}</p>
          )}
          {queueStats && (
            <p className="text-sm text-muted-foreground">
              Queue: <span className="font-mono">{queueStats.queueName}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => void refreshQueueStats()}
              disabled={queueStatsLoading}
            >
              Refresh
            </Button>
            <Button
              variant="destructive"
              onClick={() => setPurgeDialogOpen(true)}
              disabled={!queueStats || queueStats.messageCount === 0 || purging}
            >
              {purging ? "Purging…" : "Purge Queue"}
            </Button>
            {purgeMessage && (
              <p className="text-sm text-emerald-700">{purgeMessage}</p>
            )}
            {purgeError && (
              <p className="text-sm text-destructive">{purgeError}</p>
            )}
          </div>
        </CardContent>
      </Card>

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
              <Select value={runSource} onValueChange={(value) => setRunSource(value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableSources.map((source) => (
                    <SelectItem key={source.name} value={source.name}>
                      {source.name}
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
            <Button
              variant="secondary"
              onClick={() => {
                setRunDetectHex("true");
                setRunOverwriteHex("true");
              }}
              disabled={runBusy}
            >
              Force AI Detection
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
            <CardDescription>
              {totalJobs} total runs. Click a row to view logs.
            </CardDescription>
          </div>
          <div className="w-full max-w-xs space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Filter source</p>
            <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value as SourceFilter)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {availableSources.map((source) => (
                  <SelectItem key={source.name} value={source.name}>
                    {source.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

        </CardHeader>
      <CardContent>
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Changes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No jobs found for this filter.
                  </TableCell>
                </TableRow>
              )}
              {jobs.map((job) => {
                const isExpanded = expandedJobIds.has(job.jobId);
                const jobData = getJobData(job);
                const logs = getJobLogs(jobData);
                const isActive = job.status === "running" || job.status === "queued";

                return (
                  <Fragment key={job.jobId}>
                    <TableRow
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => toggleExpanded(job.jobId)}
                    >
                      <TableCell className="w-8 px-2">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell className="font-medium">#{job.jobId}</TableCell>
                      <TableCell>{job.source}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusClassName(job.status)}>
                          {job.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatDateTime(job.startedAt)}</TableCell>
                      <TableCell>{formatDuration(job.startedAt, job.finishedAt)}</TableCell>
                      <TableCell className="max-w-[280px] truncate" title={changeSummary(job)}>
                        {changeSummary(job)}
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={7} className="p-3 max-w-0 overflow-hidden">
                          <div className="space-y-3 min-w-0">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">Job Logs</span>
                                <Badge variant="outline" className="text-xs">
                                  {logs.length} entries
                                </Badge>
                                {isActive && (
                                  <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">
                                    Live
                                  </Badge>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                {isActive && (
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => void handleCancelJob(job.jobId)}
                                    disabled={cancellingJobId === job.jobId}
                                  >
                                    {cancellingJobId === job.jobId ? "Cancelling…" : "Cancel Job"}
                                  </Button>
                                )}
                                {job.error && (
                                  <Badge variant="destructive" className="text-xs">
                                    Error: {job.error.slice(0, 60)}
                                    {job.error.length > 60 ? "…" : ""}
                                  </Badge>
                                )}
                              </div>
                            </div>
                            <JobLogPanel job={jobData} autoScroll={isActive} />
                            {logs.length > 0 && (
                              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                                <span>
                                  Errors: {logs.filter((l) => l.level === "error").length}
                                </span>
                                <span>
                                  Warnings: {logs.filter((l) => l.level === "warn").length}
                                </span>
                                <span>Stage: {getPipelineStage(jobData) || "—"}</span>
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={purgeDialogOpen} onOpenChange={setPurgeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Purge Queue</DialogTitle>
            <DialogDescription>
              This will permanently delete all {queueStats?.messageCount || 0} message(s) from the ingestion queue.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPurgeDialogOpen(false)}
              disabled={purging}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handlePurgeQueue()}
              disabled={purging}
            >
              {purging ? "Purging…" : "Purge Queue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
