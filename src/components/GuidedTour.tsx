import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDialogFocus } from "../dialogFocus";

export interface TourStep {
  id: string;
  chapter: string;
  /** `data-tour` name(s), first visible wins; null for a centred card with no spotlight. */
  target: string | readonly string[] | null;
  keys?: readonly string[];
  /** Show the card centred instead of skipping it when no target is on screen. */
  center?: boolean;
}

const EDGE = 8;
const GAP = 16;
const PAD = 4;
// A plain dark scrim: the app sets no `color-scheme`, so `light-dark()` would
// always pick its light branch (a pale veil over dark themes), and older
// WebKitGTK builds don't parse it at all.
const SCRIM = "rgb(0 0 0 / 0.55)";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

function placeCard(rect: DOMRect, width: number, height: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const candidates = [
    { side: "bottom", left: x - width / 2, top: rect.bottom + GAP, room: vh - rect.bottom - GAP - EDGE - height },
    { side: "top", left: x - width / 2, top: rect.top - GAP - height, room: rect.top - GAP - EDGE - height },
    { side: "right", left: rect.right + GAP, top: y - height / 2, room: vw - rect.right - GAP - EDGE - width },
    { side: "left", left: rect.left - GAP - width, top: y - height / 2, room: rect.left - GAP - EDGE - width },
  ];
  const position = candidates.find(({ room }) => room >= 0) ??
    candidates.reduce((best, candidate) => candidate.room > best.room ? candidate : best);
  const left = clamp(position.left, EDGE, vw - width - EDGE);
  const top = clamp(position.top, EDGE, vh - height - EDGE);
  const vertical = position.side === "top" || position.side === "bottom";
  return {
    left, top, side: position.side,
    arrow: clamp(vertical ? x - left : y - top, 14, (vertical ? width : height) - 14),
    fits: position.room >= 0,
  };
}

const arrowEdges: Record<string, string> = {
  bottom: "-top-1.5 border-l border-t",
  top: "-bottom-1.5 border-b border-r",
  right: "-left-1.5 border-b border-l",
  left: "-right-1.5 border-r border-t",
};

interface Props {
  steps: readonly TourStep[];
  onShowStep?: (index: number) => void;
  onFinish: () => void;
}

export function GuidedTour({ steps, onShowStep, onFinish }: Props) {
  const { t } = useTranslation("tourGuide");
  const [index, setIndex] = useState(0);
  const [missing, setMissing] = useState<number[]>([]);
  const [measured, setMeasured] = useState<{ index: number; rect: DOMRect | null; card: ReturnType<typeof placeCard> } | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const enterButton = useRef<HTMLButtonElement | null>(null);
  const title = useId();
  const description = useId();
  const trapTab = useDialogFocus(dialog, nextButton);
  const step = steps[index];

  // The portal stays interactive while the app, including any preview panels
  // and xterm textareas, is inert. Keep the opener for focus restoration.
  useLayoutEffect(() => {
    const root = document.getElementById("root");
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!root) return;
    root.inert = true;
    nextButton.current?.focus({ preventScroll: true });
    return () => {
      root.inert = false;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    onShowStep?.(index);
  }, [index, onShowStep]);

  const go = (destination: number) => {
    if (destination >= steps.length) onFinish();
    else if (destination >= 0) {
      nextButton.current?.focus({ preventScroll: true });
      setIndex(destination);
    }
  };

  const previous = steps.findLastIndex((_, i) => i < index && !missing.includes(i));
  const next = steps.findIndex((_, i) => i > index && !missing.includes(i));
  const nextChapter = steps.findIndex((item, i) => i > index && item.chapter !== step.chapter && !missing.includes(i));
  const skipMissing = useRef(() => {});
  skipMissing.current = () => {
    setMissing((items) => [...items, index]);
    go(next < 0 ? steps.length : next);
  };

  useLayoutEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    const targets = step.target === null ? [] : typeof step.target === "string" ? [step.target] : step.target;
    let frame = 0;
    let current: HTMLElement | undefined;
    let settleUntil = 0;
    const deadline = performance.now() + 700;
    const resize = new ResizeObserver(() => schedule());
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const measure = () => {
      const centred = () => {
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const card = {
          left: Math.max(EDGE, (window.innerWidth - width) / 2),
          top: Math.max(EDGE, (window.innerHeight - height) / 2),
          side: "none",
          arrow: 0,
          fits: false,
        };
        setMeasured((last) =>
          last?.index === index && !last.rect && last.card.left === card.left && last.card.top === card.top
            ? last
            : { index, rect: null, card },
        );
      };
      if (targets.length === 0) {
        centred();
        return;
      }
      // Every match of each name, in order: a hidden copy (a file panel in
      // another tab) must not mask a visible one.
      const target = targets
        .flatMap((name) => [...document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)])
        .find((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === "visible");
      if (!target) {
        if (!current && performance.now() < deadline) schedule();
        else if (step.center) centred();
        else skipMissing.current();
        return;
      }
      if (target !== current) {
        if (current) resize.unobserve(current);
        current = target;
        settleUntil = performance.now() + 230;
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
        resize.observe(target);
      }
      const bounds = target.getBoundingClientRect();
      let left = Math.max(0, bounds.left);
      let right = Math.min(window.innerWidth, bounds.right);
      let top = Math.max(0, bounds.top);
      let bottom = Math.min(window.innerHeight, bounds.bottom);
      // A long settings group or rule list can extend past its scrollport.
      for (let parent = target.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(parent);
        if (overflowX === "visible" && overflowY === "visible") continue;
        const clip = parent.getBoundingClientRect();
        if (overflowX !== "visible") {
          left = Math.max(left, clip.left + parent.clientLeft);
          right = Math.min(right, clip.left + parent.clientLeft + parent.clientWidth);
        }
        if (overflowY !== "visible") {
          top = Math.max(top, clip.top + parent.clientTop);
          bottom = Math.min(bottom, clip.top + parent.clientTop + parent.clientHeight);
        }
      }
      if (right <= left || bottom <= top) {
        if (performance.now() < deadline) schedule();
        else if (step.center) centred();
        else skipMissing.current();
        return;
      }
      const rect = new DOMRect(left, top, right - left, bottom - top);
      const card = placeCard(rect, panel.offsetWidth, panel.offsetHeight);
      setMeasured((last) => {
        if (last?.index === index && last.rect &&
            last.rect.x === rect.x && last.rect.y === rect.y &&
            last.rect.width === rect.width && last.rect.height === rect.height &&
            last.card.left === card.left && last.card.top === card.top &&
            last.card.side === card.side && last.card.arrow === card.arrow && last.card.fits === card.fits) return last;
        return { index, rect, card };
      });
      // Panel entrance animations can move a target without resizing it.
      if (performance.now() < settleUntil) schedule();
    };
    schedule();
    resize.observe(panel);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [index, step]);

  const ready = measured?.index === index;
  const card = ready ? measured.card : null;
  const rect = measured?.rect;
  const total = steps.length - missing.length;
  const count = index + 1 - missing.filter((i) => i < index).length;
  const progress = t("stepProgress", { current: count, total });
  const button = "rounded-lg px-2.5 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

  return createPortal(
    <div
      className="fixed inset-0 z-[80] isolate overflow-hidden"
      data-tour-overlay
      onMouseDown={(e) => { if (e.target === e.currentTarget) e.preventDefault(); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* The cutout jumps between targets instead of sliding: animating its
          box repaints the viewport-sized shadow every frame, which drops
          WebKitGTK (and WebGL terminals behind it) to a crawl. Only the ring
          fades in, on the compositor. */}
      {rect ? (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute rounded-xl"
            style={{
              top: rect.top - PAD, left: rect.left - PAD,
              width: rect.width + PAD * 2, height: rect.height + PAD * 2,
              boxShadow: `0 0 0 200vmax ${SCRIM}`,
            }}
          />
          <div
            key={index}
            aria-hidden="true"
            className="tour-spot pointer-events-none absolute rounded-xl"
            style={{
              top: rect.top - PAD, left: rect.left - PAD,
              width: rect.width + PAD * 2, height: rect.height + PAD * 2,
              boxShadow: "0 0 0 1px var(--color-accent), 0 0 0 5px color-mix(in srgb, var(--color-accent) 28%, transparent)",
            }}
          />
        </>
      ) : (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: SCRIM }} />
      )}
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        aria-describedby={description}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.altKey || e.ctrlKey || e.metaKey || /^F\d+$/.test(e.key)) {
            e.preventDefault();
            return;
          }
          trapTab(e);
          if (!["Escape", "Enter", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
          e.preventDefault();
          if (e.shiftKey || e.repeat) return;
          if (e.key === "Enter" && e.target instanceof HTMLButtonElement) enterButton.current = e.target;
          if (!ready) return;
          if (e.key === "ArrowLeft") go(previous);
          if (e.key === "ArrowRight") go(next);
        }}
        onKeyUp={(e) => {
          // Complete closing gestures on release so a held Escape or Enter
          // cannot repeat into the shell as soon as focus is restored.
          if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
          if (e.key !== "Escape" && e.key !== "Enter") return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") onFinish();
          else {
            const button = enterButton.current;
            enterButton.current = null;
            if (button === e.target) button.click();
          }
        }}
        className="absolute left-0 top-0 w-[23rem] max-w-[calc(100vw-16px)] rounded-xl border border-border bg-surface text-text shadow-2xl outline-none transition-transform duration-200 ease-out will-change-transform motion-reduce:transition-none"
        style={{
          // Moved by transform, not top/left: the compositor slides it
          // without a layout or repaint per frame.
          transform: `translate3d(${card?.left ?? measured?.card.left ?? EDGE}px, ${card?.top ?? measured?.card.top ?? EDGE}px, 0)`,
        }}
      >
        {card?.fits && card.side in arrowEdges && (
          <span
            aria-hidden="true"
            className={`absolute size-3 rotate-45 border-border bg-surface ${arrowEdges[card.side]} ${card.side === "left" || card.side === "right" ? "-translate-y-1/2" : "-translate-x-1/2"}`}
            style={card.side === "left" || card.side === "right" ? { top: card.arrow } : { left: card.arrow }}
          />
        )}
        <div className="relative max-h-[calc(100dvh-18px)] overflow-auto overscroll-contain rounded-xl">
          <div className="sticky top-0 z-10 flex h-1 gap-px bg-surface-hover" aria-hidden="true">
            {steps.map((item, i) => missing.includes(i) ? null : (
              <span key={item.id} className={`flex-1 ${i <= index ? "bg-accent" : "bg-border"}`} />
            ))}
          </div>
          <div className="px-4 pb-3 pt-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-accent">{t(`chapters.${step.chapter}`)}</p>
              <div className="flex shrink-0 items-center gap-2">
                <p className="font-mono text-[11px] text-muted">{progress}</p>
                <button type="button" onClick={onFinish} aria-label={t("close")} title={t("close")} className="rounded px-1 text-lg leading-none text-muted hover:bg-surface-hover hover:text-text focus-visible:outline-accent">×</button>
              </div>
            </div>
            <div aria-live="polite" aria-atomic="true">
              <h2 id={title} className="mt-1.5 font-display text-base font-semibold">{ready ? t(`steps.${step.id}.title`) : t("loading")}</h2>
              <p id={description} className="mt-1.5 text-sm leading-relaxed text-muted">{ready ? t(`steps.${step.id}.body`) : null}</p>
            </div>
            {ready && step.keys && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {step.keys.map((key) => <kbd key={key} className="rounded-md border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px]">{key}</kbd>)}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
              <button type="button" disabled={!ready} onClick={() => go(nextChapter < 0 ? steps.length : nextChapter)} className={`${button} text-muted hover:bg-surface-hover disabled:opacity-40`}>{t("skipChapter")}</button>
              <div className="ml-auto flex gap-1.5">
                <button type="button" disabled={!ready || previous < 0} onClick={() => go(previous)} className={`${button} border border-border hover:bg-surface-hover disabled:opacity-40`}>{t("back")}</button>
                <button type="button" ref={nextButton} aria-disabled={!ready} onClick={() => ready && go(next < 0 ? steps.length : next)} className={`${button} bg-accent text-on-accent hover:bg-accent-hover aria-disabled:opacity-60`}>{next < 0 ? t("done") : t("next")}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
