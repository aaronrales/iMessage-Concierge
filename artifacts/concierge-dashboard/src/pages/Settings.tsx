import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { ErrorState } from "@/components/ErrorState";

interface AgentConfig {
  globalGuidance: string;
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

  useEffect(() => {
    if (data) {
      setGuidance(data.globalGuidance ?? "");
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

  const isDirty = data !== undefined && guidance !== (data.globalGuidance ?? "");

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
          {/* Global Guidance */}
          <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="font-semibold text-lg">Global agent guidance</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  This block is prepended to every agent system prompt across all threads.
                  Use it for cross-cutting corrections that should apply everywhere.
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
                {isDirty && <span className="text-amber-600 ml-2">· Unsaved changes</span>}
              </span>
              <Button
                onClick={() => mutation.mutate({ globalGuidance: guidance })}
                disabled={mutation.isPending || !isDirty || isLoading || isError}
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
