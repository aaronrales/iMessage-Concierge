import React, { useState, useEffect } from "react";
import { useListThreads, useGetThread, getListThreadsQueryKey } from "@workspace/api-client-react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { format, formatDistanceToNow } from "date-fns";
import {
  Search, Users as UsersIcon, MessageSquare, Bot, User, ShieldAlert, BarChart3,
  Trash2, StickyNote, Save, ThumbsUp, ThumbsDown, RefreshCw, ChevronDown, ChevronUp,
  Filter, X as XIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { ErrorState } from "@/components/ErrorState";
import { toast } from "sonner";

// ── Turn Review types & helpers (inlined from Turns.tsx) ──────────────────

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

function TurnCard({
  turn,
  onViewThread,
}: {
  turn: Turn;
  onViewThread: (threadId: number) => void;
}) {
  const qc = useQueryClient();
  const [pendingRating, setPendingRating] = useState<"thumbs_up" | "thumbs_down" | null>(turn.rating);
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
    const submitRatingValue = pendingRating === rating ? rating : rating;
    setPendingRating(submitRatingValue);
    if (submitRatingValue === "thumbs_up") {
      mutation.mutate({ messageId: turn.messageId, threadId: turn.threadId, rating: "thumbs_up", failureTag: null, notes: notes || null });
    } else {
      setExpanded(true);
    }
  };

  const handleSaveThumbsDown = () => {
    mutation.mutate({ messageId: turn.messageId, threadId: turn.threadId, rating: "thumbs_down", failureTag: failureTag || null, notes: notes || null });
  };

  const rated = pendingRating !== null;

  return (
    <div className={`bg-card border rounded-xl p-5 shadow-sm transition-all duration-200 ${
      rated
        ? pendingRating === "thumbs_up"
          ? "border-green-500/30 bg-green-50/30 dark:bg-green-900/10"
          : "border-red-500/30 bg-red-50/30 dark:bg-red-900/10"
        : "border-border"
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-mono text-xs">Thread #{turn.threadId}</Badge>
          <span>{formatDistanceToNow(new Date(turn.agentCreatedAt), { addSuffix: true })}</span>
          <span className="opacity-50">·</span>
          <span>{format(new Date(turn.agentCreatedAt), "MMM d, h:mm a")}</span>
        </div>
        <button
          onClick={() => onViewThread(turn.threadId)}
          className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
        >
          View conversation →
        </button>
      </div>

      {/* Context toggle */}
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
                    <div className={`h-5 w-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${isAgent ? "bg-primary/10" : "bg-card border border-border"}`}>
                      {isAgent ? <Bot className="h-3 w-3 text-primary" /> : <User className="h-3 w-3 text-muted-foreground" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs leading-relaxed text-foreground break-words">{msg.content}</p>
                      <span className="text-[10px] text-muted-foreground/60">{format(new Date(msg.createdAt), "h:mm a")}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Preceding user message */}
      {turn.precedingUserContent && (
        <div className="flex items-start gap-3 mb-3 opacity-70">
          <div className="h-7 w-7 rounded-full bg-card border border-border flex items-center justify-center shrink-0 mt-0.5">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed italic">"{turn.precedingUserContent}"</p>
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
          <ThumbsUp className="h-4 w-4" /> Good
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
          <ThumbsDown className="h-4 w-4" /> Needs work
        </button>
        {turn.ratedAt && (
          <span className="text-xs text-muted-foreground ml-auto">
            Rated {formatDistanceToNow(new Date(turn.ratedAt), { addSuffix: true })}
          </span>
        )}
      </div>

      {/* Failure detail */}
      {(expanded || pendingRating === "thumbs_down") && (
        <div className="mt-4 space-y-3 pt-3 border-t border-border/50">
          <Select value={failureTag} onValueChange={setFailureTag}>
            <SelectTrigger className="w-48 h-8 text-sm">
              <SelectValue placeholder="Tag a failure reason" />
            </SelectTrigger>
            <SelectContent>
              {FAILURE_TAGS.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes for the record (optional)"
            rows={2}
            className="text-sm resize-none"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={handleSaveThumbsDown} disabled={mutation.isPending}>
              Save feedback
            </Button>
            <Button size="sm" variant="outline" onClick={() => setExpanded(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TurnReviewPanel({
  threadFilter,
  threadFilterName,
  onClearFilter,
  onViewThread,
}: {
  threadFilter: number | null;
  threadFilterName: string | null;
  onClearFilter: () => void;
  onViewThread: (threadId: number) => void;
}) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["turns"],
    queryFn: fetchTurns,
  });

  const displayed = threadFilter ? (data ?? []).filter((t) => t.threadId === threadFilter) : (data ?? []);
  const ratedCount = displayed.filter((t) => t.rating !== null).length;
  const thumbsDown = displayed.filter((t) => t.rating === "thumbs_down").length;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Turn review sub-header */}
      <div className="px-6 py-3 border-b border-border bg-card shrink-0 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          {threadFilter && (
            <div className="flex items-center gap-1.5 bg-primary/10 text-primary text-xs font-medium px-3 py-1 rounded-full border border-primary/20">
              <Filter className="h-3 w-3" />
              {threadFilterName ? `Thread: ${threadFilterName}` : `Thread #${threadFilter}`}
              <button onClick={onClearFilter} className="ml-1 hover:text-primary/70">
                <XIcon className="h-3 w-3" />
              </button>
            </div>
          )}
          {data && (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span>
                <span className="font-semibold text-foreground">{ratedCount}</span> / {displayed.length} rated
              </span>
              {thumbsDown > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <ThumbsDown className="h-3 w-3" /> {thumbsDown} need work
                </Badge>
              )}
            </div>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-1.5" /> Refresh
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 max-w-3xl mx-auto space-y-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-card border border-border rounded-xl p-5 space-y-3">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ))
          ) : isError ? (
            <ErrorState description="Couldn't load agent turns." onRetry={() => refetch()} />
          ) : displayed.length === 0 ? (
            <div className="text-center py-20 text-muted-foreground">
              <Bot className="h-12 w-12 mx-auto mb-4 opacity-20" />
              <p className="font-medium">{threadFilter ? "No turns for this thread yet" : "No turns yet"}</p>
              {threadFilter && (
                <button onClick={onClearFilter} className="text-sm text-primary mt-2 hover:underline">
                  Show all threads
                </button>
              )}
            </div>
          ) : (
            displayed.map((turn) => (
              <TurnCard key={turn.messageId} turn={turn} onViewThread={onViewThread} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Main ThreadsPage ──────────────────────────────────────────────────────

export function ThreadsPage() {
  const { data: threads, isLoading: isLoadingList, isError: isErrorList, refetch: refetchList } = useListThreads();

  // Parse URL params
  const searchString = useSearch();
  const urlParams = searchString ? new URLSearchParams(searchString) : null;
  const tabFromUrl = urlParams?.get("tab") ?? null;
  const threadFromUrl = urlParams ? parseInt(urlParams.get("thread") ?? "", 10) || null : null;

  const [activeMainTab, setActiveMainTab] = useState<"conversations" | "turns">(
    tabFromUrl === "turns" ? "turns" : "conversations",
  );
  const [search, setSearch] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(threadFromUrl);
  const [adminNotes, setAdminNotes] = useState("");
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [confirmDeleteThreadId, setConfirmDeleteThreadId] = useState<number | null>(null);
  const [isDeletingThread, setIsDeletingThread] = useState(false);
  // Turn Review filter — null = show all, number = show that thread only
  const [turnThreadFilter, setTurnThreadFilter] = useState<number | null>(null);
  const qc = useQueryClient();

  const { data: threadDetail, isLoading: isLoadingDetail, isError: isErrorDetail, refetch: refetchDetail } = useGetThread(
    selectedThreadId || 0,
    { query: { enabled: !!selectedThreadId, queryKey: ["thread", selectedThreadId] } },
  );

  useEffect(() => {
    if (threadDetail) setAdminNotes(threadDetail.adminNotes ?? "");
  }, [threadDetail]);

  const handleSaveNotes = async () => {
    if (!selectedThreadId) return;
    setIsSavingNotes(true);
    try {
      const res = await fetch(`/api/threads/${selectedThreadId}/admin-notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminNotes }),
      });
      if (!res.ok) throw new Error("Save failed");
      toast.success("Thread notes saved.");
      refetchDetail();
    } catch {
      toast.error("Couldn't save notes. Try again.");
    } finally {
      setIsSavingNotes(false);
    }
  };

  const handleDeleteThread = async (threadId: number) => {
    if (confirmDeleteThreadId !== threadId) { setConfirmDeleteThreadId(threadId); return; }
    setIsDeletingThread(true);
    try {
      const res = await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success("Thread deleted.");
      setSelectedThreadId(null);
      setConfirmDeleteThreadId(null);
      qc.invalidateQueries({ queryKey: getListThreadsQueryKey() });
    } catch {
      toast.error("Couldn't delete thread. Try again.");
    } finally {
      setIsDeletingThread(false);
    }
  };

  // Switching to Turn Review from a selected thread auto-filters to that thread
  const handleSwitchToTurns = () => {
    setTurnThreadFilter(selectedThreadId);
    setActiveMainTab("turns");
  };

  // From a turn card "View conversation →" — switch back and select the thread
  const handleViewThread = (threadId: number) => {
    setSelectedThreadId(threadId);
    setActiveMainTab("conversations");
  };

  const filteredThreads = threads?.filter((thread) =>
    (thread.title && thread.title.toLowerCase().includes(search.toLowerCase())) ||
    thread.participants.some(
      (p) => p.displayName?.toLowerCase().includes(search.toLowerCase()) || p.phoneNumber.includes(search),
    ),
  ) ?? [];

  // Name of the filtered thread (for the filter chip label)
  const filteredThreadName = turnThreadFilter
    ? (() => {
        const t = threads?.find((x) => x.id === turnThreadFilter);
        return t ? (t.title || t.participants.find((p) => p.role === "user")?.displayName || `#${t.id}`) : null;
      })()
    : null;

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden">
      {/* Top-level tab bar */}
      <div className="flex items-center gap-1 px-4 border-b border-border bg-card shrink-0">
        <button
          onClick={() => setActiveMainTab("conversations")}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeMainTab === "conversations"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <MessageSquare className="h-4 w-4" />
          Conversations
          {threads && (
            <span className="text-xs opacity-60 font-normal">({threads.length})</span>
          )}
        </button>
        <button
          onClick={handleSwitchToTurns}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeMainTab === "turns"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <ThumbsUp className="h-4 w-4" />
          Turn Review
          {selectedThreadId && activeMainTab === "conversations" && (
            <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">
              will filter to this thread
            </span>
          )}
        </button>
      </div>

      {activeMainTab === "conversations" ? (
        /* ── Conversations tab ─────────────────────────────────────────── */
        <div className="flex flex-1 overflow-hidden">
          {/* Master sidebar */}
          <div className="w-80 md:w-96 border-r border-border bg-card/50 flex flex-col shrink-0">
            <div className="p-4 border-b border-border bg-card">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search threads..."
                  className="pl-9 bg-background"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            <ScrollArea className="flex-1">
              {isLoadingList ? (
                <div className="p-4 space-y-4">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="flex gap-3">
                      <Skeleton className="h-12 w-12 rounded-full shrink-0" />
                      <div className="space-y-2 flex-1">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-1/2" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : isErrorList ? (
                <ErrorState description="Couldn't load threads." onRetry={() => refetchList()} />
              ) : filteredThreads.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm">No threads found.</div>
              ) : (
                <div className="p-2 space-y-1">
                  {filteredThreads.map((thread) => (
                    <button
                      key={thread.id}
                      onClick={() => setSelectedThreadId(thread.id)}
                      className={`w-full flex items-start gap-3 p-3 rounded-xl transition-all duration-200 text-left hover-elevate ${
                        selectedThreadId === thread.id
                          ? "bg-primary/10 border border-primary/20 shadow-sm"
                          : "hover:bg-accent/50 border border-transparent text-foreground"
                      }`}
                    >
                      <div className={`h-12 w-12 rounded-full flex items-center justify-center shrink-0 ${
                        thread.isGroup ? "bg-secondary/15 text-secondary-foreground" : "bg-primary/10 text-primary"
                      }`}>
                        {thread.isGroup ? <UsersIcon className="h-5 w-5" /> : <MessageSquare className="h-5 w-5" />}
                      </div>
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="font-semibold truncate">
                            {thread.title || (thread.isGroup ? "Group Chat" : thread.participants.find((p) => p.role === "user")?.displayName || thread.participants[0]?.phoneNumber)}
                          </span>
                          {thread.lastMessageAt && (
                            <span className="text-xs text-muted-foreground shrink-0">
                              {format(new Date(thread.lastMessageAt), "MMM d")}
                            </span>
                          )}
                        </div>
                        <p className={`text-sm truncate ${selectedThreadId === thread.id ? "text-foreground" : "text-muted-foreground"}`}>
                          {thread.lastMessagePreview || "No messages yet"}
                        </p>
                        {thread.isGroup && (
                          <div className="flex items-center gap-1 mt-1.5 text-xs font-medium text-muted-foreground">
                            <UsersIcon className="h-3 w-3" />
                            {thread.participants.length} participants
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Detail pane */}
          <div className="flex-1 bg-background flex flex-col h-full overflow-hidden relative">
            {isLoadingDetail && selectedThreadId ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="flex flex-col items-center gap-4 text-muted-foreground">
                  <Bot className="h-8 w-8 animate-pulse text-primary/50" />
                  <p>Loading thread...</p>
                </div>
              </div>
            ) : isErrorDetail && selectedThreadId ? (
              <div className="flex-1 flex items-center justify-center">
                <ErrorState description="Couldn't load this thread." onRetry={() => refetchDetail()} />
              </div>
            ) : threadDetail ? (
              <>
                {/* Thread header */}
                <div className="px-6 py-3 border-b border-border bg-card flex items-center justify-between shrink-0 shadow-sm z-10 relative gap-4">
                  <div className="min-w-0">
                    <h2 className="font-bold text-lg truncate">
                      {threadDetail.title || (threadDetail.isGroup ? "Group Chat" : threadDetail.participants.find((p) => p.role === "user")?.displayName || threadDetail.participants[0]?.phoneNumber)}
                    </h2>
                    <div className="text-xs text-muted-foreground font-medium truncate">
                      {threadDetail.participants.map((p) => p.displayName || p.phoneNumber).join(", ")}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="bg-background">ID: {threadDetail.id}</Badge>
                    <Button
                      size="sm"
                      variant={confirmDeleteThreadId === threadDetail.id ? "destructive" : "outline"}
                      disabled={isDeletingThread}
                      onClick={() => handleDeleteThread(threadDetail.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      {confirmDeleteThreadId === threadDetail.id ? "Confirm" : "Delete"}
                    </Button>
                    {confirmDeleteThreadId === threadDetail.id && (
                      <button onClick={() => setConfirmDeleteThreadId(null)} className="text-xs text-muted-foreground hover:text-foreground">
                        Cancel
                      </button>
                    )}
                  </div>
                </div>

                {/* Admin steering notes */}
                <div className="px-6 py-3 border-b border-border bg-muted/30 shrink-0">
                  <div className="flex items-start gap-3 max-w-2xl">
                    <StickyNote className="h-4 w-4 text-muted-foreground mt-2 shrink-0" />
                    <div className="flex-1 flex gap-2">
                      <Textarea
                        value={adminNotes}
                        onChange={(e) => setAdminNotes(e.target.value)}
                        placeholder="Thread steering notes — injected into the agent system prompt for this thread"
                        rows={2}
                        className="text-xs resize-none flex-1 bg-background"
                      />
                      <Button size="sm" variant="outline" disabled={isSavingNotes} onClick={handleSaveNotes} className="self-start mt-0.5">
                        <Save className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex-1 flex overflow-hidden">
                  {/* Messages */}
                  <ScrollArea className="flex-1 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] bg-fixed">
                    <div className="p-6 space-y-6 max-w-3xl mx-auto">
                      {threadDetail.messages.length === 0 ? (
                        <div className="text-center text-muted-foreground mt-12 bg-card p-8 rounded-xl border border-border border-dashed shadow-sm">
                          <MessageSquare className="h-8 w-8 mx-auto mb-3 opacity-50" />
                          <p>No messages in this thread yet.</p>
                        </div>
                      ) : (
                        threadDetail.messages.map((msg, idx) => {
                          const isAssistant = msg.role === "assistant";
                          const isSystem = msg.role === "system";
                          const showAuthor = msg.role === "user" && threadDetail.isGroup &&
                            (idx === 0 || threadDetail.messages[idx - 1].userId !== msg.userId);
                          const authorName = msg.userId
                            ? threadDetail.participants.find((p) => p.userId === msg.userId)?.displayName
                            : null;

                          if (isSystem) {
                            return (
                              <div key={msg.id} className="flex justify-center my-6">
                                <div className="bg-muted text-muted-foreground text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-sm border border-border/50">
                                  <ShieldAlert className="h-3 w-3" />
                                  {msg.content}
                                </div>
                              </div>
                            );
                          }

                          return (
                            <div key={msg.id} className={`flex flex-col ${isAssistant ? "items-start" : "items-end"} w-full group`}>
                              {showAuthor && !isAssistant && (
                                <div className="text-xs text-muted-foreground mb-1 ml-1 font-medium">{authorName}</div>
                              )}
                              <div className={`flex gap-3 max-w-[80%] ${isAssistant ? "flex-row" : "flex-row-reverse"}`}>
                                <div className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 shadow-sm ${
                                  isAssistant ? "bg-primary text-primary-foreground" : "bg-card border border-border"
                                }`}>
                                  {isAssistant ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4 text-muted-foreground" />}
                                </div>
                                <div className={`flex flex-col ${isAssistant ? "items-start" : "items-end"}`}>
                                  <div className={`px-4 py-3 rounded-2xl shadow-sm text-sm whitespace-pre-wrap leading-relaxed ${
                                    isAssistant
                                      ? "bg-card border border-border text-foreground rounded-tl-sm"
                                      : "bg-primary text-primary-foreground rounded-tr-sm"
                                  }`}>
                                    {msg.content}
                                  </div>
                                  <span className="text-[10px] text-muted-foreground mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {format(new Date(msg.createdAt), "h:mm a")}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </ScrollArea>

                  {/* Polls sidebar */}
                  {threadDetail.isGroup && threadDetail.polls.length > 0 && (
                    <div className="w-72 border-l border-border bg-card/30 flex flex-col shrink-0">
                      <div className="p-4 border-b border-border bg-card flex items-center gap-2">
                        <BarChart3 className="h-4 w-4 text-primary" />
                        <h3 className="font-semibold text-sm">Active Coordination</h3>
                      </div>
                      <ScrollArea className="flex-1">
                        <div className="p-4 space-y-4">
                          {threadDetail.polls.map((poll) => (
                            <div key={poll.id} className="bg-card border border-border rounded-xl p-4 shadow-sm relative overflow-hidden">
                              {poll.status === "closed" && (
                                <div className="absolute top-0 right-0 bg-muted px-2 py-0.5 rounded-bl-lg text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                                  Closed
                                </div>
                              )}
                              <div className="font-medium text-sm mb-3 pr-10">{poll.question}</div>
                              <div className="space-y-2">
                                {poll.options.map((opt) => {
                                  const isWinner = poll.status === "closed" && poll.winningOptionId === opt.id;
                                  const totalVotes = poll.options.reduce((sum, o) => sum + o.voteCount, 0) || 1;
                                  const pct = Math.round((opt.voteCount / totalVotes) * 100);
                                  return (
                                    <div key={opt.id} className="relative">
                                      <div className={`absolute inset-0 rounded-md transition-all ${isWinner ? "bg-primary/20" : "bg-muted/50"}`} style={{ width: `${pct}%` }} />
                                      <div className={`relative px-3 py-2 flex items-center justify-between text-xs rounded-md border ${isWinner ? "border-primary/50 text-primary font-bold shadow-sm" : "border-transparent text-foreground"}`}>
                                        <span className="truncate mr-4">{opt.label}</span>
                                        <span className="shrink-0">{opt.voteCount} <span className="opacity-50 text-[10px]">({pct}%)</span></span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <Empty>
                  <EmptyMedia variant="icon"><MessageSquare /></EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>No thread selected</EmptyTitle>
                    <EmptyDescription>Select a conversation to view the message history.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ── Turn Review tab ───────────────────────────────────────────── */
        <TurnReviewPanel
          threadFilter={turnThreadFilter}
          threadFilterName={filteredThreadName}
          onClearFilter={() => setTurnThreadFilter(null)}
          onViewThread={handleViewThread}
        />
      )}
    </div>
  );
}
