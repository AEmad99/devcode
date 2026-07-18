/** Coalesce high-frequency stream tokens into ~frame-rate UI updates. */
export function createThrottle(ms: number, flush: () => void): {
  kick: () => void;
  cancel: () => void;
  flushNow: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const kick = (): void => {
    pending = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending) {
        pending = false;
        flush();
      }
    }, ms);
  };

  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = false;
  };

  const flushNow = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending) {
      pending = false;
      flush();
    }
  };

  return { kick, cancel, flushNow };
}
