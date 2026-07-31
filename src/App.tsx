import { useEffect, useState } from "react";
import { AddTunnelForm } from "./components/AddTunnelForm";
import { HostKeyPrompt } from "./components/HostKeyPrompt";
import { MessageBar } from "./components/MessageBar";
import { TunnelList } from "./components/TunnelList";
import { useTunnelEvents } from "./hooks/useTunnelEvents";
import {
  addTunnel,
  connectTunnel,
  deleteTunnel,
  disconnectTunnel,
  listTunnels,
  updateTunnel,
} from "./api";
import type { Tunnel, TunnelInput } from "./types";

interface Message {
  text: string;
  isError: boolean;
}

function App() {
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [formTarget, setFormTarget] = useState<Tunnel | "new" | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const { statuses, hostKeyQueue, dismissHostKey } = useTunnelEvents((_tunnelId, text) =>
    setMessage({ text, isError: true }),
  );

  useEffect(() => {
    listTunnels()
      .then(setTunnels)
      .catch((err) => setMessage({ text: String(err), isError: true }));
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  const refresh = async () => setTunnels(await listTunnels());

  const handleToggle = async (tunnel: Tunnel) => {
    const status = statuses[tunnel.id]?.status ?? "disconnected";
    try {
      if (status === "connected" || status === "connecting") {
        await disconnectTunnel(tunnel.id);
      } else {
        await connectTunnel(tunnel.id);
      }
    } catch (err) {
      setMessage({ text: String(err), isError: true });
    }
  };

  const handleDelete = async (tunnel: Tunnel) => {
    try {
      await deleteTunnel(tunnel.id);
      await refresh();
    } catch (err) {
      setMessage({ text: String(err), isError: true });
    }
  };

  const handleSubmit = async (input: TunnelInput, secret?: string) => {
    if (formTarget && formTarget !== "new") {
      await updateTunnel(formTarget.id, input, secret);
    } else {
      await addTunnel(input, secret);
    }
    await refresh();
    setFormTarget(null);
  };

  return (
    <main className="flex h-screen flex-col bg-neutral-100 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-300 px-4 py-3 dark:border-neutral-800">
        <h1 className="text-lg font-semibold">ProdTunnel</h1>
        <button
          onClick={() => setFormTarget("new")}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Add tunnel
        </button>
      </header>

      <MessageBar text={message?.text ?? null} isError={message?.isError ?? false} />

      <TunnelList
        tunnels={tunnels}
        statuses={statuses}
        onToggle={handleToggle}
        onEdit={setFormTarget}
        onDelete={handleDelete}
      />

      {formTarget && (
        <AddTunnelForm
          initial={formTarget === "new" ? null : formTarget}
          onSubmit={handleSubmit}
          onCancel={() => setFormTarget(null)}
        />
      )}

      {hostKeyQueue[0] && (
        <HostKeyPrompt request={hostKeyQueue[0]} onResolved={dismissHostKey} />
      )}
    </main>
  );
}

export default App;
