import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Ban, Clock, RefreshCw } from "lucide-react";
import { format } from "date-fns";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DeliveryLogItem {
  id: number;
  messageHandle: string | null;
  recipientPhone: string | null;
  status: string;
  errorCode: string | null;
  threadId: number | null;
  createdAt: string;
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchDeliveryLog(): Promise<{ items: DeliveryLogItem[] }> {
  const res = await fetch("/api/delivery-log");
  if (!res.ok) throw new Error("Failed to fetch delivery log");
  return res.json() as Promise<{ items: DeliveryLogItem[] }>;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const palette: Record<string, string> = {
    ERROR: "bg-destructive/10 text-destructive border-destructive/20",
    FAILED: "bg-destructive/10 text-destructive border-destructive/20",
    BLOCKED: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  };
  const cls = palette[status] ?? "bg-muted text-muted-foreground border-border";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {status}
    </span>
  );
}

function EmptyState({ icon: Icon, message }: { icon: React.ElementType; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
      <Icon className="h-8 w-8 opacity-30" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function DeliveryPage() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["delivery-log"],
    queryFn: fetchDeliveryLog,
    refetchInterval: 30_000,
  });

  const items = data?.items ?? [];
  const errorItems = items.filter((i) => i.status === "ERROR" || i.status === "FAILED");
  const blockedItems = items.filter((i) => i.status === "BLOCKED");

  return (
    <div className="flex-1 overflow-auto p-6 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Delivery Issues</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Failed message deliveries and opt-out / line-blocked events from Sendblue.
          </p>
        </div>
        <button
          onClick={() => void refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Failed to load delivery log. Check server connectivity.
        </div>
      )}

      {/* Delivery errors */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <h2 className="text-sm font-semibold text-foreground">
            Message Errors
            {errorItems.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({errorItems.length} recent)
              </span>
            )}
          </h2>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-14 rounded-lg bg-muted/50 animate-pulse" />
            ))}
          </div>
        ) : errorItems.length === 0 ? (
          <div className="rounded-lg border border-border bg-card">
            <EmptyState icon={AlertTriangle} message="No delivery errors — everything looks healthy." />
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Recipient
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Status
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Error Code
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Message Handle
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {errorItems.map((item, i) => (
                  <tr
                    key={item.id}
                    className={`${i < errorItems.length - 1 ? "border-b border-border/50" : ""} hover:bg-muted/20 transition-colors`}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-foreground">
                      {item.recipientPhone ?? <span className="text-muted-foreground italic">unknown</span>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {item.errorCode ?? "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground max-w-[200px] truncate">
                      {item.messageHandle ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {format(new Date(item.createdAt), "MMM d, h:mm a")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Blocked / opted-out numbers */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Ban className="h-4 w-4 text-orange-500" />
          <h2 className="text-sm font-semibold text-foreground">
            Blocked &amp; Opted-Out
            {blockedItems.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({blockedItems.length} numbers)
              </span>
            )}
          </h2>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-12 rounded-lg bg-muted/50 animate-pulse" />
            ))}
          </div>
        ) : blockedItems.length === 0 ? (
          <div className="rounded-lg border border-border bg-card">
            <EmptyState icon={Ban} message="No blocked or opted-out numbers." />
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Phone Number
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Event
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Blocked At
                  </th>
                </tr>
              </thead>
              <tbody>
                {blockedItems.map((item, i) => (
                  <tr
                    key={item.id}
                    className={`${i < blockedItems.length - 1 ? "border-b border-border/50" : ""} hover:bg-muted/20 transition-colors`}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-foreground">
                      {item.recipientPhone ?? <span className="text-muted-foreground italic">unknown</span>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {format(new Date(item.createdAt), "MMM d, h:mm a")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
