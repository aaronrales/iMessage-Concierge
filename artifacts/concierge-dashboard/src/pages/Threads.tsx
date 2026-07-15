import React, { useState, useEffect } from "react";
import { useListThreads, useGetThread, getListThreadsQueryKey } from "@workspace/api-client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Search, Users as UsersIcon, MessageSquare, Bot, User, ShieldAlert, BarChart3, Trash2, StickyNote, Save } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { ErrorState } from "@/components/ErrorState";
import { toast } from "sonner";

export function ThreadsPage() {
  const { data: threads, isLoading: isLoadingList, isError: isErrorList, refetch: refetchList } = useListThreads();
  const [search, setSearch] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [adminNotes, setAdminNotes] = useState("");
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [confirmDeleteThreadId, setConfirmDeleteThreadId] = useState<number | null>(null);
  const [isDeletingThread, setIsDeletingThread] = useState(false);
  const qc = useQueryClient();

  const { data: threadDetail, isLoading: isLoadingDetail, isError: isErrorDetail, refetch: refetchDetail } = useGetThread(selectedThreadId || 0, { 
    query: { enabled: !!selectedThreadId, queryKey: ['thread', selectedThreadId] } 
  });

  useEffect(() => {
    if (threadDetail) {
      setAdminNotes(threadDetail.adminNotes ?? "");
    }
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
    if (confirmDeleteThreadId !== threadId) {
      setConfirmDeleteThreadId(threadId);
      return;
    }
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

  const filteredThreads = threads?.filter(thread => 
    (thread.title && thread.title.toLowerCase().includes(search.toLowerCase())) ||
    thread.participants.some(p => p.displayName?.toLowerCase().includes(search.toLowerCase()) || p.phoneNumber.includes(search))
  ) || [];

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      {/* Master View */}
      <div className="w-80 md:w-96 border-r border-border bg-card/50 flex flex-col shrink-0">
        <div className="p-4 border-b border-border bg-card">
          <h1 className="text-xl font-bold mb-4">Threads</h1>
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
              {[1, 2, 3, 4, 5].map(i => (
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
            <div className="p-8 text-center text-muted-foreground text-sm">
              No threads found.
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {filteredThreads.map(thread => (
                <button
                  key={thread.id}
                  onClick={() => setSelectedThreadId(thread.id)}
                  className={`w-full flex items-start gap-3 p-3 rounded-xl transition-all duration-200 text-left hover-elevate ${
                    (selectedThreadId === thread.id) 
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
                        {thread.title || (thread.isGroup ? "Group Chat" : thread.participants.find(p => p.role === 'user')?.displayName || thread.participants[0]?.phoneNumber)}
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

      {/* Detail View */}
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
            {/* Header */}
            <div className="px-6 py-3 border-b border-border bg-card flex items-center justify-between shrink-0 shadow-sm z-10 relative gap-4">
              <div className="min-w-0">
                <h2 className="font-bold text-lg truncate">
                  {threadDetail.title || (threadDetail.isGroup ? "Group Chat" : threadDetail.participants.find(p => p.role === 'user')?.displayName || threadDetail.participants[0]?.phoneNumber)}
                </h2>
                <div className="text-xs text-muted-foreground font-medium truncate">
                  {threadDetail.participants.map(p => p.displayName || p.phoneNumber).join(", ")}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="outline" className="bg-background">
                  ID: {threadDetail.id}
                </Badge>
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
                  <button
                    onClick={() => setConfirmDeleteThreadId(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
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
                    placeholder="Thread steering notes — injected into the agent system prompt for this thread (e.g. 'This group prefers Brooklyn venues' or 'Always confirm allergy-free options first')"
                    rows={2}
                    className="text-xs resize-none flex-1 bg-background"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isSavingNotes}
                    onClick={handleSaveNotes}
                    className="self-start mt-0.5"
                  >
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
                      const isAssistant = msg.role === 'assistant';
                      const isSystem = msg.role === 'system';
                      
                      const showAuthor = msg.role === 'user' && threadDetail.isGroup && 
                        (idx === 0 || threadDetail.messages[idx - 1].userId !== msg.userId);
                        
                      const authorName = msg.userId 
                        ? threadDetail.participants.find(p => p.userId === msg.userId)?.displayName 
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

              {/* Polls Sidebar (if group) */}
              {threadDetail.isGroup && threadDetail.polls.length > 0 && (
                <div className="w-72 border-l border-border bg-card/30 flex flex-col shrink-0">
                  <div className="p-4 border-b border-border bg-card flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-primary" />
                    <h3 className="font-semibold text-sm">Active Coordination</h3>
                  </div>
                  <ScrollArea className="flex-1">
                    <div className="p-4 space-y-4">
                      {threadDetail.polls.map(poll => (
                        <div key={poll.id} className="bg-card border border-border rounded-xl p-4 shadow-sm relative overflow-hidden">
                          {poll.status === 'closed' && (
                            <div className="absolute top-0 right-0 bg-muted px-2 py-0.5 rounded-bl-lg text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                              Closed
                            </div>
                          )}
                          <div className="font-medium text-sm mb-3 pr-10">{poll.question}</div>
                          <div className="space-y-2">
                            {poll.options.map(opt => {
                              const isWinner = poll.status === 'closed' && poll.winningOptionId === opt.id;
                              const totalVotes = poll.options.reduce((sum, o) => sum + o.voteCount, 0) || 1;
                              const pct = Math.round((opt.voteCount / totalVotes) * 100);
                              
                              return (
                                <div key={opt.id} className="relative">
                                  <div className={`absolute inset-0 rounded-md transition-all ${
                                    isWinner ? "bg-primary/20" : "bg-muted/50"
                                  }`} style={{ width: `${pct}%` }} />
                                  <div className={`relative px-3 py-2 flex items-center justify-between text-xs rounded-md border ${
                                    isWinner ? "border-primary/50 text-primary font-bold shadow-sm" : "border-transparent text-foreground"
                                  }`}>
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
              <EmptyMedia variant="icon">
                <MessageSquare />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No thread selected</EmptyTitle>
                <EmptyDescription>Select a conversation to view the message history.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </div>
    </div>
  );
}
