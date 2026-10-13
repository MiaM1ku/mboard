import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
let motionPreference: MediaQueryList | undefined;

function getMotionPreference() {
  if (typeof window === "undefined" || !window.matchMedia) return undefined;
  return (motionPreference ??= window.matchMedia(REDUCED_MOTION_QUERY));
}

function subscribeToMotionPreference(onChange: () => void) {
  const preference = getMotionPreference();
  preference?.addEventListener("change", onChange);
  return () => preference?.removeEventListener("change", onChange);
}

/** Shared with other motion primitives so an OS preference change takes effect live. */
export function useReducedMotion() {
  return useSyncExternalStore(
    subscribeToMotionPreference,
    () => getMotionPreference()?.matches ?? true,
    () => true,
  );
}

export interface AnimatedValueProps {
  value: number;
  format?: (n: number) => string;
  duration?: number;
}

const numberString = (n: number) => String(n);

/** Keep the accessible value truthful while the visual number catches up. */
export function AnimatedValue({
  value,
  format = numberString,
  duration = 650,
}: AnimatedValueProps) {
  const reducedMotion = useReducedMotion();
  const [display, setDisplay] = useState(() =>
    reducedMotion || !Number.isFinite(value) ? value : 0,
  );
  const current = useRef(display);
  const [animating, setAnimating] = useState(false);
  const milliseconds = Number.isFinite(duration)
    ? Math.min(1000, Math.max(0, duration))
    : 650;

  useLayoutEffect(() => {
    const from = current.current;
    if (
      reducedMotion ||
      milliseconds === 0 ||
      !Number.isFinite(value) ||
      !Number.isFinite(from)
    ) {
      current.current = value;
      setDisplay(value);
      setAnimating(false);
      return;
    }
    if (from === value) {
      setAnimating(false);
      return;
    }
    setAnimating(true);

    let frame: number | undefined;
    let previousTime: number | undefined;
    let elapsed = 0;
    let active = true;
    const wholeNumbers = Number.isInteger(from) && Number.isInteger(value);

    const tick = (time: number) => {
      frame = undefined;
      if (!active || document.hidden) {
        previousTime = undefined;
        return;
      }
      if (previousTime !== undefined) elapsed += time - previousTime;
      previousTime = time;
      const progress = Math.min(1, elapsed / milliseconds);
      const eased = 1 - (1 - progress) ** 3;
      const interpolated = from + (value - from) * eased;
      // Counts remain whole during motion. The last frame always uses the raw target.
      const next = progress === 1
        ? value
        : wholeNumbers ? Math.round(interpolated) : interpolated;
      current.current = next;
      setDisplay(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else setAnimating(false);
    };

    const onVisibilityChange = () => {
      previousTime = undefined;
      if (document.hidden) {
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
      } else if (active && frame === undefined && elapsed < milliseconds) {
        frame = requestAnimationFrame(tick);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    if (!document.hidden) frame = requestAnimationFrame(tick);
    return () => {
      active = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [value, milliseconds, reducedMotion]);

  const visible = reducedMotion || milliseconds === 0 || !Number.isFinite(value)
    ? value
    : display;
  return (
    <span
      className="mb-custom-motion-number"
      data-motion-value={value}
      data-motion-state={
        animating && !reducedMotion && milliseconds > 0 && Number.isFinite(value)
          ? "animating"
          : "settled"
      }
    >
      <span className="mb-custom-motion-number-label">{format(value)}</span>
      <span className="mb-custom-motion-number-visible" aria-hidden="true">
        {format(visible)}
      </span>
    </span>
  );
}
