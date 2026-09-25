export function wait(ms: number, signal?: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    // An already-aborted signal never fires the listener: resolve up front.
    if (signal?.aborted) {
      resolve(false);
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };

    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);

    signal?.addEventListener('abort', onAbort);
  });
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeout: number,
  interval: number,
  signal?: AbortSignal,
  startInterval?: number,
) {
  const start = Date.now();
  // Exponential warm-up (Python parity): the first seconds of readiness matter
  // most, so delays double from startInterval until reaching the steady interval.
  let delay = Math.min(startInterval ?? interval, interval);

  do {
    // An already-aborted signal never fires wait()'s listener: stop up front.
    if (signal?.aborted) {
      return false;
    }

    if (await predicate()) {
      return true;
    }

    await wait(delay * 1_000, signal);
    delay = Math.min(interval, delay * 2);
  } while (Date.now() - start < timeout * 1_000);

  return false;
}
