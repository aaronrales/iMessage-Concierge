import React, { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Bot, User, Send, Terminal, AlertTriangle, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { format } from "date-fns";

// ── Types ──────────────────────────────────────────────────────────────────

interface EmulatorParticipant {
  userId: number;
  phoneNumber: string;
  displayName: string | null;
  threadId: number;
}

interface EmulatorThread {
  id: number;
  isGroup: boolean;
  title: string | null;
  primaryPhoneNumber: string | null;
  participants: EmulatorParticipant[];
}

interface CapturedMessage {
  threadId: number;
  content: string;
  mediaUrl?: string;
}

interface LogEntry {
  id: number;
  kind: "sent" | "received" | "system";
  senderPhone?: string;
  senderName?: string;
  threadId?: number;
  content: string;
  mediaUrl?: string;
  timestamp: Date;
}

// ── API calls ──────────────────────────────────────────────────────────────

async function fetchEmulatorThreads(): Promise<EmulatorThread[]> {
  const res = await fetch("/api/emulator/threads");
  if (!res.ok) throw new Error("Failed to load threads");
  return res.json() as Promise<EmulatorThread[]>;
}

async function sendEmulatorMessage(body: {
  threadId: number;
  senderPhone: string;
  content: string;
}): Promise<{ messages: CapturedMessage[] }> {
  const res = await fetch("/api/emulator/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Unknown error" })) as { error: string };
    throw new Error(err.error ?? "Send failed");
  }
  return res.json() as Promise<{ messages: CapturedMessage[] }>;
}

// ── Log entry components ───────────────────────────────────────────────────

function MessageBubble({ entry }: { entry: LogEntry }) {
  if (entry.kind === "system") {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">
          {entry.content}
        </span>
      </div>
    );
  }

  const isAgent = entry.kind === "received";
  const isSameThread = entry.threadId == null;

  return (
    <div className={`flex items-end gap-2 ${isAgent ? "" : "flex-row-reverse"}`}>
      {/* Avatar */}
      <div
        className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 mb-0.5 ${
          isAgent ? "bg-primary/10" : "bg-muted border border-border"
        }`}
      >
        {isAgent ? (
          <Bot className="h-3.5 w-3.5 text-primary" />
        ) : (
          <User className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </div>

      {/* Bubble */}
      <div className={`max-w-[72%] ${isAgent ? "" : ""}`}>
        {/* Sender label */}
        <div
          className={`flex items-center gap-1.5 mb-1 ${
            isAgent ? "" : "justify-end"
          }`}
        >
          <span className="text-[10px] font-medium text-muted-foreground">
            {isAgent
              ? "Concierge"
              : (entry.senderName ?? entry.senderPhone ?? "You")}
          </span>
          {!isSameThread && entry.threadId !== undefined && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 font-mono">
              → Thread #{entry.threadId}
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground/50">
            {format(entry.timestamp, "h:mm:ss a")}
          </span>
        </div>

        {/* Content bubble */}
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
            isAgent
              ? "bg-card border border-border text-foreground rounded-tl-sm"
              : "bg-primary text-primary-foreground rounded-tr-sm"
          }`}
        >
          {entry.content}
        </div>

        {entry.mediaUrl && (
          <a
            href={entry.mediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-1 text-[10px] text-primary hover:underline truncate max-w-xs"
          >
            📎 {entry.mediaUrl}
          </a>
        )}
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export function EmulatorPage() {
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [senderPhone, setSenderPhone] = useState("");
  const [messageText, setMessageText] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logIdCounter, setLogIdCounter] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: threads, isLoading: isLoadingThreads } = useQuery({
    queryKey: ["emulator-threads"],
    queryFn: fetchEmulatorThreads,
  });

  const selectedThread = threads?.find((t) => t.id === selectedThreadId) ?? null;

  // Auto-set sender to first participant when thread changes.
  useEffect(() => {
    if (selectedThread && selectedThread.participants.length > 0) {
      const first = selectedThread.participants[0];
      setSenderPhone(first?.phoneNumber ?? "");
    }
  }, [selectedThread?.id]);

  // Scroll to bottom after new log entries.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log.length]);

  const addEntry = (entry: Omit<LogEntry, "id">) => {
    setLogIdCounter((c) => {
      const id = c + 1;
      setLog((prev) => [...prev, { ...entry, id }]);
      return id;
    });
  };

  const mutation = useMutation({
    mutationFn: sendEmulatorMessage,
    onSuccess: (data) => {
      // Add agent replies to the log.
      if (data.messages.length === 0) {
        addEntry({
          kind: "system",
          content: "Agent returned no reply.",
          timestamp: new Date(),
        });
      }
      for (const msg of data.messages) {
        addEntry({
          kind: "received",
          threadId: msg.threadId !== selectedThreadId ? msg.threadId : undefined,
          content: msg.content,
          mediaUrl: msg.mediaUrl,
          timestamp: new Date(),
        });
      }
    },
    onError: (err: Error) => {
      toast.error(err.message ?? "Send failed");
      addEntry({
        kind: "system",
        content: `⚠ Error: ${err.message}`,
        timestamp: new Date(),
      });
    },
  });

  const handleSend = () => {
    if (!selectedThreadId || !senderPhone.trim() || !messageText.trim()) return;

    const text = messageText.trim();
    const sender = selectedThread?.participants.find((p) => p.phoneNumber === senderPhone);

    // Add the outbound message to the log.
    addEntry({
      kind: "sent",
      senderPhone,
      senderName: sender?.displayName ?? undefined,
      content: text,
      timestamp: new Date(),
    });

    setMessageText("");
    mutation.mutate({ threadId: selectedThreadId, senderPhone, content: text });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const threadLabel = (t: EmulatorThread) => {
    if (t.title) return t.title;
    if (t.isGroup) return `Group #${t.id}`;
    const user = t.participants[0];
    return user?.displayName ?? user?.phoneNumber ?? `Thread #${t.id}`;
  };

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <Terminal className="h-4 w-4 text-amber-600" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Conversation Emulator</h1>
            <p className="text-xs text-muted-foreground leading-tight mt-0.5">
              Messages are processed but{" "}
              <span className="font-medium text-amber-600">NOT delivered via iMessage</span>
            </p>
          </div>
          <div className="ml-auto">
            <Badge
              variant="outline"
              className="border-amber-500/40 text-amber-600 bg-amber-50 dark:bg-amber-900/20 gap-1.5 text-xs"
            >
              <AlertTriangle className="h-3 w-3" />
              Test mode
            </Badge>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: controls */}
        <div className="w-72 border-r border-border bg-card flex flex-col shrink-0 overflow-y-auto">
          <div className="p-4 space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Thread
              </label>
              {isLoadingThreads ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select
                  value={selectedThreadId?.toString() ?? ""}
                  onValueChange={(v) => {
                    setSelectedThreadId(parseInt(v, 10));
                    setLog([]);
                  }}
                >
                  <SelectTrigger className="w-full text-sm">
                    <SelectValue placeholder="Select a thread…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(threads ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id.toString()}>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-muted-foreground text-xs">
                            #{t.id}
                          </span>
                          <span className="truncate max-w-[160px]">{threadLabel(t)}</span>
                          {t.isGroup && (
                            <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4">
                              group
                            </Badge>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {selectedThread && (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Sender
                  </label>
                  <Select value={senderPhone} onValueChange={setSenderPhone}>
                    <SelectTrigger className="w-full text-sm">
                      <SelectValue placeholder="Pick participant…" />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedThread.participants.map((p) => (
                        <SelectItem key={p.phoneNumber} value={p.phoneNumber}>
                          <div className="flex items-center gap-2">
                            <span className="truncate max-w-[140px]">
                              {p.displayName ?? p.phoneNumber}
                            </span>
                            {p.displayName && (
                              <span className="text-muted-foreground font-mono text-[10px]">
                                {p.phoneNumber}
                              </span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                      <SelectItem value="__custom__" disabled>
                        ── or enter a phone below ──
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {/* Manual phone override */}
                  <Input
                    className="text-sm font-mono"
                    placeholder="+1 555 000 0000"
                    value={senderPhone}
                    onChange={(e) => setSenderPhone(e.target.value)}
                  />
                </div>

                {/* Participants list */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Participants
                  </label>
                  <div className="space-y-1">
                    {selectedThread.participants.map((p) => (
                      <div
                        key={p.phoneNumber}
                        className={`flex items-center justify-between py-1 px-2 rounded-md text-xs ${
                          p.phoneNumber === senderPhone
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground"
                        }`}
                      >
                        <span className="font-medium truncate max-w-[120px]">
                          {p.displayName ?? p.phoneNumber}
                        </span>
                        {p.phoneNumber === senderPhone && (
                          <span className="text-[10px] font-medium">← sender</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {!selectedThread && !isLoadingThreads && (
              <p className="text-xs text-muted-foreground text-center pt-4">
                Select a thread to start testing
              </p>
            )}
          </div>
        </div>

        {/* Right panel: conversation log + input */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {!selectedThread ? (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              <div className="text-center space-y-3">
                <Terminal className="h-12 w-12 mx-auto opacity-20" />
                <p className="font-medium">No thread selected</p>
                <p className="text-sm">Pick a thread from the left panel to begin</p>
              </div>
            </div>
          ) : (
            <>
              {/* Message log */}
              <ScrollArea className="flex-1">
                <div className="p-6 space-y-4 max-w-2xl mx-auto">
                  {log.length === 0 ? (
                    <div className="text-center py-20 text-muted-foreground">
                      <Bot className="h-10 w-10 mx-auto mb-3 opacity-20" />
                      <p className="text-sm font-medium">No messages yet</p>
                      <p className="text-xs mt-1">Type a message below to start the emulator</p>
                    </div>
                  ) : (
                    log.map((entry) => <MessageBubble key={entry.id} entry={entry} />)
                  )}
                  <div ref={bottomRef} />
                </div>
              </ScrollArea>

              {/* Input area */}
              <div className="border-t border-border bg-card p-4 shrink-0">
                <div className="max-w-2xl mx-auto">
                  <div className="flex items-end gap-3">
                    <Textarea
                      value={messageText}
                      onChange={(e) => setMessageText(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Type a message… (⌘+Enter to send)"
                      rows={2}
                      className="resize-none flex-1 text-sm"
                      disabled={mutation.isPending}
                    />
                    <Button
                      onClick={handleSend}
                      disabled={
                        mutation.isPending ||
                        !messageText.trim() ||
                        !senderPhone.trim() ||
                        !selectedThreadId
                      }
                      className="shrink-0"
                    >
                      {mutation.isPending ? (
                        <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-2 text-center">
                    Sending as{" "}
                    <span className="font-mono font-medium">
                      {selectedThread.participants.find((p) => p.phoneNumber === senderPhone)?.displayName ?? (senderPhone || "—")}
                    </span>{" "}
                    into{" "}
                    <span className="font-medium">
                      {threadLabel(selectedThread)}
                    </span>
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
