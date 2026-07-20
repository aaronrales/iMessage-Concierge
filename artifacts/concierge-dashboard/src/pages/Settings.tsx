import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, Info, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { ErrorState } from "@/components/ErrorState";

interface AgentConfig {
  globalGuidance: string;
  persona: string;
}

async function fetchAgentConfig(): Promise<AgentConfig> {
  const res = await fetch("/api/agent-config");
  if (!res.ok) throw new Error("Failed to load agent config");
  return res.json() as Promise<AgentConfig>;
}

async function saveAgentConfig(config: Partial<AgentConfig>): Promise<void> {
  const res = await fetch("/api/agent-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error("Failed to save config");
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["agent-config"],
    queryFn: fetchAgentConfig,
  });

  const [guidance, setGuidance] = useState("");
  const [persona, setPersona] = useState("");

  useEffect(() => {
    if (data) {
      setGuidance(data.globalGuidance ?? "");
      setPersona(data.persona ?? "");
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: saveAgentConfig,
    onSuccess: () => {
      toast.success("Settings saved.");
      qc.invalidateQueries({ queryKey: ["agent-config"] });
    },
    onError: () => toast.error("Couldn't save settings. Try again."),
  });

  const isGuidanceDirty = data !== undefined && guidance !== (data.globalGuidance ?? "");
  const isPersonaDirty = data !== undefined && persona !== (data.persona ?? "");

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden">
      <div className="p-6 border-b border-border bg-card shrink-0">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Global agent configuration — applies to every thread.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto space-y-8">

          {/* Bot Persona */}
          <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <User className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <h2 className="font-semibold text-lg">Bot persona</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Defines who the bot is — voice, tone, and behavioral principles.
                    Injected into every system prompt before operational guidance.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2 mb-4 p-3 bg-muted/50 rounded-lg border border-border/60">
              <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                Replace <code className="font-mono bg-muted px-1 rounded text-[11px]">[BOT NAME]</code> with
                your bot's name throughout. This block sits between the functional
                instructions and ops guidance in every prompt — the bot's personality is
                established before any corrections layer on. Changes take effect on the
                next agent turn.
              </p>
            </div>

            {isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : isError ? (
              <ErrorState description="Couldn't load settings." onRetry={() => refetch()} />
            ) : (
              <Textarea
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                placeholder="Describe who the bot is, how it texts, and how it should handle edge cases."
                rows={16}
                className="resize-y font-mono text-sm"
              />
            )}

            <div className="flex items-center justify-between mt-4 pt-4 border-t border-border/50">
              <span className="text-xs text-muted-foreground">
                {persona.length.toLocaleString()} characters
                {isPersonaDirty && <span className="text-amber-600 ml-2">· Unsaved changes</span>}
              </span>
              <Button
                onClick={() => mutation.mutate({ persona })}
                disabled={mutation.isPending || !isPersonaDirty || isLoading || isError}
              >
                <Save className="h-4 w-4 mr-2" />
                {mutation.isPending ? "Saving…" : "Save persona"}
              </Button>
            </div>
          </div>

          {/* Global Guidance */}
          <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="font-semibold text-lg">Global agent guidance</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Cross-cutting corrections that apply to every thread, injected after the
                  persona block. Use for real-time behavioral fixes, not identity.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2 mb-4 p-3 bg-muted/50 rounded-lg border border-border/60">
              <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                Examples: "Always confirm dietary restrictions before suggesting a booking."
                or "When a group is making a decision, always prompt for a specific date before moving to venue selection."
                Changes take effect on the next agent turn — no restart needed.
              </p>
            </div>

            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : isError ? (
              <ErrorState description="Couldn't load settings." onRetry={() => refetch()} />
            ) : (
              <Textarea
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                placeholder="Enter global guidance for the agent — or leave blank to use default behavior."
                rows={8}
                className="resize-none font-mono text-sm"
              />
            )}

            <div className="flex items-center justify-between mt-4 pt-4 border-t border-border/50">
              <span className="text-xs text-muted-foreground">
                {guidance.length} characters
                {isGuidanceDirty && <span className="text-amber-600 ml-2">· Unsaved changes</span>}
              </span>
              <Button
                onClick={() => mutation.mutate({ globalGuidance: guidance })}
                disabled={mutation.isPending || !isGuidanceDirty || isLoading || isError}
              >
                <Save className="h-4 w-4 mr-2" />
                {mutation.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
