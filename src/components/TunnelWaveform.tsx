import type { TunnelStatus } from "../types";

interface Props {
  /** Per-second byte deltas, oldest first — real throughput, not decoration. */
  up: number[];
  down: number[];
  status: TunnelStatus;
}

const HEIGHT = 24;
const MIDLINE = HEIGHT / 2;
const AMPLITUDE = 10;

/** Quadratic-through-midpoints smoothing: each segment curves from the
 * midpoint before it to the midpoint after, using the real sample as the
 * control point. Standard lightweight sparkline trick — turns the sharp
 * angles a straight polyline gets between real per-second samples into a
 * flowing curve, without inventing values that weren't actually measured. */
function smoothPath(values: number[], max: number, direction: 1 | -1): string {
  if (values.length < 2) return "";
  const lastIndex = values.length - 1;
  const points = values.map((v, i) => [
    (i / lastIndex) * 100,
    MIDLINE + direction * (v / max) * AMPLITUDE,
  ]);

  let d = `M ${points[0][0]},${points[0][1].toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    d += ` Q ${x0},${y0.toFixed(2)} ${mx},${my.toFixed(2)}`;
  }
  const [lastX, lastY] = points[points.length - 1];
  d += ` L ${lastX},${lastY.toFixed(2)}`;
  return d;
}

/** The tunnel connector: a live waveform of actual up/down throughput once
 * connected, or a flat line (still when idle, breathing amber mid-handshake)
 * otherwise — same visual language across every state, not a separate dot
 * style for "no signal" versus a decorative animation for "connected". */
export function TunnelWaveform({ up, down, status }: Props) {
  if (status !== "connected") {
    const pending = status === "connecting" || status === "reconnecting";
    return (
      <svg viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none" className="h-full w-full">
        <line
          x1="0"
          y1={MIDLINE}
          x2="100"
          y2={MIDLINE}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="0.1 3"
          vectorEffect="non-scaling-stroke"
          className={pending ? "text-amber tunnel-waveform--pending" : "text-slate"}
        />
      </svg>
    );
  }

  // Floor of 1 so an idle-but-connected tunnel (deltas all 0) still renders
  // as a flat line at the midline instead of dividing by zero.
  const max = Math.max(1, ...up, ...down);

  return (
    <svg viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none" className="h-full w-full">
      <path
        d={smoothPath(up, max, -1)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="0.1 3"
        vectorEffect="non-scaling-stroke"
        className="text-accent"
      />
      <path
        d={smoothPath(down, max, 1)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="0.1 3"
        vectorEffect="non-scaling-stroke"
        className="text-coral opacity-80"
      />
    </svg>
  );
}
