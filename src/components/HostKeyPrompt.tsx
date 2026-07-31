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
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          Unknown host key
        </h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          The host{" "}
          <span className="font-mono">
            {request.host}:{request.port}
          </span>{" "}
          presented a {request.algorithm} key that hasn't been seen before. Verify the fingerprint
          out-of-band before trusting it.
        </p>
        <p className="mt-3 break-all rounded bg-neutral-100 p-2 font-mono text-xs text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
          {request.fingerprint}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={reject}
            className="rounded px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Reject
          </button>
          <button
            onClick={accept}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Trust &amp; Connect
          </button>
        </div>
      </div>
    </div>
  );
}
