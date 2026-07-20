import { useState, useEffect, useRef } from "react";
import {
  useCreateVenuePopulationRun,
  useListVenuePopulationRuns,
  getListVenuePopulationRunsQueryKey,
  useListJITDestinationExtractions,
  useTriggerJITDestinationExtraction,
  getListJITDestinationExtractionsQueryKey,
} from "@workspace/api-client-react";
import type { VenuePopulationRun, DestinationVenueExtraction } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceStrict, formatDistanceToNow } from "date-fns";
import { Loader2, ChevronDown, ChevronRight, PlayCircle, MapPin, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

// ── helpers ────────────────────────────────────────────────────────────────

function isActive(run: VenuePopulationRun) {
  return run.status === "running" || run.status === "pending";
}

function StatusBadge({ status }: { status: string }) {
  if (status === "running" || status === "pending") {
    return (
      <Badge className="gap-1 bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300">
        <Loader2 className="h-3 w-3 animate-spin" /> In progress
      </Badge>
    );
  }
  if (status === "completed") {
    return <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300">Completed</Badge>;
  }
  if (status === "failed") {
    return <Badge variant="destructive">Failed</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

function ElapsedTimer({ startedAt }: { startedAt: string | null | undefined }) {
  const [elapsed, setElapsed] = useState("0s");
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => {
      const ms = Date.now() - new Date(startedAt).getTime();
      const s = Math.floor(ms / 1000);
      if (s < 60) setElapsed(`${s}s`);
      else if (s < 3600) setElapsed(`${Math.floor(s / 60)}m ${s % 60}s`);
      else setElapsed(`${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return <span className="text-xs text-muted-foreground tabular-nums">{elapsed} elapsed</span>;
}

function RunRow({ run }: { run: VenuePopulationRun }) {
  const [open, setOpen] = useState(false);
  const active = isActive(run);
  const hasErrors = (run.errors?.length ?? 0) > 0;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="px-5 py-4 flex flex-wrap items-center gap-3">
        <StatusBadge status={run.status} />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">
            {run.neighborhood}
            {run.borough ? `, ${run.borough}` : ""}
            {run.city ? ` · ${run.city}` : ""}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            <span className="capitalize">{run.venueType}</span>
            {run.customQuery && <span>query: "{run.customQuery}"</span>}
            <span>limit {run.limit}</span>
            <span>{format(new Date(run.createdAt), "MMM d, h:mm a")}</span>
          </div>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          {active ? (
            <ElapsedTimer startedAt={run.startedAt} />
          ) : run.status === "completed" ? (
            <div className="flex gap-3 text-xs text-muted-foreground">
              <span><strong className="text-foreground">{run.candidatesFound ?? 0}</strong> found</span>
              <span><strong className="text-foreground">{run.venuesWritten ?? 0}</strong> written</span>
              <span><strong className="text-foreground">{run.venuesSkipped ?? 0}</strong> skipped</span>
              {run.completedAt && run.startedAt && (
                <span>{formatDistanceStrict(new Date(run.completedAt), new Date(run.startedAt))}</span>
              )}
            </div>
          ) : null}

          {hasErrors && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="text-xs text-destructive inline-flex items-center gap-1 hover:underline"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {run.errors!.length} error{run.errors!.length !== 1 ? "s" : ""}
            </button>
          )}
        </div>
      </div>

      {open && hasErrors && (
        <div className="border-t border-border bg-muted/30 px-5 py-3">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Per-venue errors</div>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {run.errors!.map((e, i) => (
              <div key={i} className="text-xs bg-destructive/5 border border-destructive/20 rounded-md px-3 py-1.5">
                <span className="font-medium">{e.venueName}</span>
                <span className="text-muted-foreground ml-2">{e.error}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── JIT destination helpers ────────────────────────────────────────────────

function JITStatusBadge({ status }: { status: string }) {
  if (status === "pending") {
    return (
      <Badge className="gap-1 bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300">
        <Loader2 className="h-3 w-3 animate-spin" /> Extracting…
      </Badge>
    );
  }
  if (status === "done") {
    return <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300">Done</Badge>;
  }
  if (status === "failed") {
    return <Badge variant="destructive">Failed</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

function JITExtractionRow({ row }: { row: DestinationVenueExtraction }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="px-5 py-4 flex flex-wrap items-center gap-3">
        <JITStatusBadge status={row.status} />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {row.destination}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {row.venueCount != null && <span><strong className="text-foreground">{row.venueCount}</strong> venues cached</span>}
            {row.extractedAt && (
              <span>extracted {formatDistanceToNow(new Date(row.extractedAt), { addSuffix: true })}</span>
            )}
            {row.expiresAt && (
              <span>expires {format(new Date(row.expiresAt), "MMM d, yyyy")}</span>
            )}
            {row.errorNote && (
              <span className="text-destructive">{row.errorNote}</span>
            )}
          </div>
        </div>
        {row.status === "done" && (row.venueData?.length ?? 0) > 0 && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:underline"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {open ? "Hide" : "Preview"}
          </button>
        )}
      </div>
      {open && row.venueData && row.venueData.length > 0 && (
        <div className="border-t border-border bg-muted/30 px-5 py-3">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Cached venues (provisional)</div>
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {row.venueData.map((v, i) => (
              <div key={i} className="text-xs flex gap-2 items-start">
                <span className="font-medium shrink-0 w-40 truncate">{v.name}</span>
                <span className="text-muted-foreground">{v.vibe}</span>
                <span className="text-muted-foreground shrink-0">{v.roughPrice}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function JITDestinationsSection() {
  const queryClient = useQueryClient();
  const { data: extractions = [], isLoading } = useListJITDestinationExtractions();
  const trigger = useTriggerJITDestinationExtraction();
  const [destinationInput, setDestinationInput] = useState("");

  const hasPending = extractions.some((e) => e.status === "pending");

  // Auto-poll while any extraction is pending
  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: getListJITDestinationExtractionsQueryKey() });
    }, 5000);
    return () => clearInterval(id);
  }, [hasPending, queryClient]);

  const handleTrigger = (e: React.FormEvent) => {
    e.preventDefault();
    if (!destinationInput.trim()) return;
    trigger.mutate(
      { data: { destination: destinationInput.trim() } },
      {
        onSuccess: () => {
          setDestinationInput("");
          queryClient.invalidateQueries({ queryKey: getListJITDestinationExtractionsQueryKey() });
        },
      },
    );
  };

  const fieldClass =
    "h-9 rounded-md border border-border bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">JIT Destinations</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Web-sourced venue knowledge auto-extracted when a trip project locks a non-NYC destination.
          </div>
        </div>
        {hasPending && (
          <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
            <Loader2 className="h-3 w-3 animate-spin" /> Polling every 5s
          </div>
        )}
      </div>

      <form onSubmit={handleTrigger} className="flex gap-2 items-center">
        <input
          value={destinationInput}
          onChange={(e) => setDestinationInput(e.target.value)}
          placeholder="e.g. Nashville, Austin TX, Scottsdale"
          className={`${fieldClass} flex-1`}
        />
        <Button type="submit" variant="outline" size="sm" disabled={!destinationInput.trim() || trigger.isPending} className="gap-1.5 shrink-0">
          <RefreshCw className="h-3.5 w-3.5" />
          Trigger
        </Button>
        {trigger.isError && (
          <span className="text-xs text-destructive">
            {(trigger.error as { message?: string })?.message ?? "Failed"}
          </span>
        )}
      </form>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="bg-card border border-border rounded-xl h-14 animate-pulse" />
          ))}
        </div>
      ) : extractions.length === 0 ? (
        <div className="text-sm text-muted-foreground py-6 text-center">
          No JIT extractions yet. They run automatically when a trip locks a non-NYC destination.
        </div>
      ) : (
        <div className="space-y-3">
          {extractions.map((row) => (
            <JITExtractionRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── main page ──────────────────────────────────────────────────────────────

export function PopulatePage() {
  const queryClient = useQueryClient();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: runs = [], isLoading } = useListVenuePopulationRuns();
  const createRun = useCreateVenuePopulationRun();

  const hasActiveRun = runs.some(isActive);

  // Auto-poll every 3s while any run is in progress
  useEffect(() => {
    if (hasActiveRun) {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => {
          queryClient.invalidateQueries({ queryKey: getListVenuePopulationRunsQueryKey() });
        }, 3000);
      }
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [hasActiveRun, queryClient]);

  const [form, setForm] = useState({
    neighborhood: "",
    borough: "",
    city: "",
    venueType: "restaurant" as "restaurant" | "bar",
    customQuery: "",
    limit: "20",
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.neighborhood.trim()) return;
    createRun.mutate(
      {
        data: {
          neighborhood: form.neighborhood.trim(),
          borough: form.borough.trim() || undefined,
          city: form.city.trim() || undefined,
          venueType: form.venueType,
          customQuery: form.customQuery.trim() || undefined,
          limit: Number(form.limit) || 20,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListVenuePopulationRunsQueryKey() });
        },
      },
    );
  };

  const fieldClass =
    "h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="h-[100dvh] flex flex-col bg-background overflow-hidden">
      <div className="px-8 py-6 border-b border-border bg-card shrink-0 shadow-sm z-10 relative">
        <h1 className="text-2xl font-bold text-foreground">Populate Venue Corpus</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Run the LLM extraction pipeline for a neighborhood. New venues land at <em>Pending Review</em>.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col p-8 max-w-4xl mx-auto w-full gap-8">
        {/* ── Form ── */}
        <form onSubmit={handleSubmit} className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-5">
          <div className="text-sm font-semibold text-foreground">New population run</div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Neighborhood <span className="text-destructive">*</span>
              </label>
              <input
                name="neighborhood"
                value={form.neighborhood}
                onChange={handleChange}
                placeholder="e.g. Williamsburg"
                className={fieldClass}
                required
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Borough</label>
              <input
                name="borough"
                value={form.borough}
                onChange={handleChange}
                placeholder="e.g. Brooklyn (optional)"
                className={fieldClass}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">City</label>
              <input
                name="city"
                value={form.city}
                onChange={handleChange}
                placeholder="Defaults to server default (optional)"
                className={fieldClass}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Venue Type</label>
              <select name="venueType" value={form.venueType} onChange={handleChange} className={fieldClass}>
                <option value="restaurant">Restaurant</option>
                <option value="bar">Bar</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Custom Yelp Search Term</label>
              <input
                name="customQuery"
                value={form.customQuery}
                onChange={handleChange}
                placeholder="e.g. ramen (overrides default, optional)"
                className={fieldClass}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Limit
                <span className="ml-1 text-muted-foreground/70 normal-case font-normal">(default 20)</span>
              </label>
              <input
                name="limit"
                type="number"
                min={1}
                max={200}
                value={form.limit}
                onChange={handleChange}
                className={fieldClass}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button
              type="submit"
              disabled={hasActiveRun || createRun.isPending || !form.neighborhood.trim()}
              className="gap-2"
            >
              {hasActiveRun ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Run in progress…
                </>
              ) : (
                <>
                  <PlayCircle className="h-4 w-4" /> Start population run
                </>
              )}
            </Button>
            {createRun.isError && (
              <span className="text-xs text-destructive">
                {(createRun.error as { message?: string })?.message ?? "Failed to start run"}
              </span>
            )}
          </div>
        </form>

        {/* ── Run history ── */}
        <div className="flex flex-col overflow-hidden">
          <div className="flex items-center justify-between mb-4 shrink-0">
            <div className="text-sm font-semibold text-foreground">Run History</div>
            {hasActiveRun && (
              <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
                <Loader2 className="h-3 w-3 animate-spin" /> Polling every 3s
              </div>
            )}
          </div>

          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-card border border-border rounded-xl h-16 animate-pulse" />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">No runs yet. Fill in the form above to start one.</div>
          ) : (
            <div className="space-y-3 pb-2">
              {runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          )}
        </div>

        {/* ── JIT Destinations ── */}
        <div className="border border-border rounded-2xl p-6 bg-card shadow-sm">
          <JITDestinationsSection />
        </div>
      </div>
    </div>
  );
}
