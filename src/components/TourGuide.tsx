import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

/** Which modal the tour needs open for a step. `null` closes whatever is open. */
export type TourPanel = "add" | "router" | "capture" | "settings";

interface StepDef {
  /** Key into the `tourGuide` locale namespace's `steps` object. */
  id: string;
  /** Value of a `data-tour` attribute to spotlight. Omitted = centred card. */
  target?: string;
  /** Panel the step lives inside. The tour opens and closes these itself. */
  panel?: TourPanel;
}

interface Step extends StepDef {
  title: string;
  body: string;
}

const STEP_DEFS: StepDef[] = [
  {
    id: "welcome",
  },
  {
    id: "add",
    target: "add",
  },
  {
    id: "add-auth",
    target: "add-auth",
    panel: "add",
  },
  {
    id: "add-socks",
    target: "add-socks",
    panel: "add",
  },
  {
    id: "add-jump",
    target: "add-jump",
    panel: "add",
  },
  {
    id: "list",
    target: "list",
  },
  {
    id: "bulk",
    target: "bulk",
  },
  {
    id: "router",
    target: "router",
  },
  {
    id: "router-enable",
    target: "router-enable",
    panel: "router",
  },
  {
    id: "router-rules",
    target: "router-rules",
    panel: "router",
  },
  {
    id: "router-proxy",
    target: "router-proxy",
    panel: "router",
  },
  {
    id: "router-log",
    target: "router-log",
    panel: "router",
  },
  {
    id: "capture",
    target: "capture",
  },
  {
    id: "capture-launch",
    target: "capture-launch",
    panel: "capture",
  },
  {
    id: "capture-active",
    target: "capture-active",
    panel: "capture",
  },
  {
    id: "capture-log",
    target: "capture-log",
    panel: "capture",
  },
  {
    id: "settings-reconnect",
    target: "settings-reconnect",
    panel: "settings",
  },
  {
    id: "settings-config",
    target: "settings-config",
    panel: "settings",
  },
  {
    id: "tray",
  },
];

const PADDING = 6;
const CARD_WIDTH = 360;

interface Props {
  onFinish: () => void;
  onRequestPanel: (panel: TourPanel | null) => void;
}

export function TourGuide({ onFinish, onRequestPanel }: Props) {
  const { t } = useTranslation("tourGuide");
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const STEPS: Step[] = useMemo(
    () =>
      STEP_DEFS.map((def) => ({
        ...def,
        title: t(`steps.${def.id}.title`),
        body: t(`steps.${def.id}.body`),
      })),
    [t],
  );

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

  // Card sits below the highlight, or above it when there is no room below.
  // Some targets (the tunnel list) span nearly the whole window, leaving no
  // room on either side — pin to whichever edge has more clearance instead
  // of letting the card render partly off-screen.
  const CARD_HEIGHT_ESTIMATE = 200;
  const left = rect ? Math.max(12, Math.min(rect.left, window.innerWidth - CARD_WIDTH - 12)) : 0;
  let cardStyle: React.CSSProperties;
  if (!rect) {
    cardStyle = { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  } else {
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow >= CARD_HEIGHT_ESTIMATE) {
      cardStyle = { top: rect.bottom + 14, left };
    } else if (spaceAbove >= CARD_HEIGHT_ESTIMATE) {
      cardStyle = { bottom: window.innerHeight - rect.top + 14, left };
    } else {
      cardStyle = spaceAbove > spaceBelow ? { top: 12, left } : { bottom: 12, left };
    }
  }

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
          {t("stepProgress", { current: index + 1, total: STEPS.length })}
        </p>
        <h3 className="mt-1 font-display text-base font-semibold text-text">{step.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={finish}
            className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            {t("skip")}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setIndex((i) => i - 1)}
              disabled={index === 0}
              className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text hover:bg-surface-hover disabled:opacity-40"
            >
              {t("back")}
            </button>
            <button
              onClick={() => (isLast ? finish() : setIndex((i) => i + 1))}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
            >
              {isLast ? t("done") : t("next")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
