import React, { useState } from "react";
import { useListBookings, useApproveBooking, useRejectBooking, getListBookingsQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Check, X, Clock, CalendarClock, Building2, MapPin, Search, Calendar, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("pending");

  const { data: pendingBookings, isLoading: isPendingLoading } = useListBookings({ status: 'pending_approval' });
  const { data: historyBookings, isLoading: isHistoryLoading } = useListBookings(); // Can filter client side for others

  const approveBooking = useApproveBooking();
  const rejectBooking = useRejectBooking();

  const handleApprove = (id: number) => {
    approveBooking.mutate({ id }, {
      onSuccess: () => {
        toast.success("Booking approved successfully");
        queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
      },
      onError: () => toast.error("Failed to approve booking")
    });
  };

  const handleReject = (id: number) => {
    rejectBooking.mutate({ id }, {
      onSuccess: () => {
        toast.success("Booking rejected");
        queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
      },
      onError: () => toast.error("Failed to reject booking")
    });
  };

  const historical = historyBookings?.filter(b => b.status === 'confirmed' || b.status === 'rejected') || [];

  const BookingCard = ({ booking, isPending }: { booking: any, isPending: boolean }) => {
    return (
      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow group flex flex-col md:flex-row">
        {/* Left Status Bar */}
        <div className={`w-2 md:w-3 shrink-0 ${
          booking.status === 'pending_approval' ? 'bg-secondary' :
          booking.status === 'confirmed' ? 'bg-primary' :
          'bg-destructive/80'
        }`} />
        
        <div className="p-5 md:p-6 flex-1 flex flex-col md:flex-row gap-6">
          <div className="flex-1 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="bg-background text-xs font-mono">ID: {booking.id}</Badge>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {format(new Date(booking.createdAt), "MMM d, h:mm a")}
                  </span>
                </div>
                <h3 className="text-xl font-bold text-foreground">{booking.title}</h3>
                <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                  <User className="h-4 w-4" /> 
                  Requester ID: {booking.createdByUserId || 'Unknown'} 
                  <ChevronRight className="h-3 w-3 opacity-50" /> 
                  Approver: {booking.approverPhoneNumber || 'Auto'}
                </div>
              </div>
              
              {!isPending && (
                <Badge className={
                  booking.status === 'confirmed' 
                    ? "bg-primary/10 text-primary hover:bg-primary/20 border-none px-3 py-1 text-xs" 
                    : "bg-destructive/10 text-destructive hover:bg-destructive/20 border-none px-3 py-1 text-xs"
                }>
                  {booking.status.toUpperCase()}
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-muted/30 p-4 rounded-xl border border-border/50">
              {Object.entries(booking.details).map(([key, value]) => {
                let displayValue = String(value);
                if (typeof value === 'object') displayValue = JSON.stringify(value);
                
                let Icon = Calendar;
                if (key.toLowerCase().includes('location') || key.toLowerCase().includes('address')) Icon = MapPin;
                if (key.toLowerCase().includes('time') || key.toLowerCase().includes('date')) Icon = CalendarClock;
                if (key.toLowerCase().includes('restaurant') || key.toLowerCase().includes('place')) Icon = Building2;

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
            
            {(booking.provider || booking.providerBookingId) && (
              <div className="text-xs font-mono text-muted-foreground bg-card border border-border px-3 py-2 rounded-lg inline-block">
                Provider: {booking.provider || 'N/A'} | Ref: {booking.providerBookingId || 'N/A'}
              </div>
            )}
          </div>

          {/* Actions - Only visible if pending */}
          {isPending && (
            <div className="flex md:flex-col gap-3 justify-center md:border-l md:border-border md:pl-6 md:min-w-[140px]">
              <Button 
                onClick={() => handleApprove(booking.id)}
                className="flex-1 md:flex-none w-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm shadow-primary/20 h-12"
                disabled={approveBooking.isPending || rejectBooking.isPending}
              >
                <Check className="h-5 w-5 mr-2" />
                Approve
              </Button>
              <Button 
                onClick={() => handleReject(booking.id)}
                variant="outline"
                className="flex-1 md:flex-none w-full border-destructive/20 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors h-12"
                disabled={approveBooking.isPending || rejectBooking.isPending}
              >
                <X className="h-5 w-5 mr-2" />
                Reject
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  };
  
  // Custom User icon locally to avoid lucide import conflict above
  const User = ({ className }: { className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
  )

  return (
    <div className="h-[100dvh] flex flex-col bg-background overflow-hidden">
      <div className="px-8 py-6 border-b border-border bg-card shrink-0 shadow-sm z-10 relative">
        <h1 className="text-2xl font-bold text-foreground">Booking Approvals</h1>
        <p className="text-sm text-muted-foreground mt-1">Review and manage concierge bookings that require human intervention.</p>
      </div>

      <div className="flex-1 p-8 overflow-hidden flex flex-col max-w-6xl mx-auto w-full">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="grid w-full max-w-[400px] grid-cols-2 mb-6 bg-muted/50 p-1">
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
                <div className="space-y-4">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="bg-card border border-border rounded-2xl h-48 animate-pulse" />
                  ))}
                </div>
              ) : pendingBookings?.length === 0 ? (
                <div className="h-full min-h-[400px] flex items-center justify-center">
                  <Empty>
                    <EmptyMedia variant="icon">
                      <Check />
                    </EmptyMedia>
                    <EmptyHeader>
                      <EmptyTitle>All caught up!</EmptyTitle>
                      <EmptyDescription>There are no bookings pending approval at this time.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </div>
              ) : (
                <div className="space-y-4 pb-8">
                  {pendingBookings?.map(booking => (
                    <BookingCard key={booking.id} booking={booking} isPending={true} />
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="history" className="flex-1 overflow-hidden flex flex-col m-0 outline-none">
            <ScrollArea className="flex-1 pr-4 -mr-4">
              {isHistoryLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="bg-card border border-border rounded-2xl h-40 animate-pulse" />
                  ))}
                </div>
              ) : historical.length === 0 ? (
                <div className="h-full min-h-[400px] flex items-center justify-center">
                  <Empty>
                    <EmptyMedia variant="icon">
                      <Clock />
                    </EmptyMedia>
                    <EmptyHeader>
                      <EmptyTitle>No history found</EmptyTitle>
                      <EmptyDescription>There are no past booking decisions to display.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </div>
              ) : (
                <div className="space-y-4 pb-8">
                  {historical.map(booking => (
                    <BookingCard key={booking.id} booking={booking} isPending={false} />
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
