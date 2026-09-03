import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { failed: boolean };

/**
 * The last line of defence against a render-time throw. React's default for an
 * uncaught error is to unmount the entire tree — the user is left staring at a
 * blank page with no reload prompt and no hint that anything went wrong, which
 * is indistinguishable from the app simply being broken.
 *
 * This is deliberately not a substitute for the shape checks in `api/http.ts`:
 * those stop a malformed response from ever reaching state, and this catches
 * what they didn't anticipate. Reloading is the only offered recovery because
 * whatever state produced the throw is exactly the state we can't trust to
 * re-render.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Nothing ships these anywhere yet, but without the log the only trace of
    // the failure is the screen below, which says nothing a developer can use.
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-ground px-6 text-center">
        <p className="text-sm text-white">Something broke on this screen.</p>
        <p className="text-xs text-neutral-400">
          Reloading usually fixes it. Nothing you shared has been lost.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-2 rounded-full bg-white px-6 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 active:opacity-70"
        >
          Reload
        </button>
      </div>
    );
  }
}
