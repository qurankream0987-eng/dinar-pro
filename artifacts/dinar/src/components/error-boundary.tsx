import { buttonClass } from "@/ui/Button";
import {
  Component,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';

export interface ErrorFallbackProps {
  error: Error;
  resetError: () => void;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  FallbackComponent?: ComponentType<ErrorFallbackProps>;
  /** Changing this clears a caught error. Pass the route to recover on navigation. */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

function DefaultFallback({ error, resetError }: ErrorFallbackProps) {
  return (
    <div dir="rtl" role="alert" className="flex min-h-[60vh] w-full items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive-soft text-2xl font-bold text-destructive">
          !
        </div>
        <h1 className="text-xl font-bold text-foreground">حدث خطأ غير متوقع</h1>
        <p className="mt-2 text-base text-muted-foreground">
          تعذّر عرض هذا الجزء. بياناتك وسلتك محفوظة — حاول مرة أخرى.
        </p>
        {/* Dev only: messages can carry API responses and other internals. */}
        {import.meta.env.DEV ? (
          <pre dir="ltr" className="mt-4 overflow-x-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
            {error.message || String(error)}
          </pre>
        ) : null}
        <div className="mt-5 flex justify-center gap-2">
          <button
            type="button"
            onClick={resetError}
            className={buttonClass("primary")}
          >
            إعادة المحاولة
          </button>
          <a href={import.meta.env.BASE_URL} className={buttonClass("secondary")}>
            الرئيسية
          </a>
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: toError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      'ErrorBoundary caught an error:',
      toError(error),
      info.componentStack,
    );
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (
      this.state.error !== null &&
      prevProps.resetKey !== this.props.resetKey
    ) {
      this.resetError();
    }
  }

  resetError = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    const Fallback = this.props.FallbackComponent ?? DefaultFallback;
    return <Fallback error={error} resetError={this.resetError} />;
  }
}
