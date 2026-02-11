"use client";

import { useEffect, useRef, useState } from "react";

type CountUpProps = {
  value: string;
  className?: string;
};

export function CountUp({ value, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(value);
  const [started, setStarted] = useState(false);

  // Extract leading number and suffix (e.g. "500+" → 500, "+")
  const match = value.match(/^(\d+)(.*)$/);
  const targetNum = match ? parseInt(match[1], 10) : null;
  const suffix = match ? match[2] : "";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started) {
          setStarted(true);
          observer.unobserve(el);
        }
      },
      { threshold: 0.3 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started || targetNum === null) return;

    const duration = 1200;
    const steps = 30;
    let current = 0;
    let step = 0;

    const timer = setInterval(() => {
      step++;
      // Ease-out: fast start, slow finish
      const progress = 1 - Math.pow(1 - step / steps, 3);
      current = Math.round(progress * targetNum);
      setDisplay(`${current}${suffix}`);

      if (step >= steps) {
        clearInterval(timer);
        setDisplay(value);
      }
    }, duration / steps);

    return () => clearInterval(timer);
  }, [started, targetNum, suffix, value]);

  return (
    <span ref={ref} className={className}>
      {display}
    </span>
  );
}
