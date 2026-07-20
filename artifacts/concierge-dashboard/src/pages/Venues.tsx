import { useState, useEffect, useRef } from "react";
import {
  useListVenues,
  useGetVenue,
  useApproveVenue,
  useDowngradeVenue,
  useRejectVenue,
  getListVenuesQueryKey,
  useCreateVenuePopulationRun,
  useListVenuePopulationRuns,
  getListVenuePopulationRunsQueryKey,
  useListJITDestinationExtractions,
  useTriggerJITDestinationExtraction,
  getListJITDestinationExtractionsQueryKey,
} from "@workspace/api-client-react";
import type { VenuePopulationRun, DestinationVenueExtraction } from "@workspace/api-client-react";
import { format, formatDistanceStrict, formatDistanceToNow } from "date-fns";
import {
  Check, ArrowDownCircle, X, MapPin, Link as LinkIcon, ChevronDown, ChevronUp,
  UtensilsCrossed, Image, Loader2, ChevronRight, PlayCircle, Database, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { useSearch } from "wouter";

// ── Venue Corpus helpers ───────────────────────────────────────────────────

const TIER_LABEL: Record<string, string> = {
  pending_review: "Pending Review",
  tier1: "Tier 1",
  tier2: "Tier 2",
  untiered: "Untiered",
};

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const value = Number(confidence);
  const variant = value >= 0.7 ? "default" : value >= 0.4 ? "secondary" : "outline";
  return (
    <Badge variant={variant as "default" | "secondary" | "outline"} className="text-[10px]">
      {Math.round(value * 100)}% confidence
    </Badge>
  );
}

function GooglePlaceIdEditor({ venueId, initialPlaceId }: { venueId: number; initialPlaceId?: string | null }) {
  const [value, setValue] = useState(initialPlaceId ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const resp = await fetch(`/api/venues/${venueId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ googlePlaceId: value.trim() || null }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Save failed");
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch { setError("Network error"); }
    finally { setSaving(false); }
  };

  return (
    <div className="flex items-center gap-2 mt-3">
      <Image className="h-4 w-4 text-muted-foreground shrink-0" />
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Google Place ID (ChIJ…)"
        className="flex-1 h-8 text-xs rounded-md border border-border bg-background px-2.5 py-1 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
      />
      <button
        onClick={handleSave}
        disabled={saving}
        className="h-8 px-3 text-xs rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50 whitespace-nowrap"
      >
        {saving ? "Saving…" : saved ? "Saved ✓" : "Save Place ID"}
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function VenueDetailPanel({ venueId, googlePlaceId }: { venueId: number; googlePlaceId?: string | null }) {
  const { data: detail, isLoading } = useGetVenue(venueId);
  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading signals and attributes…</div>;
  if (!detail) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-muted/30 p-4 rounded-xl border border-border/50">
      <div>
        <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-2">Signals</div>
        <div className="space-y-2">
          {detail.signals.length === 0 && <div className="text-sm text-muted-foreground">No signals extracted yet.</div>}
          {detail.signals.map((signal) => (
            <div key={signal.id} className="text-sm bg-card border border-border rounded-lg p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{signal.source.replace(/_/g, " ")}</span>
                <ConfidenceBadge confidence={signal.confidence} />
              </div>
              <div className="text-muted-foreground mt-1">{String((signal.value as Record<string, unknown>)?.["note"] ?? "")}</div>
              {signal.sourceUrls.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-1.5">
                  {signal.sourceUrls.slice(0, 3).map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
                      <LinkIcon className="h-3 w-3" /> source
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-2">Attributes</div>
        <div className="space-y-2">
          {detail.attributes.length === 0 && <div className="text-sm text-muted-foreground">No attributes extracted yet.</div>}
          {detail.attributes.map((attribute) => (
            <div key={attribute.id} className="text-sm bg-card border border-border rounded-lg p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{attribute.dimension.replace(/_/g, " ")}</span>
                <div className="flex items-center gap-1">
                  <Badge variant="outline" className="text-[10px]">{attribute.sourceCount} src</Badge>
                  <ConfidenceBadge confidence={attribute.confidence} />
                </div>
              </div>
              <div className="text-muted-foreground mt-1">{String((attribute.value as Record<string, unknown>)?.["note"] ?? "")}</div>
            </div>
          ))}
        </div>
      </div>
      <GooglePlaceIdEditor venueId={venueId} initialPlaceId={googlePlaceId} />
    </div>
  );
}

// ── Corpus tab ─────────────────────────────────────────────────────────────

function CorpusTab() {
  const queryClient = useQueryClient();
  const [activeSubTab, setActiveSubTab] = useState("pending_review");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: venues, isLoading } = useListVenues({ tier: activeSubTab as "pending_review" | "tier1" | "tier2" | "untiered" });

  const invalidate = () => {
    ["pending_review", "tier1", "tier2", "untiered"].forEach((tier) =>
      queryClient.invalidateQueries({ queryKey: getListVenuesQueryKey({ tier: tier as "pending_review" | "tier1" | "tier2" | "untiered" }) }),
    );
  };

  const approveVenue = useApproveVenue();
  const downgradeVenue = useDowngradeVenue();
  const rejectVenue = useRejectVenue();
  const isMutating = approveVenue.isPending || downgradeVenue.isPending || rejectVenue.isPending;

  const handleApprove = (id: number) => approveVenue.mutate({ id }, { onSuccess: () => { toast.success("Approved to Tier 1"); invalidate(); }, onError: () => toast.error("Failed to approve venue") });
  const handleDowngrade = (id: number) => downgradeVenue.mutate({ id }, { onSuccess: () => { toast.success("Downgraded to Tier 2"); invalidate(); }, onError: () => toast.error("Failed to downgrade venue") });
  const handleReject = (id: number) => rejectVenue.mutate({ id }, { onSuccess: () => { toast.success("Rejected to untiered"); invalidate(); }, onError: () => toast.error("Failed to reject venue") });

  const subTabs = [
    { value: "pending_review", label: "Pending Review" },
    { value: "tier1", label: "Tier 1" },
    { value: "tier2", label: "Tier 2" },
    { value: "untiered", label: "Untiered" },
  ];

  return (
    <Tabs value={activeSubTab} onValueChange={setActiveSubTab} className="flex-1 flex flex-col overflow-hidden">
      <TabsList className="grid w-full max-w-[560px] grid-cols-4 mb-6 bg-muted/50 p-1 shrink-0">
        {subTabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} className="data-[state=active]:bg-card data-[state=active]:shadow-sm rounded-md py-2 text-xs">
            {tab.label}
            {tab.value === activeSubTab && venues && venues.length > 0 && (
              <span className="ml-2 bg-secondary text-secondary-foreground text-[10px] font-bold px-2 py-0.5 rounded-full">{venues.length}</span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value={activeSubTab} className="flex-1 overflow-hidden flex flex-col m-0 outline-none">
        <ScrollArea className="flex-1 pr-4 -mr-4">
          {isLoading ? (
            <div className="space-y-4">{[1, 2, 3].map((i) => <div key={i} className="bg-card border border-border rounded-2xl h-32 animate-pulse" />)}</div>
          ) : !venues || venues.length === 0 ? (
            <div className="h-full min-h-[400px] flex items-center justify-center">
              <Empty>
                <EmptyMedia variant="icon"><UtensilsCrossed /></EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>Nothing here</EmptyTitle>
                  <EmptyDescription>No venues in "{TIER_LABEL[activeSubTab]}" right now.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <div className="space-y-4 pb-8">
              {venues.map((venue) => {
                const isExpanded = expandedId === venue.id;
                return (
                  <div key={venue.id} className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
                    <div className="p-5 md:p-6 flex flex-col md:flex-row gap-6">
                      <div className="flex-1 space-y-3">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant="outline" className="text-xs font-mono">ID: {venue.id}</Badge>
                              <span className="text-xs text-muted-foreground">{format(new Date(venue.createdAt), "MMM d, h:mm a")}</span>
                              {venue.closureSuspected && <Badge variant="destructive" className="text-[10px]">Closure suspected</Badge>}
                            </div>
                            <h3 className="text-xl font-bold text-foreground">{venue.name}</h3>
                            <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                              <MapPin className="h-4 w-4" />
                              {venue.neighborhood}{venue.borough ? `, ${venue.borough}` : ""} — {venue.category ?? venue.venueType}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-2xl font-bold text-foreground">{venue.compositeScore ? Number(venue.compositeScore).toFixed(0) : "—"}</div>
                            <div className="text-xs text-muted-foreground">composite score</div>
                          </div>
                        </div>

                        <button
                          onClick={() => setExpandedId(isExpanded ? null : venue.id)}
                          className="text-sm text-primary inline-flex items-center gap-1 hover:underline"
                        >
                          {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          {isExpanded ? "Hide signals & attributes" : "View extracted signals & attributes"}
                        </button>

                        {isExpanded && <VenueDetailPanel venueId={venue.id} googlePlaceId={venue.googlePlaceId} />}
                      </div>

                      <div className="flex md:flex-col gap-3 justify-center md:border-l md:border-border md:pl-6 md:min-w-[160px]">
                        <Button onClick={() => handleApprove(venue.id)} disabled={isMutating || venue.tier === "tier1"} className="flex-1 md:flex-none w-full bg-primary hover:bg-primary/90 h-11">
                          <Check className="h-4 w-4 mr-2" /> Approve (Tier 1)
                        </Button>
                        <Button onClick={() => handleDowngrade(venue.id)} disabled={isMutating || venue.tier === "tier2"} variant="outline" className="flex-1 md:flex-none w-full h-11">
                          <ArrowDownCircle className="h-4 w-4 mr-2" /> Downgrade (Tier 2)
                        </Button>
                        <Button onClick={() => handleReject(venue.id)} disabled={isMutating || venue.tier === "untiered"} variant="outline" className="flex-1 md:flex-none w-full border-destructive/20 text-destructive hover:bg-destructive hover:text-destructive-foreground h-11">
                          <X className="h-4 w-4 mr-2" /> Reject
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
}

// ── JIT Destination helpers ────────────────────────────────────────────────

function JITStatusBadge({ status }: { status: string }) {
  if (status === "pending") {
    return <Badge className="gap-1 bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300"><Loader2 className="h-3 w-3 animate-spin" /> Extracting…</Badge>;
  }
  if (status === "done") return <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300">Done</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function JITExtractionRow({ row }: { row: DestinationVenueExtraction }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="px-5 py-3 flex flex-wrap items-center gap-3">
        <JITStatusBadge status={row.status} />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {row.destination}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {row.venueCount != null && <span><strong className="text-foreground">{row.venueCount}</strong> venues</span>}
            {row.extractedAt && <span>extracted {formatDistanceToNow(new Date(row.extractedAt), { addSuffix: true })}</span>}
            {row.expiresAt && <span>expires {format(new Date(row.expiresAt), "MMM d, yyyy")}</span>}
            {row.errorNote && <span className="text-destructive">{row.errorNote}</span>}
          </div>
        </div>
        {row.status === "done" && (row.venueData?.length ?? 0) > 0 && (
          <button onClick={() => setOpen((v) => !v)} className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:underline">
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {open ? "Hide" : "Preview"}
          </button>
        )}
      </div>
      {open && row.venueData && row.venueData.length > 0 && (
        <div className="border-t border-border bg-muted/30 px-5 py-3">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Cached venues (provisional — web-sourced)</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {row.venueData.map((v, i) => (
              <div key={i} className="text-xs flex gap-2 items-baseline">
                <span className="font-medium shrink-0 w-40 truncate">{v.name}</span>
                <span className="text-muted-foreground truncate flex-1">{v.vibe}</span>
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
      { onSuccess: () => { setDestinationInput(""); queryClient.invalidateQueries({ queryKey: getListJITDestinationExtractionsQueryKey() }); } },
    );
  };

  const fieldClass = "h-9 rounded-md border border-border bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">JIT Destinations</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Web-sourced venue knowledge extracted automatically when a trip locks a non-NYC destination.
          </div>
        </div>
        {hasPending && (
          <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
            <Loader2 className="h-3 w-3 animate-spin" /> Polling every 5s
          </div>
        )}
      </div>
      <form onSubmit={handleTrigger} className="flex gap-2 items-center">
        <input value={destinationInput} onChange={(e) => setDestinationInput(e.target.value)} placeholder="e.g. Nashville, Austin TX, Scottsdale" className={`${fieldClass} flex-1`} />
        <Button type="submit" variant="outline" size="sm" disabled={!destinationInput.trim() || trigger.isPending} className="gap-1.5 shrink-0">
          <RefreshCw className="h-3.5 w-3.5" /> Trigger
        </Button>
        {trigger.isError && <span className="text-xs text-destructive">{(trigger.error as { message?: string })?.message ?? "Failed"}</span>}
      </form>
      {isLoading ? (
        <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="bg-card border border-border rounded-xl h-12 animate-pulse" />)}</div>
      ) : extractions.length === 0 ? (
        <div className="text-sm text-muted-foreground py-6 text-center">No JIT extractions yet. They run automatically when a trip locks a non-NYC destination.</div>
      ) : (
        <div className="space-y-2">{extractions.map((row) => <JITExtractionRow key={row.id} row={row} />)}</div>
      )}
    </div>
  );
}

// ── Populate tab ───────────────────────────────────────────────────────────

function isActive(run: VenuePopulationRun) {
  return run.status === "running" || run.status === "pending";
}

function StatusBadge({ status }: { status: string }) {
  if (status === "running" || status === "pending") {
    return <Badge className="gap-1 bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300"><Loader2 className="h-3 w-3 animate-spin" /> In progress</Badge>;
  }
  if (status === "completed") return <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300">Completed</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
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
            {run.neighborhood}{run.borough ? `, ${run.borough}` : ""}{run.city ? ` · ${run.city}` : ""}
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
            <button onClick={() => setOpen((v) => !v)} className="text-xs text-destructive inline-flex items-center gap-1 hover:underline">
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

function PopulateTab() {
  const queryClient = useQueryClient();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { data: runs = [], isLoading } = useListVenuePopulationRuns();
  const createRun = useCreateVenuePopulationRun();
  const hasActiveRun = runs.some(isActive);

  useEffect(() => {
    if (hasActiveRun) {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => {
          queryClient.invalidateQueries({ queryKey: getListVenuePopulationRunsQueryKey() });
        }, 3000);
      }
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [hasActiveRun, queryClient]);

  const [form, setForm] = useState({
    neighborhood: "", borough: "", city: "",
    venueType: "restaurant" as "restaurant" | "bar",
    customQuery: "", limit: "20",
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.neighborhood.trim()) return;
    createRun.mutate(
      { data: { neighborhood: form.neighborhood.trim(), borough: form.borough.trim() || undefined, city: form.city.trim() || undefined, venueType: form.venueType, customQuery: form.customQuery.trim() || undefined, limit: Number(form.limit) || 20 } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListVenuePopulationRunsQueryKey() }) },
    );
  };

  const fieldClass = "h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="flex-1 overflow-y-auto flex flex-col gap-8 pb-8">
      <form onSubmit={handleSubmit} className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-5 shrink-0">
        <div className="text-sm font-semibold text-foreground">New population run</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Neighborhood <span className="text-destructive">*</span></label>
            <input name="neighborhood" value={form.neighborhood} onChange={handleChange} placeholder="e.g. Williamsburg" className={fieldClass} required />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Borough</label>
            <input name="borough" value={form.borough} onChange={handleChange} placeholder="e.g. Brooklyn (optional)" className={fieldClass} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">City</label>
            <input name="city" value={form.city} onChange={handleChange} placeholder="Defaults to server default (optional)" className={fieldClass} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Venue Type</label>
            <select name="venueType" value={form.venueType} onChange={handleChange} className={fieldClass}>
              <option value="restaurant">Restaurant</option>
              <option value="bar">Bar</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Custom Search Term</label>
            <input name="customQuery" value={form.customQuery} onChange={handleChange} placeholder="e.g. ramen (optional)" className={fieldClass} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Limit <span className="ml-1 text-muted-foreground/70 normal-case font-normal">(default 20)</span></label>
            <input name="limit" type="number" min={1} max={200} value={form.limit} onChange={handleChange} className={fieldClass} />
          </div>
        </div>
        <div className="flex items-center gap-3 pt-1">
          <Button type="submit" disabled={hasActiveRun || createRun.isPending || !form.neighborhood.trim()} className="gap-2">
            {hasActiveRun ? <><Loader2 className="h-4 w-4 animate-spin" /> Run in progress…</> : <><PlayCircle className="h-4 w-4" /> Start population run</>}
          </Button>
          {createRun.isError && <span className="text-xs text-destructive">{(createRun.error as { message?: string })?.message ?? "Failed to start run"}</span>}
        </div>
      </form>

      <div className="flex flex-col shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-semibold text-foreground">Run History</div>
          {hasActiveRun && (
            <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
              <Loader2 className="h-3 w-3 animate-spin" /> Polling every 3s
            </div>
          )}
        </div>
        {isLoading ? (
          <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="bg-card border border-border rounded-xl h-16 animate-pulse" />)}</div>
        ) : runs.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">No runs yet. Fill in the form above to start one.</div>
        ) : (
          <div className="space-y-3">{runs.map((run) => <RunRow key={run.id} run={run} />)}</div>
        )}
      </div>

      <div className="border border-border rounded-2xl p-6 bg-card shadow-sm shrink-0">
        <JITDestinationsSection />
      </div>
    </div>
  );
}

// ── Main VenuesPage ────────────────────────────────────────────────────────

export function VenuesPage() {
  const searchString = useSearch();
  const tabFromUrl = searchString ? new URLSearchParams(searchString).get("tab") ?? "corpus" : "corpus";
  const [activeMainTab, setActiveMainTab] = useState<"corpus" | "populate">(
    tabFromUrl === "populate" ? "populate" : "corpus",
  );

  return (
    <div className="h-[100dvh] flex flex-col bg-background overflow-hidden">
      <div className="px-8 py-6 border-b border-border bg-card shrink-0 shadow-sm z-10 relative">
        <h1 className="text-2xl font-bold text-foreground">Venues</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review and tier your venue corpus, or run the LLM extraction pipeline to add more.
        </p>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col max-w-6xl mx-auto w-full px-8">
        {/* Tab bar */}
        <div className="flex items-center gap-1 border-b border-border mb-6 shrink-0">
          <button
            onClick={() => setActiveMainTab("corpus")}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeMainTab === "corpus"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <UtensilsCrossed className="h-4 w-4" />
            Corpus
          </button>
          <button
            onClick={() => setActiveMainTab("populate")}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeMainTab === "populate"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Database className="h-4 w-4" />
            Populate
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col pb-8">
          {activeMainTab === "corpus" ? <CorpusTab /> : <PopulateTab />}
        </div>
      </div>
    </div>
  );
}
