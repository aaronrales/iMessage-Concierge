import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { ThumbsUp, ThumbsDown, Bot, User, ExternalLink, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { ErrorState } from "@/components/ErrorState";

interface ContextMessage {
  id: number;
  role: string;
  direction: string;
  content: string;
  createdAt: string;
}

interface Turn {
  messageId: number;
  threadId: number;
  agentContent: string;
  agentCreatedAt: string;
  precedingUserContent: string | null;
  contextMessages: ContextMessage[];
  rating: "thumbs_up" | "thumbs_down" | null;
  failureTag: string | null;
  notes: string | null;
  ratedAt: string | null;
}

const FAILURE_TAGS = [
  { value: "wrong_venue", label: "Wrong venue" },
  { value: "missed_context", label: "Missed context" },
  { value: "wrong_tone", label: "Wrong tone" },
  { value: "too_long", label: "Too long" },
  { value: "off_topic", label: "Off topic" },
  { value: "other", label: "Other" },
];

async function fetchTurns(): Promise<Turn[]> {
  const res = await fetch("/api/turn-ratings/recent");
  if (!res.ok) throw new Error("Failed to load turns");
  const data = await res.json() as { turns: Turn[] };
  return data.turns;
}

async function submitRating(payload: {
  messageId: number;
  threadId: number;
  rating: "thumbs_up" | "thumbs_down";
  failureTag?: string | null;
  notes?: string | null;
}): Promise<void> {
  const res = await fetch(`/api/turn-ratings/${payload.messageId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: payload.threadId,
      rating: payload.rating,
      failureTag: payload.failureTag ?? null,
      notes: payload.notes ?? null,
    }),
  });
  if (!res.ok) throw new Error("Failed to save rating");
}

function TurnCard({ turn }: { turn: Turn }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [pendingRating, setPendingRating] = useState<"thumbs_up" | "thumbs_down" | null>(
    turn.rating,
  );
  const [failureTag, setFailureTag] = useState<string>(turn.failureTag ?? "");
  const [notes, setNotes] = useState(turn.notes ?? "");
  const [expanded, setExpanded] = useState(false);
  const [showContext, setShowContext] = useState(false);

  const mutation = useMutation({
    mutationFn: submitRating,
    onSuccess: () => {
      toast.success("Rating saved.");
      qc.invalidateQueries({ queryKey: ["turns"] });
    },
    onError: () => toast.error("Couldn't save rating."),
  });

  const handleRate = (rating: "thumbs_up" | "thumbs_down") => {
    const newRating = pendingRating === rating ? null : rating;
    // Allow toggling off - but we need a rating to submit; keep current
    const submitRatingValue = newRating ?? rating;
    setPendingRating(submitRatingValue);
    if (submitRatingValue === "thumbs_up") {
      mutation.mutate({
        messageId: turn.messageId,
        threadId: turn.threadId,
        rating: "thumbs_up",
        failureTag: null,
        notes: notes || null,
      });
    } else {
      setExpanded(true);
    }
  };

  const handleSaveThumbsDown = () => {
    mutation.mutate({
      messageId: turn.messageId,
      threadId: turn.threadId,
      rating: "thumbs_down",
      failureTag: failureTag || null,
      notes: notes || null,
    });
  };

  const rated = pendingRating !== null;

  return (
    <div
      className={`bg-card border rounded-xl p-5 shadow-sm transition-all duration-200 ${
        rated
          ? pendingRating === "thumbs_up"
            ? "border-green-500/30 bg-green-50/30 dark:bg-green-900/10"
            : "border-red-500/30 bg-red-50/30 dark:bg-red-900/10"
          : "border-border"
      }`}
    >
      {/* Thread / time header */}
      <div className="flex items-center justify-between mb-4 gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-mono text-xs">
            Thread #{turn.threadId}
          </Badge>
          <span>{formatDistanceToNow(new Date(turn.agentCreatedAt), { addSuffix: true })}</span>
          <span className="opacity-50">·</span>
          <span>{format(new Date(turn.agentCreatedAt), "MMM d, h:mm a")}</span>
        </div>
        <button
          onClick={() => navigate(`/threads?thread=${turn.threadId}`)}
          className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
        >
          View thread <ExternalLink className="h-3 w-3" />
        </button>
      </div>

      {/* Expandable context window */}
      {turn.contextMessages.length > 0 && (
        <div className="mb-3">
          <button
            onClick={() => setShowContext((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showContext ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {showContext ? "Hide" : "Show"} context
            <span className="opacity-60">({turn.contextMessages.length} messages)</span>
          </button>

          {showContext && (
            <div className="mt-2 p-3 bg-muted/30 rounded-lg border border-border/60 space-y-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Context window — what the agent saw
              </p>
              {turn.contextMessages.map((msg) => {
                const isAgent = msg.role === "assistant";
                return (
                  <div key={msg.id} className={`flex items-start gap-2 ${isAgent ? "opacity-50" : ""}`}>
                    <div
                      className={`h-5 w-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                        isAgent ? "bg-primary/10" : "bg-card border border-border"
                      }`}
                    >
                      {isAgent ? (
                        <Bot className="h-3 w-3 text-primary" />
                      ) : (
                        <User className="h-3 w-3 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs leading-relaxed text-foreground break-words">{msg.content}</p>
                      <span className="text-[10px] text-muted-foreground/60">
                        {format(new Date(msg.createdAt), "h:mm a")}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* User trigger message */}
      {turn.precedingUserContent && (
        <div className="flex items-start gap-3 mb-3 opacity-70">
          <div className="h-7 w-7 rounded-full bg-card border border-border flex items-center justify-center shrink-0 mt-0.5">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed italic">
            "{turn.precedingUserContent}"
          </p>
        </div>
      )}

      {/* Agent reply */}
      <div className="flex items-start gap-3 mb-4">
        <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="h-3.5 w-3.5 text-primary" />
        </div>
        <p className="text-sm leading-relaxed">{turn.agentContent}</p>
      </div>

      {/* Rating buttons */}
      <div className="flex items-center gap-2 pt-3 border-t border-border/50">
        <button
          onClick={() => handleRate("thumbs_up")}
          disabled={mutation.isPending}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
            pendingRating === "thumbs_up"
              ? "bg-green-500 text-white border-green-500 shadow-sm"
              : "bg-background border-border text-muted-foreground hover:border-green-400 hover:text-green-600"
          }`}
        >
          <ThumbsUp className="h-4 w-4" />
          Good
        </button>
        <button
          onClick={() => handleRate("thumbs_down")}
          disabled={mutation.isPending}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
            pendingRating === "thumbs_down"
              ? "bg-red-500 text-white border-red-500 shadow-sm"
              : "bg-background border-border text-muted-foreground hover:border-red-400 hover:text-red-600"
          }`}
        >
          <ThumbsDown className="h-4 w-4" />
          Needs work
        </button>
        {turn.ratedAt && (
          <span className="text-xs text-muted-foreground ml-auto">
            Rated {formatDistanceToNow(new Date(turn.ratedAt), { addSuffix: true })}
          </span>
        )}
      </div>

      {/* Expanded failure detail */}
      {(expanded || pendingRating === "thumbs_down") && (
        <div className="mt-4 space-y-3 pt-3 border-t border-border/50">
          <div className="flex items-center gap-3">
            <Select value={failureTag} onValueChange={setFailureTag}>
              <SelectTrigger className="w-48 h-8 text-sm">
                <SelectValue placeholder="Tag a failure reason" />
              </SelectTrigger>
              <SelectContent>
                {FAILURE_TAGS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes for the record (optional — helps improve future turns)"
            rows={2}
            className="text-sm resize-none"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={handleSaveThumbsDown}
              disabled={mutation.isPending}
            >
              Save feedback
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setExpanded(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function TurnsPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["turns"],
    queryFn: fetchTurns,
  });

  const ratedCount = data?.filter((t) => t.rating !== null).length ?? 0;
  const thumbsDown = data?.filter((t) => t.rating === "thumbs_down").length ?? 0;

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden">
      <div className="p-6 border-b border-border bg-card shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Turn Review</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Rate recent agent replies to build a feedback signal for prompt improvements.
            </p>
          </div>
          <div className="flex items-center gap-4">
            {data && (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span>
                  <span className="font-semibold text-foreground">{ratedCount}</span> / {data.length} rated
                </span>
                {thumbsDown > 0 && (
                  <Badge variant="destructive" className="gap-1">
                    <ThumbsDown className="h-3 w-3" /> {thumbsDown} need work
                  </Badge>
                )}
              </div>
            )}
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-1.5" /> Refresh
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 max-w-3xl mx-auto space-y-4">
          {isLoading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="bg-card border border-border rounded-xl p-5 space-y-3">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ))
          ) : isError ? (
            <ErrorState description="Couldn't load agent turns." onRetry={() => refetch()} />
          ) : !data || data.length === 0 ? (
            <div className="text-center py-20 text-muted-foreground">
              <Bot className="h-12 w-12 mx-auto mb-4 opacity-20" />
              <p className="font-medium">No turns yet</p>
              <p className="text-sm mt-1">Agent replies will appear here once users start messaging.</p>
            </div>
          ) : (
            data.map((turn) => <TurnCard key={turn.messageId} turn={turn} />)
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
