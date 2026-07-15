import { useState } from "react";
import {
  useListVenues,
  useGetVenue,
  useApproveVenue,
  useDowngradeVenue,
  useRejectVenue,
  getListVenuesQueryKey,
} from "@workspace/api-client-react";
import { format } from "date-fns";
import { Check, ArrowDownCircle, X, MapPin, Link as LinkIcon, ChevronDown, ChevronUp, UtensilsCrossed, Image } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

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
    setSaving(true);
    setError(null);
    setSaved(false);
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
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
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

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading signals and attributes…</div>;
  }
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
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary inline-flex items-center gap-1 hover:underline"
                    >
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

export function VenuesPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("pending_review");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: venues, isLoading } = useListVenues({ tier: activeTab as "pending_review" | "tier1" | "tier2" | "untiered" });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListVenuesQueryKey({ tier: "pending_review" }) });
    queryClient.invalidateQueries({ queryKey: getListVenuesQueryKey({ tier: "tier1" }) });
    queryClient.invalidateQueries({ queryKey: getListVenuesQueryKey({ tier: "tier2" }) });
    queryClient.invalidateQueries({ queryKey: getListVenuesQueryKey({ tier: "untiered" }) });
  };

  const approveVenue = useApproveVenue();
  const downgradeVenue = useDowngradeVenue();
  const rejectVenue = useRejectVenue();

  const isMutating = approveVenue.isPending || downgradeVenue.isPending || rejectVenue.isPending;

  const handleApprove = (id: number) => {
    approveVenue.mutate({ id }, {
      onSuccess: () => { toast.success("Approved to Tier 1"); invalidate(); },
      onError: () => toast.error("Failed to approve venue"),
    });
  };
  const handleDowngrade = (id: number) => {
    downgradeVenue.mutate({ id }, {
      onSuccess: () => { toast.success("Downgraded to Tier 2"); invalidate(); },
      onError: () => toast.error("Failed to downgrade venue"),
    });
  };
  const handleReject = (id: number) => {
    rejectVenue.mutate({ id }, {
      onSuccess: () => { toast.success("Rejected to untiered"); invalidate(); },
      onError: () => toast.error("Failed to reject venue"),
    });
  };

  const tabs = [
    { value: "pending_review", label: "Pending Review" },
    { value: "tier1", label: "Tier 1" },
    { value: "tier2", label: "Tier 2" },
    { value: "untiered", label: "Untiered" },
  ];

  return (
    <div className="h-[100dvh] flex flex-col bg-background overflow-hidden">
      <div className="px-8 py-6 border-b border-border bg-card shrink-0 shadow-sm z-10 relative">
        <h1 className="text-2xl font-bold text-foreground">Venue Corpus Review</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review LLM-extracted venue signals and attributes -- approve to Tier 1, downgrade to Tier 2 (hedged), or reject to untiered.
        </p>
      </div>

      <div className="flex-1 p-8 overflow-hidden flex flex-col max-w-6xl mx-auto w-full">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="grid w-full max-w-[560px] grid-cols-4 mb-6 bg-muted/50 p-1">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="data-[state=active]:bg-card data-[state=active]:shadow-sm rounded-md py-2 text-xs">
                {tab.label}
                {tab.value === activeTab && venues && venues.length > 0 && (
                  <span className="ml-2 bg-secondary text-secondary-foreground text-[10px] font-bold px-2 py-0.5 rounded-full">
                    {venues.length}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value={activeTab} className="flex-1 overflow-hidden flex flex-col m-0 outline-none">
            <ScrollArea className="flex-1 pr-4 -mr-4">
              {isLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="bg-card border border-border rounded-2xl h-32 animate-pulse" />
                  ))}
                </div>
              ) : !venues || venues.length === 0 ? (
                <div className="h-full min-h-[400px] flex items-center justify-center">
                  <Empty>
                    <EmptyMedia variant="icon">
                      <UtensilsCrossed />
                    </EmptyMedia>
                    <EmptyHeader>
                      <EmptyTitle>Nothing here</EmptyTitle>
                      <EmptyDescription>No venues in "{TIER_LABEL[activeTab]}" right now.</EmptyDescription>
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
                                  <span className="text-xs text-muted-foreground">
                                    {format(new Date(venue.createdAt), "MMM d, h:mm a")}
                                  </span>
                                  {venue.closureSuspected && (
                                    <Badge variant="destructive" className="text-[10px]">Closure suspected</Badge>
                                  )}
                                </div>
                                <h3 className="text-xl font-bold text-foreground">{venue.name}</h3>
                                <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                                  <MapPin className="h-4 w-4" />
                                  {venue.neighborhood}{venue.borough ? `, ${venue.borough}` : ""} -- {venue.category ?? venue.venueType}
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <div className="text-2xl font-bold text-foreground">
                                  {venue.compositeScore ? Number(venue.compositeScore).toFixed(0) : "--"}
                                </div>
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
                            <Button
                              onClick={() => handleApprove(venue.id)}
                              disabled={isMutating || venue.tier === "tier1"}
                              className="flex-1 md:flex-none w-full bg-primary hover:bg-primary/90 text-primary-foreground h-11"
                            >
                              <Check className="h-4 w-4 mr-2" /> Approve (Tier 1)
                            </Button>
                            <Button
                              onClick={() => handleDowngrade(venue.id)}
                              disabled={isMutating || venue.tier === "tier2"}
                              variant="outline"
                              className="flex-1 md:flex-none w-full h-11"
                            >
                              <ArrowDownCircle className="h-4 w-4 mr-2" /> Downgrade (Tier 2)
                            </Button>
                            <Button
                              onClick={() => handleReject(venue.id)}
                              disabled={isMutating || venue.tier === "untiered"}
                              variant="outline"
                              className="flex-1 md:flex-none w-full border-destructive/20 text-destructive hover:bg-destructive hover:text-destructive-foreground h-11"
                            >
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
      </div>
    </div>
  );
}
