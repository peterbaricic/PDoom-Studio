// LoadBoundary.tsx: catches what goes wrong in a lazily loaded part of the app (its chunk failing to load, say, after
// the studio was rebuilt, or anything it throws) so it shows in place, with Retry, and never takes the rest of the
// page down with it. React.lazy keeps a failed import failed for good, so `onRetry` has to swap in a fresh lazy
// component before the boundary renders its children again.
import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface LoadBoundaryProps {
  // What failed, for the message: "Couldn't load <what>: …".
  what: string;
  onRetry: () => void;
  children: ReactNode;
  // For the error's box (its margins, say).
  className?: string;
}

export class LoadBoundary extends Component<LoadBoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className={cn('bg-card flex flex-col items-start gap-2 rounded-md border p-3 text-sm', this.props.className)}>
        <span>{`Couldn't load ${this.props.what}: ${this.state.error.message}`}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            this.props.onRetry();
            this.setState({ error: null });
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
}
