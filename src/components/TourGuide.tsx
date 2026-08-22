import { useEffect, useLayoutEffect, useState } from "react";

/** Which modal the tour needs open for a step. `null` closes whatever is open. */
export type TourPanel = "add" | "router" | "hosts" | "settings";

interface Step {
  title: string;
  body: string;
  /** Value of a `data-tour` attribute to spotlight. Omitted = centred card. */
  target?: string;
  /** Panel the step lives inside. The tour opens and closes these itself. */
  panel?: TourPanel;
}

const STEPS: Step[] = [
  {
    title: "Welcome to ProdTunnel",
    body: "A quick pass over what everything does. Two minutes, and you can skip or replay it any time from the ? button.",
  },
  {
    title: "Add a tunnel",
    body: "A tunnel is one SSH connection. This button opens the form — let's look at what's in it.",
    target: "add",
  },
  {
    title: "How you authenticate",
    body: "Password, a private key file, or an SSH agent like Pageant. Passwords and key passphrases go into the Windows Credential Manager, never into the app's own database.",
    target: "add-auth",
    panel: "add",
  },
  {
    title: "What the tunnel exposes",
    body: "Turn on a local SOCKS5 proxy and point a browser or curl at that port. You can also add static port forwards later, from the tunnel's row in the list.",
    target: "add-socks",
    panel: "add",
  },
  {
    title: "Hopping through another tunnel",
    body: "\"Connect via\" makes this tunnel connect through another one's live session — the usual bastion setup. Connecting the inner tunnel dials the whole chain for you, outermost first.",
    target: "add-jump",
    panel: "add",
  },
  {
    title: "The tunnel list",
    body: "Toggle a tunnel with the switch. The dashed line animates while traffic can flow. Expand Forwards to add port forwards live — no reconnect needed. Tunnels that hop through another are indented under their parent.",
    target: "list",
  },
  {
    title: "Search and bulk actions",
    body: "Filter by name or host, and connect or disconnect everything at once.",
    target: "bulk",
  },
  {
    title: "The proxy router",
    body: "Per-tunnel SOCKS ports make you pick a tunnel per application. The router flips that around: one local port, and rules choose a destination per connection.",
    target: "router",
  },
  {
    title: "Turning the router on",
    body: "It binds one SOCKS5 port on 127.0.0.1 only. A rule pointing at a tunnel that isn't up will connect that tunnel on demand, so you can leave everything disconnected and let traffic dial what it needs.",
    target: "router-enable",
    panel: "router",
  },
  {
    title: "Rules decide where traffic goes",
    body: "Ordered top to bottom, first enabled match wins. Match on a host wildcard, a regex, or an IP range, then send it through a tunnel, straight out (direct), or block it. Anything unmatched takes the default action.",
    target: "router-rules",
    panel: "router",
  },
  {
    title: "Catching every app",
    body: "Tick this and Windows itself is pointed at the router, so every app follows your rules with no per-app setup. It's undone when the router stops — including after a crash.",
    target: "router-proxy",
    panel: "router",
  },
  {
    title: "Why did that go direct?",
    body: "Every proxied connection is logged with the rule that decided it. This is the first place to look when a rule doesn't fire the way you expected.",
    target: "router-log",
    panel: "router",
  },
  {
    title: "Known hosts",
    body: "The first time you reach a server its host key is shown and you decide whether to trust it. After that, a changed key is refused outright rather than silently accepted. Revoke one here to be asked again.",
    target: "hosts-list",
    panel: "hosts",
  },
  {
    title: "Staying connected",
    body: "Keepalives are how a dead connection gets noticed at all; retries back off so a flapping server isn't hammered. Local ports stay held during an outage so nothing else can take them.",
    target: "settings-reconnect",
    panel: "settings",
  },
  {
    title: "Moving to another machine",
    body: "Export writes your tunnels, router rules, and settings to one file. Secrets are only included if you set a passphrase — leave it blank and the file is safe to share.",
    target: "settings-config",
    panel: "settings",
  },
  {
    title: "It lives in the tray",
    body: "Closing the window only hides it — tunnels keep running. Reopen from the tray icon, toggle tunnels from its menu, and use the tray's Exit item when you actually want to quit.",
  },
];

const PADDING = 6;
const CARD_WIDTH = 360;

interface Props {
  onFinish: () => void;
  onRequestPanel: (panel: TourPanel | null) => void;
}

export function TourGuide({ onFinish, onRequestPanel }: Props) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;

  // Ask for the panel first; the element to spotlight only exists once it mounts.
  useEffect(() => {
    onRequestPanel(step.panel ?? null);
  }, [step.panel, onRequestPanel]);

  useLayoutEffect(() => {
    if (!step.target) {
      setRect(null);
      return;
    }

    let frame = 0;
    let attempts = 0;
    const measure = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        el.scrollIntoView({ block: "nearest" });
        setRect(el.getBoundingClientRect());
        return;
      }
      // A panel opened by this same step mounts a frame or two later, so keep
      // looking briefly instead of falling back to a centred card immediately.
      if (attempts++ < 40) {
        frame = requestAnimationFrame(measure);
      } else {
        setRect(null);
      }
    };
    measure();

    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, [step.target, step.panel]);

  const finish = () => {
    onRequestPanel(null);
    onFinish();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, STEPS.length - 1));
      else if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Card sits below the highlight, or above it when there is no room.
  const left = rect ? Math.max(12, Math.min(rect.left, window.innerWidth - CARD_WIDTH - 12)) : 0;
  const cardStyle: React.CSSProperties = rect
    ? rect.bottom + 220 < window.innerHeight
      ? { top: rect.bottom + 14, left }
      : { bottom: window.innerHeight - rect.top + 14, left }
    : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };

  return (
    <div className="fixed inset-0 z-[60]">
      {/* One huge box-shadow is what cuts the hole in the dimmer. */}
      {rect ? (
        <div
          className="pointer-events-none absolute rounded-md ring-2 ring-accent transition-all duration-200"
          style={{
            top: rect.top - PADDING,
            left: rect.left - PADDING,
            width: rect.width + PADDING * 2,
            height: rect.height + PADDING * 2,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.65)",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/65" />
      )}

      <div
        className="absolute w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-4 shadow-xl"
        style={cardStyle}
      >
        <p className="text-[11px] font-medium text-muted">
          Step {index + 1} of {STEPS.length}
        </p>
        <h3 className="mt-1 font-display text-base font-semibold text-text">{step.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={finish}
            className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            Skip
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setIndex((i) => i - 1)}
              disabled={index === 0}
              className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text hover:bg-surface-hover disabled:opacity-40"
            >
              Back
            </button>
            <button
              onClick={() => (isLast ? finish() : setIndex((i) => i + 1))}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
            >
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
