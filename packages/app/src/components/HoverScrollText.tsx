import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./HoverScrollText.module.css";

/** Measure only the hovered label: a large fleet needs no per-row observers at rest. */
export function HoverScrollText({ text, children }: { text: string; children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const viewportRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!hovered || !viewport || !track) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animation: Animation | undefined;
    let previousDistance = -1;
    const measure = (): void => {
      track.style.display = motion.matches ? "inline" : "inline-block";
      const distance = motion.matches ? 0 : Math.max(0, track.getBoundingClientRect().width - viewport.clientWidth);
      if (distance === previousDistance) return;
      previousDistance = distance;
      animation?.cancel();
      viewport.dataset.scrolling = distance > 1 ? "true" : "false";
      if (distance <= 1) return;
      // Constant reading speed, followed by a hold on the final characters.
      // Transforming the clipped track leaves every adjacent column untouched.
      animation = track.animate([{ transform: "translateX(0)" }, { transform: `translateX(-${distance}px)` }], {
        duration: Math.max(1000, distance / 32 * 1000), delay: 600, easing: "linear", fill: "forwards",
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(track);
    motion.addEventListener("change", measure);
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", measure);
      animation?.cancel();
      track.style.removeProperty("display");
      delete viewport.dataset.scrolling;
    };
  }, [hovered, text]);
  return (
    <span ref={viewportRef} className={styles.viewport} title={text} data-hover-scroll
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <span ref={trackRef} className={styles.track} data-hover-scroll-track>{children}</span>
    </span>
  );
}
