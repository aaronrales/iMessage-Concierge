import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Save,
  Info,
  User,
  ShieldCheck,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronUp,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ErrorState } from "@/components/ErrorState";

// ─── Agent Config (persona + globalGuidance) ────────────────────────────────

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

// ─── Agent Rules ─────────────────────────────────────────────────────────────

interface AgentRule {
  id: number;
  name: string;
  category: string;
  content: string;
  enabled: boolean;
  sortOrder: number;
  isBuiltIn: boolean;
  updatedAt: string;
}

async function fetchRules(): Promise<AgentRule[]> {
  const res = await fetch("/api/agent-rules");
  if (!res.ok) throw new Error("Failed to load rules");
  return res.json() as Promise<AgentRule[]>;
}

async function updateRule(id: number, patch: Partial<AgentRule>): Promise<AgentRule> {
  const res = await fetch(`/api/agent-rules/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update rule");
  return res.json() as Promise<AgentRule>;
}

async function createRule(rule: { name: string; category: string; content: string }): Promise<AgentRule> {
  const res = await fetch("/api/agent-rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rule),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "Failed to create rule");
  }
  return res.json() as Promise<AgentRule>;
}

async function deleteRule(id: number): Promise<void> {
  const res = await fetch(`/api/agent-rules/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete rule");
}

// ─── Category helpers ─────────────────────────────────────────────────────────

const CATEGORIES = ["behavior", "project", "tool"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABELS: Record<string, string> = {
  behavior: "Behavior",
  project: "Project",
  tool: "Tool",
};

const CATEGORY_COLORS: Record<string, string> = {
  behavior: "bg-blue-100 text-blue-700 border-blue-200",
  project: "bg-purple-100 text-purple-700 border-purple-200",
  tool: "bg-amber-100 text-amber-700 border-amber-200",
};

// ─── RuleRow ──────────────────────────────────────────────────────────────────

function RuleRow({ rule, onSaved, onDeleted }: {
  rule: AgentRule;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(rule.content);
  const [nameDraft, setNameDraft] = useState(rule.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isDirty = draft !== rule.content || nameDraft !== rule.name;

  const saveMutation = useMutation({
    mutationFn: () => updateRule(rule.id, { content: draft, name: nameDraft }),
    onSuccess: () => { toast.success("Rule saved."); onSaved(); },
    onError: () => toast.error("Couldn't save rule."),
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => updateRule(rule.id, { enabled }),
    onSuccess: () => onSaved(),
    onError: () => toast.error("Couldn't update rule."),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteRule(rule.id),
    onSuccess: () => { toast.success("Rule deleted."); onDeleted(); },
    onError: () => toast.error("Couldn't delete rule."),
  });

  return (
    <div className={`border border-border rounded-lg overflow-hidden ${!rule.enabled ? "opacity-60" : ""}`}>
      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-3 bg-card">
        <Switch
          checked={rule.enabled}
          onCheckedChange={(v) => toggleMutation.mutate(v)}
          disabled={toggleMutation.isPending}
          aria-label={`Toggle ${rule.name}`}
        />
        <button
          className="flex-1 flex items-center gap-2 text-left"
          onClick={() => setExpanded((e) => !e)}
        >
          <span className="font-medium text-sm">{rule.name}</span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${CATEGORY_COLORS[rule.category] ?? "bg-muted text-muted-foreground"}`}>
            {CATEGORY_LABELS[rule.category] ?? rule.category}
          </span>
          {rule.isBuiltIn && (
            <span className="flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground">
              <Lock className="h-2.5 w-2.5" />
              Built-in
            </span>
          )}
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {!rule.isBuiltIn && !confirmDelete && (
            <button
              onClick={() => setConfirmDelete(true)}
              className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              title="Delete rule"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          {confirmDelete && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-destructive font-medium">Delete?</span>
              <button
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                className="text-destructive font-semibold hover:underline"
              >
                Yes
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-muted-foreground hover:underline">
                No
              </button>
            </div>
          )}
          <button
            onClick={() => setExpanded((e) => !e)}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
            title={expanded ? "Collapse" : "Expand to edit"}
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Expanded editor */}
      {expanded && (
        <div className="border-t border-border px-4 py-4 bg-muted/20 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Rule name</label>
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              className="w-full text-sm border border-border rounded-md px-3 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              disabled={rule.isBuiltIn && rule.name === nameDraft ? false : false}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Rule content</label>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="resize-y font-mono text-xs"
            />
          </div>
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-muted-foreground">{draft.length.toLocaleString()} characters</span>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !isDirty}
            >
              <Save className="h-3.5 w-3.5 mr-1.5" />
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AddRuleForm ──────────────────────────────────────────────────────────────

function AddRuleForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("behavior");
  const [content, setContent] = useState("");

  const mutation = useMutation({
    mutationFn: () => createRule({ name, category, content }),
    onSuccess: () => { toast.success("Rule created."); onCreated(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't create rule."),
  });

  return (
    <div className="border border-primary/30 rounded-lg p-4 bg-primary/5 space-y-3">
      <p className="text-sm font-semibold">New rule</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Always offer alternatives"
            className="w-full text-sm border border-border rounded-md px-3 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            className="w-full text-sm border border-border rounded-md px-3 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Content</label>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write the rule as if speaking directly to the agent…"
          rows={4}
          className="resize-y font-mono text-xs"
        />
      </div>
      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !name.trim() || !content.trim()}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          {mutation.isPending ? "Creating…" : "Create rule"}
        </Button>
      </div>
    </div>
  );
}

// ─── RulesSection ─────────────────────────────────────────────────────────────

function RulesSection() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const { data: rules, isLoading, isError, refetch } = useQuery({
    queryKey: ["agent-rules"],
    queryFn: fetchRules,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["agent-rules"] });

  const grouped = React.useMemo(() => {
    if (!rules) return {} as Record<string, AgentRule[]>;
    return rules.reduce<Record<string, AgentRule[]>>((acc, r) => {
      (acc[r.category] ??= []).push(r);
      return acc;
    }, {});
  }, [rules]);

  const categoryOrder = ["behavior", "project", "tool"];
  const sortedCategories = [
    ...categoryOrder.filter((c) => grouped[c]?.length),
    ...Object.keys(grouped).filter((c) => !categoryOrder.includes(c) && grouped[c]?.length),
  ];

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <ShieldCheck className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold text-lg">Agent rules</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Behavioral policies injected into every system prompt. Toggle, edit, or add rules
              without a code deploy — changes apply within 30 seconds.
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={adding}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add rule
        </Button>
      </div>

      <div className="flex items-start gap-2 mb-5 p-3 bg-muted/50 rounded-lg border border-border/60">
        <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Built-in rules (marked with a lock icon) can be edited or disabled but not deleted — they are the
          agent's core behavioral policies. User-added rules can be fully managed.
        </p>
      </div>

      {adding && (
        <div className="mb-4">
          <AddRuleForm
            onCreated={() => { setAdding(false); invalidate(); }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : isError ? (
        <ErrorState description="Couldn't load rules." onRetry={() => refetch()} />
      ) : sortedCategories.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">No rules yet. Add one above.</p>
      ) : (
        <div className="space-y-6">
          {sortedCategories.map((cat) => (
            <div key={cat}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                {CATEGORY_LABELS[cat] ?? cat}
              </h3>
              <div className="space-y-2">
                {(grouped[cat] ?? []).map((rule) => (
                  <RuleRow key={rule.id} rule={rule} onSaved={invalidate} onDeleted={invalidate} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SettingsPage ─────────────────────────────────────────────────────────────

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

          {/* Agent Rules */}
          <RulesSection />

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
