// Interval scheduler with exponential backoff. Each poller re-reads its
// interval every tick so the app can drop to idle pacing when nothing is live.
export function createPoller(name, fn, getInterval) {
  let timer = null;
  let stopped = false;
  let failures = 0;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      await fn();
      failures = 0;
    } catch (err) {
      failures++;
      console.warn(`[poll:${name}] failed (${failures})`, err);
    } finally {
      running = false;
      if (!stopped) {
        const base = getInterval();
        const wait = base * Math.min(2 ** failures, 8);
        timer = setTimeout(tick, wait);
      }
    }
  }

  return {
    name,
    start() { stopped = false; tick(); return this; },
    stop() { stopped = true; clearTimeout(timer); },
    kick() { clearTimeout(timer); tick(); },
    get failures() { return failures; },
  };
}

// Spread per-game play polls across the interval instead of firing 13 requests
// in the same tick.
export function stagger(items, intervalMs, fn) {
  const step = items.length ? Math.floor(intervalMs / items.length) : 0;
  return items.map((item, i) => setTimeout(() => fn(item), i * step));
}
