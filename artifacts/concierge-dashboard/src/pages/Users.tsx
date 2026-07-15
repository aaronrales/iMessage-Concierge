import React, { useState } from "react";
import { useListUsers, useSendOnboardingNudge, getListUsersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { Search, User, CreditCard, Apple, FileText, CheckCircle2, Clock, CircleDashed, BellRing, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

export function UsersPage() {
  const { data: users, isLoading } = useListUsers();
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false);

  const queryClient = useQueryClient();
  const nudgeMutation = useSendOnboardingNudge();

  const isStalled = (user: NonNullable<typeof users>[number]) =>
    user.onboardingStatus !== "completed" && Boolean(user.onboardingDisclosedAt);

  const stalledCount = users?.filter(isStalled).length ?? 0;

  const searchedUsers = users?.filter(user => 
    user.displayName?.toLowerCase().includes(search.toLowerCase()) || 
    user.phoneNumber.includes(search)
  ) || [];

  const filteredUsers = (needsAttentionOnly ? searchedUsers.filter(isStalled) : searchedUsers)
    .slice()
    .sort((a, b) => {
      if (needsAttentionOnly) {
        return new Date(a.onboardingDisclosedAt!).getTime() - new Date(b.onboardingDisclosedAt!).getTime();
      }
      return 0;
    });

  const selectedUser = users?.find(u => u.id === selectedUserId) || (filteredUsers.length > 0 ? filteredUsers[0] : null);

  const handleSendNudge = (userId: number) => {
    nudgeMutation.mutate(
      { id: userId },
      {
        onSuccess: () => {
          toast.success("Onboarding nudge sent.");
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        },
        onError: () => {
          toast.error("Couldn't send the nudge. Try again in a moment.");
        },
      },
    );
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="h-4 w-4 text-primary" />;
      case 'in_progress': return <Clock className="h-4 w-4 text-secondary" />;
      case 'not_started': default: return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusText = (status: string) => {
    return status.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      {/* Master View */}
      <div className="w-80 border-r border-border bg-card/50 flex flex-col shrink-0">
        <div className="p-4 border-b border-border bg-card">
          <h1 className="text-xl font-bold mb-4">Users</h1>
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or number..."
              className="pl-9 bg-background"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            onClick={() => setNeedsAttentionOnly((v) => !v)}
            className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
              needsAttentionOnly
                ? "bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-400"
                : "bg-background border-border text-muted-foreground hover-elevate"
            }`}
          >
            <span className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              Needs attention
            </span>
            <Badge variant="secondary" className="border-none">{stalledCount}</Badge>
          </button>
        </div>
        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="flex items-center gap-3 p-2">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              No users found.
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {filteredUsers.map(user => (
                <button
                  key={user.id}
                  onClick={() => setSelectedUserId(user.id)}
                  className={`w-full flex items-start gap-3 p-3 rounded-xl transition-all duration-200 text-left hover-elevate ${
                    (selectedUser?.id === user.id) 
                      ? "bg-primary text-primary-foreground shadow-md shadow-primary/20" 
                      : "hover:bg-accent/50 text-foreground"
                  }`}
                >
                  <div className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${
                    selectedUser?.id === user.id ? "bg-primary-foreground/20 text-primary-foreground" : "bg-primary/10 text-primary"
                  }`}>
                    <User className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <div className="font-semibold truncate flex items-center gap-1.5">
                      {user.displayName || "Unknown User"}
                      {isStalled(user) && (
                        <span
                          title={`Stalled since ${format(new Date(user.onboardingDisclosedAt!), "MMM d")}`}
                          className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                            selectedUser?.id === user.id ? "bg-primary-foreground" : "bg-amber-500"
                          }`}
                        />
                      )}
                    </div>
                    <div className={`text-sm truncate ${selectedUser?.id === user.id ? "text-primary-foreground/80" : "text-muted-foreground"}`}>
                      {user.phoneNumber}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Detail View */}
      <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
        {selectedUser ? (
          <ScrollArea className="flex-1">
            <div className="max-w-4xl mx-auto p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div className="flex items-start justify-between mb-8">
                <div>
                  <h2 className="text-3xl font-bold tracking-tight mb-2">{selectedUser.displayName || "Unknown User"}</h2>
                  <div className="text-muted-foreground font-mono text-sm mb-4">{selectedUser.phoneNumber}</div>
                  
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-foreground">Onboarding:</span>
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted/50 border border-border">
                      {getStatusIcon(selectedUser.onboardingStatus)}
                      <span className="font-medium">{getStatusText(selectedUser.onboardingStatus)}</span>
                    </div>
                    {isStalled(selectedUser) && (
                      <span className="text-amber-700 dark:text-amber-400 text-xs font-medium">
                        Stalled {formatDistanceToNow(new Date(selectedUser.onboardingDisclosedAt!), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right text-sm text-muted-foreground space-y-2">
                  <div>Joined {format(new Date(selectedUser.createdAt), "MMM d, yyyy")}</div>
                  <div>ID: #{selectedUser.id}</div>
                  {selectedUser.onboardingStatus !== "completed" && selectedUser.onboardingDisclosedAt && (
                    <div className="flex flex-col items-end gap-1 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={nudgeMutation.isPending}
                        onClick={() => handleSendNudge(selectedUser.id)}
                        data-testid="button-send-nudge"
                      >
                        <BellRing className="h-3.5 w-3.5 mr-1.5" />
                        {selectedUser.onboardingNudgedAt ? "Send nudge again" : "Send nudge now"}
                      </Button>
                      {selectedUser.onboardingNudgedAt && (
                        <span className="text-xs text-muted-foreground">
                          Last nudged {formatDistanceToNow(new Date(selectedUser.onboardingNudgedAt), { addSuffix: true })}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {selectedUser.profile ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Preferences & Logistics */}
                  <div className="space-y-6">
                    <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
                      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <CreditCard className="h-5 w-5 text-primary" />
                        Logistics
                      </h3>
                      <div className="space-y-4">
                        <div>
                          <div className="text-sm font-medium text-muted-foreground mb-1">Budget</div>
                          <div className="font-medium">{selectedUser.profile.budget || "Not specified"}</div>
                        </div>
                        <Separator />
                        <div>
                          <div className="text-sm font-medium text-muted-foreground mb-1">Dietary Needs</div>
                          <div className="font-medium">{selectedUser.profile.dietaryNeeds || "None specified"}</div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
                      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <Apple className="h-5 w-5 text-primary" />
                        Preferences
                      </h3>
                      {selectedUser.profile.preferences.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {selectedUser.profile.preferences.map((pref, i) => (
                            <Badge key={i} variant="secondary" className="px-2.5 py-1 text-sm bg-secondary/15 text-secondary-foreground hover:bg-secondary/25 border-none">
                              {pref}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <div className="text-sm text-muted-foreground">No preferences recorded.</div>
                      )}
                    </div>
                  </div>

                  {/* History & Notes */}
                  <div className="space-y-6">
                    <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
                      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <FileText className="h-5 w-5 text-primary" />
                        Past Choices
                      </h3>
                      {selectedUser.profile.pastChoices.length > 0 ? (
                        <ul className="space-y-3">
                          {selectedUser.profile.pastChoices.map((choice, i) => (
                            <li key={i} className="flex gap-3 text-sm">
                              <div className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary/50 shrink-0" />
                              <span className="leading-relaxed">{choice}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-sm text-muted-foreground">No past choices recorded.</div>
                      )}
                    </div>

                    {selectedUser.profile.notes && (
                      <div className="bg-primary/5 border border-primary/10 rounded-xl p-5 shadow-sm">
                        <h3 className="text-lg font-semibold mb-3 text-primary">Concierge Notes</h3>
                        <p className="text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap">
                          {selectedUser.profile.notes}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="bg-card border border-border border-dashed rounded-xl p-12 text-center">
                  <div className="mx-auto h-12 w-12 bg-muted rounded-full flex items-center justify-center mb-4">
                    <User className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">No Profile Data</h3>
                  <p className="text-muted-foreground text-sm max-w-md mx-auto">
                    This user hasn't completed onboarding or hasn't provided enough information to build a profile yet.
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <Empty>
              <EmptyMedia variant="icon">
                <User />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No user selected</EmptyTitle>
                <EmptyDescription>Select a user from the list to view their profile.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </div>
    </div>
  );
}
