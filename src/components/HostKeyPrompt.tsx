import type { HostKeyPending } from "../types";
import { confirmHostKey, rejectHostKey } from "../api";

interface Props {
  request: HostKeyPending;
  onResolved: (requestId: string) => void;
}

export function HostKeyPrompt({ request, onResolved }: Props) {
  const accept = async () => {
    await confirmHostKey(request.requestId);
    onResolved(request.requestId);
  };

  const reject = async () => {
    await rejectHostKey(request.requestId);
    onResolved(request.requestId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg border border-amber/40 bg-surface p-5 shadow-xl">
        <h2 className="font-display text-base font-semibold text-text">Unknown host key</h2>
        <p className="mt-2 text-sm text-muted">
          The host{" "}
          <span className="font-mono text-text">
            {request.host}:{request.port}
          </span>{" "}
          presented a {request.algorithm} key that hasn't been seen before. Verify the fingerprint
          out-of-band before trusting it.
        </p>
        <p className="mt-3 break-all rounded border border-border bg-bg p-2 font-mono text-xs text-text">
          {request.fingerprint}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={reject}
            className="rounded px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            Reject
          </button>
          <button
            onClick={accept}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Trust &amp; Connect
          </button>
        </div>
      </div>
    </div>
  );
}
