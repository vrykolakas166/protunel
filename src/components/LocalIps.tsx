import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listLocalIps } from "../api";

interface Props {
  className?: string;
}

/** How often to interrupt the ellipsis and slide through the full text. */
const CYCLE_INTERVAL_MS = 6000;
/** How long the fully-revealed text sits before sliding back. */
const REVEAL_HOLD_MS = 1800;

/** All of the machine's active IPv4 addresses, joined into one line.
 * Truncates with an ellipsis at rest; every few seconds it slides the full
 * line into view instead of just cutting it off, then slides back. */
export function LocalIps({ className }: Props) {
  const { t } = useTranslation("localIps");
  const [ips, setIps] = useState<string[]>([]);
  const [revealOffset, setRevealOffset] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    listLocalIps()
      .then(setIps)
      .catch(() => setIps([]));
  }, []);

  const text = ips.join("   ·   ");

  useEffect(() => {
    if (!text) return;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;

    const cycle = setInterval(() => {
      const container = containerRef.current;
      const span = textRef.current;
      if (!container || !span) return;
      const overflow = span.scrollWidth - container.clientWidth;
      if (overflow <= 0) return; // fits already, nothing to reveal

      setRevealOffset(overflow);
      holdTimer = setTimeout(() => setRevealOffset(null), REVEAL_HOLD_MS);
    }, CYCLE_INTERVAL_MS);

    return () => {
      clearInterval(cycle);
      clearTimeout(holdTimer);
    };
  }, [text]);

  if (!text) return null;

  const revealing = revealOffset !== null;

  return (
    <div
      ref={containerRef}
      title={t("tooltip", { ips: ips.join("\n") })}
      className={`min-w-0 overflow-hidden ${className ?? ""}`}
    >
      <span
        ref={textRef}
        className={`block w-full whitespace-nowrap font-mono text-[11px] text-muted transition-transform duration-700 ease-in-out ${
          revealing ? "" : "overflow-hidden text-ellipsis"
        }`}
        style={revealing ? { transform: `translateX(-${revealOffset}px)` } : undefined}
      >
        {text}
      </span>
    </div>
  );
}
