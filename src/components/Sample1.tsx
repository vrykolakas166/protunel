import "./Sample1.css";

interface Props {
  /** Rendered diameter in CSS pixels. The design's native stage is
   * `STAGE_SIZE` — everything scales down uniformly via CSS `transform`
   * so proportions and timing stay exact at any size. */
  size?: number;
  className?: string;
}

/** Native size the ported animation was authored at. Large relative to a
 * header icon on purpose: several elements (fragments, glow spread) sit
 * well outside the visible core, and clipping them changes the silhouette
 * at the edges of the loop, not just its size. */
const STAGE_SIZE = 700;

/** Pure-CSS orb: a shaded sphere with a soft pupil, four orbiting rings, a
 * ring stack of dashed/conic "bagel" arcs, and drifting glitch/fragment
 * particles — all `@keyframes`-driven, no JS animation loop. Purely
 * decorative (`aria-hidden`); callers own the accessible name. */
export function Sample1({ size = 40, className }: Props) {
  const scale = size / STAGE_SIZE;

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{ width: size, height: size, position: "relative", overflow: "hidden" }}
    >
      <div
        className="sample1-stage"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        <div className="s1-eye" />
        <div className="s1-circle-1" />
        <div className="s1-circle-2" />
        <div className="s1-circle-3" />
        <div className="s1-circle-4" />
        <div className="s1-circle-5" />
        <div className="s1-circle-6" />
        <div className="s1-circle-7" />
        <div className="s1-circle-8" />
        <div className="s1-circle-9" />
        <div className="s1-circle-10" />
        <div className="s1-circle-11" />
        <div className="s1-circle-12" />
        <div className="s1-circle-13" />
        <div className="s1-circle-14" />
        <div className="s1-glitch" />
        <div className="s1-fragment-1" />
        <div className="s1-fragment-2" />
        <div className="s1-fragment-3" />
      </div>

      <svg width="0" height="0" style={{ position: "absolute" }}>
        <defs>
          <clipPath id="s1-bagel1">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M95 190C147.467 190 190 147.467 190 95C190 42.533 147.467 0 95 0C42.533 0 0 42.533 0 95C0 147.467 42.533 190 95 190ZM95 120C108.807 120 120 108.807 120 95C120 81.1929 108.807 70 95 70C81.1929 70 70 81.1929 70 95C70 108.807 81.1929 120 95 120Z"
            />
          </clipPath>
          <clipPath id="s1-bagel2">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M71 142C110.212 142 142 110.212 142 71C142 31.7878 110.212 0 71 0C31.7878 0 0 31.7878 0 71C0 110.212 31.7878 142 71 142ZM71 139C108.555 139 139 108.555 139 71C139 33.4446 108.555 3 71 3C33.4446 3 3 33.4446 3 71C3 108.555 33.4446 139 71 139Z"
            />
          </clipPath>
          <clipPath id="s1-bagel3">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M60 120C93.1372 120 120 93.1372 120 60C120 26.8628 93.1372 0 60 0C26.8628 0 0 26.8628 0 60C0 93.1372 26.8628 120 60 120ZM60 115C90.3757 115 115 90.3757 115 60C115 29.6243 90.3757 5 60 5C29.6243 5 5 29.6243 5 60C5 90.3757 29.6243 115 60 115Z"
            />
          </clipPath>
          <clipPath id="s1-bagel4">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M38 76C58.9868 76 76 58.9868 76 38C76 17.0132 58.9868 0 38 0C17.0132 0 0 17.0132 0 38C0 58.9868 17.0132 76 38 76ZM38 72C56.7777 72 72 56.7776 72 38C72 19.2224 56.7777 4 38 4C19.2223 4 4 19.2224 4 38C4 56.7776 19.2223 72 38 72Z"
            />
          </clipPath>
        </defs>
      </svg>
    </div>
  );
}
