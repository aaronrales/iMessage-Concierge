import React, { useState } from "react";
import { useListBookings, useApproveBooking, useRejectBooking, getListBookingsQueryKey, useGetActivationSummary } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Check, X, Clock, CalendarClock, Building2, MapPin, ChevronRight,
  AlertTriangle, Ban, RefreshCw, CheckSquare, TrendingUp, Users, MessageCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { ErrorState } from "@/components/ErrorState";
import { useSearch } from "wouter";

// ── Activation funnel card ─────────────────────────────────────────────────

function ActivationCard() {
  const { data, isLoading } = useGetActivationSummary({ windowDays: 7 });

  return (
    <div className="rounded-xl border border-border bg-card p-4 mb-6 shrink-0">
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Activation — last 7 days</h2>
      </div>
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />
          ))}
        </div>
      ) : !data ? (
        <p className="text-xs text-muted-foreground">Could not load activation data.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg bg-muted/40 px-3 py-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <Users className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Total</span>
            </div>
            <p className="text-2xl font-bold leading-none">{data.totalInvites}</p>
          </div>

          <div className="rounded-lg bg-muted/40 px-3 py-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <MessageCircle className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Cold DM</span>
            </div>
            <p className="text-2xl font-bold leading-none">{data.bySource.coldDm}</p>
          </div>

          <div className="rounded-lg bg-muted/40 px-3 py-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <Users className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Group Add</span>
            </div>
            <p className="text-2xl font-bold leading-none">{data.bySource.groupAdd}</p>
          </div>

          <div className="rounded-lg bg-muted/40 px-3 py-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <TrendingUp className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Converted</span>
            </div>
            <p className="text-2xl font-bold leading-none">
              {data.conversionRate !== null ? `${data.conversionRate}%` : "—"}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {data.onboardingCompleted} of {data.totalInvites} onboarded
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Delivery types ─────────────────────────────────────────────────────────

interface DeliveryLogItem {
  id: number;
  messageHandle: string | null;
  recipientPhone: string | null;
  status: string;
  errorCode: string | null;
  threadId: number | null;
  createdAt: string;
}

async function fetchDeliveryLog(): Promise<{ items: DeliveryLogItem[] }> {
  const res = await fetch("/api/delivery-log");
  if (!res.ok) throw new Error("Failed to fetch delivery log");
  return res.json() as Promise<{ items: DeliveryLogItem[] }>;
}

// ── Shared UI helpers ──────────────────────────────────────────────────────

function DeliveryStatusBadge({ status }: { status: string }) {
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

// ── Bookings (approvals) ───────────────────────────────────────────────────

const UserIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
  </svg>
);

function BookingCard({ booking, isPending }: { booking: Record<string, unknown>; isPending: boolean }) {
  const queryClient = useQueryClient();
  const approveBooking = useApproveBooking();
  const rejectBooking = useRejectBooking();

  const handleApprove = () => {
    approveBooking.mutate({ id: booking.id as number }, {
      onSuccess: () => {
        toast.success("Booking approved successfully");
        queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
      },
      onError: () => toast.error("Failed to approve booking"),
    });
  };

  const handleReject = () => {
    rejectBooking.mutate({ id: booking.id as number }, {
      onSuccess: () => {
        toast.success("Booking rejected");
        queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
      },
      onError: () => toast.error("Failed to reject booking"),
    });
  };

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow flex flex-col md:flex-row">
      <div className={`w-2 md:w-3 shrink-0 ${
        booking.status === "pending_approval" ? "bg-secondary" :
        booking.status === "confirmed" ? "bg-primary" : "bg-destructive/80"
      }`} />
      <div className="p-5 md:p-6 flex-1 flex flex-col md:flex-row gap-6">
        <div className="flex-1 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className="bg-background text-xs font-mono">ID: {String(booking.id)}</Badge>
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {format(new Date(booking.createdAt as string), "MMM d, h:mm a")}
                </span>
              </div>
              <h3 className="text-xl font-bold text-foreground">{String(booking.title)}</h3>
              <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                <UserIcon className="h-4 w-4" />
                Requester ID: {String(booking.createdByUserId ?? "Unknown")}
                <ChevronRight className="h-3 w-3 opacity-50" />
                Approver: {String((booking.approverPhoneNumber as string) ?? "Auto")}
              </div>
            </div>
            {!isPending && (
              <Badge className={
                booking.status === "confirmed"
                  ? "bg-primary/10 text-primary border-none px-3 py-1 text-xs"
                  : "bg-destructive/10 text-destructive border-none px-3 py-1 text-xs"
              }>
                {String(booking.status).toUpperCase()}
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-muted/30 p-4 rounded-xl border border-border/50">
            {Object.entries(booking.details as Record<string, unknown>).map(([key, value]) => {
              let displayValue = typeof value === "object" ? JSON.stringify(value) : String(value);
              let Icon: React.ElementType = MapPin;
              if (key.toLowerCase().includes("time") || key.toLowerCase().includes("date")) Icon = CalendarClock;
              if (key.toLowerCase().includes("restaurant") || key.toLowerCase().includes("place")) Icon = Building2;
              return (
                <div key={key} className="flex items-start gap-2.5 text-sm">
                  <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div>
                    <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-0.5">{key}</div>
                    <div className="font-medium text-foreground">{displayValue}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {!!(booking.provider || booking.providerBookingId) && (
            <div className="text-xs font-mono text-muted-foreground bg-card border border-border px-3 py-2 rounded-lg inline-block">
              Provider: {String(booking.provider ?? "N/A")} | Ref: {String(booking.providerBookingId ?? "N/A")}
            </div>
          )}
        </div>

        {isPending && (
          <div className="flex md:flex-col gap-3 justify-center md:border-l md:border-border md:pl-6 md:min-w-[140px]">
            <Button
              onClick={handleApprove}
              className="flex-1 md:flex-none w-full bg-primary hover:bg-primary/90 h-12"
              disabled={approveBooking.isPending || rejectBooking.isPending}
            >
              <Check className="h-5 w-5 mr-2" /> Approve
            </Button>
            <Button
              onClick={handleReject}
              variant="outline"
              className="flex-1 md:flex-none w-full border-destructive/20 text-destructive hover:bg-destructive hover:text-destructive-foreground h-12"
              disabled={approveBooking.isPending || rejectBooking.isPending}
            >
              <X className="h-5 w-5 mr-2" /> Reject
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function BookingsTab() {
  const { data: pendingBookings, isLoading: isPendingLoading, isError: isPendingError, refetch: refetchPending } = useListBookings({ status: "pending_approval" });
  const { data: historyBookings, isLoading: isHistoryLoading, isError: isHistoryError, refetch: refetchHistory } = useListBookings();
  const [activeSubTab, setActiveSubTab] = useState("pending");

  const historical = historyBookings?.filter((b) => b.status === "confirmed" || b.status === "rejected") ?? [];

  return (
    <Tabs value={activeSubTab} onValueChange={setActiveSubTab} className="flex-1 flex flex-col overflow-hidden">
      <TabsList className="grid w-full max-w-[360px] grid-cols-2 mb-6 bg-muted/50 p-1 shrink-0">
        <TabsTrigger value="pending" className="data-[state=active]:bg-card data-[state=active]:shadow-sm rounded-md py-2">
          Action Required
          {pendingBookings && pendingBookings.length > 0 && (
            <span className="ml-2 bg-secondary text-secondary-foreground text-[10px] font-bold px-2 py-0.5 rounded-full">
              {pendingBookings.length}
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="history" className="data-[state=active]:bg-card data-[state=active]:shadow-sm rounded-md py-2">
          Decision History
        </TabsTrigger>
      </TabsList>

      <TabsContent value="pending" className="flex-1 overflow-hidden flex flex-col m-0 outline-none">
        <ScrollArea className="flex-1 pr-4 -mr-4">
          {isPendingLoading ? (
            <div className="space-y-4">{[1, 2, 3].map((i) => <div key={i} className="bg-card border border-border rounded-2xl h-48 animate-pulse" />)}</div>
          ) : isPendingError ? (
            <div className="min-h-[400px] flex items-center justify-center">
              <ErrorState description="Couldn't load pending approvals." onRetry={() => refetchPending()} />
            </div>
          ) : pendingBookings?.length === 0 ? (
            <div className="min-h-[400px] flex items-center justify-center">
              <Empty>
                <EmptyMedia variant="icon"><CheckSquare /></EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>All caught up!</EmptyTitle>
                  <EmptyDescription>No bookings pending approval.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <div className="space-y-4 pb-8">
              {pendingBookings?.map((booking) => (
                <BookingCard key={booking.id} booking={booking as unknown as Record<string, unknown>} isPending={true} />
              ))}
            </div>
          )}
        </ScrollArea>
      </TabsContent>

      <TabsContent value="history" className="flex-1 overflow-hidden flex flex-col m-0 outline-none">
        <ScrollArea className="flex-1 pr-4 -mr-4">
          {isHistoryLoading ? (
            <div className="space-y-4">{[1, 2, 3].map((i) => <div key={i} className="bg-card border border-border rounded-2xl h-40 animate-pulse" />)}</div>
          ) : isHistoryError ? (
            <div className="min-h-[400px] flex items-center justify-center">
              <ErrorState description="Couldn't load booking history." onRetry={() => refetchHistory()} />
            </div>
          ) : historical.length === 0 ? (
            <div className="min-h-[400px] flex items-center justify-center">
              <Empty>
                <EmptyMedia variant="icon"><Clock /></EmptyMedia>
                <EmptyHeader><EmptyTitle>No history yet</EmptyTitle></EmptyHeader>
              </Empty>
            </div>
          ) : (
            <div className="space-y-4 pb-8">
              {historical.map((booking) => (
                <BookingCard key={booking.id} booking={booking as unknown as Record<string, unknown>} isPending={false} />
              ))}
            </div>
          )}
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
}

function DeliveryTab() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["delivery-log"],
    queryFn: fetchDeliveryLog,
    refetchInterval: 30_000,
  });

  const items = data?.items ?? [];
  const errorItems = items.filter((i) => i.status === "ERROR" || i.status === "FAILED");
  const blockedItems = items.filter((i) => i.status === "BLOCKED");

  return (
    <ScrollArea className="flex-1">
      <div className="space-y-8 pb-8">
        {/* Refresh */}
        <div className="flex justify-end">
          <button
            onClick={() => void refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Failed to load delivery log. Check server connectivity.
          </div>
        )}

        {/* Message errors */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <h2 className="text-sm font-semibold">
              Message Errors
              {errorItems.length > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">({errorItems.length} recent)</span>}
            </h2>
          </div>
          {isLoading ? (
            <div className="space-y-2">{[...Array(3)].map((_, i) => <div key={i} className="h-14 rounded-lg bg-muted/50 animate-pulse" />)}</div>
          ) : errorItems.length === 0 ? (
            <div className="rounded-lg border border-border bg-card">
              <EmptyState icon={AlertTriangle} message="No delivery errors — everything looks healthy." />
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    {["Recipient", "Status", "Error Code", "Message Handle", "Time"].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {errorItems.map((item, i) => (
                    <tr key={item.id} className={`${i < errorItems.length - 1 ? "border-b border-border/50" : ""} hover:bg-muted/20 transition-colors`}>
                      <td className="px-4 py-3 font-mono text-xs">{item.recipientPhone ?? <span className="italic text-muted-foreground">unknown</span>}</td>
                      <td className="px-4 py-3"><DeliveryStatusBadge status={item.status} /></td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{item.errorCode ?? "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground max-w-[200px] truncate">{item.messageHandle ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{format(new Date(item.createdAt), "MMM d, h:mm a")}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Blocked / opted-out */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Ban className="h-4 w-4 text-orange-500" />
            <h2 className="text-sm font-semibold">
              Blocked &amp; Opted-Out
              {blockedItems.length > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">({blockedItems.length} numbers)</span>}
            </h2>
          </div>
          {isLoading ? (
            <div className="space-y-2">{[...Array(2)].map((_, i) => <div key={i} className="h-12 rounded-lg bg-muted/50 animate-pulse" />)}</div>
          ) : blockedItems.length === 0 ? (
            <div className="rounded-lg border border-border bg-card">
              <EmptyState icon={Ban} message="No blocked or opted-out numbers." />
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    {["Phone Number", "Event", "Blocked At"].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {blockedItems.map((item, i) => (
                    <tr key={item.id} className={`${i < blockedItems.length - 1 ? "border-b border-border/50" : ""} hover:bg-muted/20 transition-colors`}>
                      <td className="px-4 py-3 font-mono text-xs">{item.recipientPhone ?? <span className="italic text-muted-foreground">unknown</span>}</td>
                      <td className="px-4 py-3"><DeliveryStatusBadge status={item.status} /></td>
                      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{format(new Date(item.createdAt), "MMM d, h:mm a")}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

// ── Main OperationsPage ────────────────────────────────────────────────────

export function OperationsPage() {
  const searchString = useSearch();
  const tabFromUrl = searchString ? new URLSearchParams(searchString).get("tab") ?? "bookings" : "bookings";
  const [activeTab, setActiveTab] = useState<string>(tabFromUrl === "delivery" ? "delivery" : "bookings");

  // Pending count badge
  const { data: pendingBookings } = useListBookings({ status: "pending_approval" });
  const pendingCount = pendingBookings?.length ?? 0;

  return (
    <div className="h-[100dvh] flex flex-col bg-background overflow-hidden">
      <div className="px-8 py-6 border-b border-border bg-card shrink-0 shadow-sm z-10 relative">
        <h1 className="text-2xl font-bold text-foreground">Operations</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Booking approvals and message delivery monitoring.
        </p>
      </div>

      <div className="flex-1 p-8 overflow-hidden flex flex-col max-w-6xl mx-auto w-full">
        <ActivationCard />
        <div className="flex items-center gap-1 border-b border-border mb-6 shrink-0">
          <button
            onClick={() => setActiveTab("bookings")}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "bookings"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <CheckSquare className="h-4 w-4" />
            Bookings
            {pendingCount > 0 && (
              <span className="bg-secondary text-secondary-foreground text-[10px] font-bold px-2 py-0.5 rounded-full">
                {pendingCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("delivery")}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "delivery"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <AlertTriangle className="h-4 w-4" />
            Delivery Issues
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col">
          {activeTab === "bookings" ? <BookingsTab /> : <DeliveryTab />}
        </div>
      </div>
    </div>
  );
}
