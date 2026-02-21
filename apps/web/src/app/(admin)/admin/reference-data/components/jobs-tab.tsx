"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IngestionJob } from "swatchwatch-shared";
import { listAdminJobs } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

type JobStatusFilter = "all" | IngestionJob["status"];

function formatDateTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function statusBadgeClass(status: IngestionJob["status"]): string {
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

export function JobsTab() {
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [jobTypeFilter, setJobTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");

  const [selectedErrorJob, setSelectedErrorJob] = useState<IngestionJob | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await listAdminJobs({ page: 1, pageSize: 200 });
      setJobs(response.jobs);
      setTotal(response.total);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load admin jobs");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        setIsLoading(true);
        setError(null);
        const response = await listAdminJobs({ page: 1, pageSize: 200 });
        if (cancelled) return;
        setJobs(response.jobs);
        setTotal(response.total);
      } catch (loadError: unknown) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load admin jobs");
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const normalizedSource = sourceFilter.trim().toLowerCase();
    const normalizedJobType = jobTypeFilter.trim().toLowerCase();

    return jobs.filter((job) => {
      if (statusFilter !== "all" && job.status !== statusFilter) return false;

      if (normalizedSource.length > 0) {
        const sourceText = `${job.dataSourceName ?? ""} ${job.dataSourceId}`.toLowerCase();
        if (!sourceText.includes(normalizedSource)) return false;
      }

      if (normalizedJobType.length > 0 && !job.jobType.toLowerCase().includes(normalizedJobType)) {
        return false;
      }

      if (normalizedQuery.length > 0) {
        const haystack = [
          job.jobType,
          job.status,
          job.dataSourceName ?? "",
          String(job.dataSourceId),
          String(job.ingestionJobId),
          job.errorSummary ?? "",
        ]
          .join(" ")
          .toLowerCase();

        if (!haystack.includes(normalizedQuery)) return false;
      }

      return true;
    });
  }, [jobs, query, sourceFilter, jobTypeFilter, statusFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline">{filteredJobs.length} shown / {total} total</Badge>
        <Button variant="outline" onClick={() => void loadJobs()} disabled={isLoading}>
          {isLoading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <Input
          placeholder="Search jobs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Input
          placeholder="Filter data source"
          value={sourceFilter}
          onChange={(event) => setSourceFilter(event.target.value)}
        />
        <Input
          placeholder="Filter job type"
          value={jobTypeFilter}
          onChange={(event) => setJobTypeFilter(event.target.value)}
        />
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as JobStatusFilter)}>
          <SelectTrigger>
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="succeeded">Succeeded</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data source</TableHead>
              <TableHead>Job type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Completed</TableHead>
              <TableHead className="text-right">Records processed</TableHead>
              <TableHead className="w-28">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredJobs.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No jobs found.
                </TableCell>
              </TableRow>
            )}
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  Loading jobs…
                </TableCell>
              </TableRow>
            )}
            {filteredJobs.map((job) => (
              <TableRow key={job.ingestionJobId}>
                <TableCell>{job.dataSourceName ?? `Source ${job.dataSourceId}`}</TableCell>
                <TableCell>{job.jobType}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={statusBadgeClass(job.status)}>
                    {job.status}
                  </Badge>
                </TableCell>
                <TableCell>{formatDateTime(job.startedAt)}</TableCell>
                <TableCell>{formatDateTime(job.completedAt)}</TableCell>
                <TableCell className="text-right">{job.recordsProcessed ?? "—"}</TableCell>
                <TableCell>
                  {job.errorSummary ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2"
                      onClick={() => setSelectedErrorJob(job)}
                    >
                      Error
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {selectedErrorJob && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-destructive">
              Error details for job #{selectedErrorJob.ingestionJobId}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setSelectedErrorJob(null)}>
              Close
            </Button>
          </div>
          <p className="text-sm text-destructive">{selectedErrorJob.errorSummary}</p>
        </div>
      )}
    </div>
  );
}
