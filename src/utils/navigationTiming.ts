export interface PageLoadDurations {
  responseTime?: number;
  domReadyTime?: number;
  domParseTime?: number;
  loadTime?: number;
}

export function observePageLoadTiming(
  report: (durations: PageLoadDurations) => void,
): () => void {
  let timer: number | undefined;
  let disposed = false;

  const schedule = () => {
    // loadEventEnd is still zero inside the load handler. Read it on the next
    // task, after every load listener has returned, including on late mounts.
    timer = window.setTimeout(() => {
      if (disposed) return;
      const navigation = window.performance.getEntriesByType?.(
        'navigation',
      )[0] as PerformanceNavigationTiming | undefined;
      const timing = navigation || window.performance.timing;
      if (!timing) return;
      const start = navigation
        ? navigation.startTime
        : window.performance.timing.navigationStart;
      if (!navigation && !(start > 0)) return;

      const duration = (end: number, begin: number) =>
        Number.isFinite(end) &&
        Number.isFinite(begin) &&
        begin >= 0 &&
        end > 0 &&
        end >= begin
          ? Math.round(end - begin)
          : undefined;

      report({
        responseTime: duration(timing.responseStart, start),
        domReadyTime: duration(timing.domInteractive, timing.responseEnd),
        domParseTime: duration(timing.domComplete, timing.domInteractive),
        loadTime: duration(timing.loadEventEnd, start),
      });
    }, 0);
  };

  if (document.readyState === 'complete') {
    schedule();
  } else {
    window.addEventListener('load', schedule, { once: true });
  }

  return () => {
    disposed = true;
    window.removeEventListener('load', schedule);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
