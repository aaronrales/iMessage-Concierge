import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry: () => void;
}

/** Shared "fetch failed" state with a retry action, used anywhere a list/detail query can fail. */
export function ErrorState({
  title = "Couldn't load this",
  description = "Something went wrong talking to the server.",
  onRetry,
}: ErrorStateProps) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <AlertTriangle className="text-destructive" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <Button size="sm" variant="outline" onClick={onRetry} data-testid="button-retry">
        Try again
      </Button>
    </Empty>
  );
}
