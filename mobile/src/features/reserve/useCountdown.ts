import { useEffect, useState } from 'react';

/**
 * Seconds until the ISO instant, ticking every second; null without one.
 * Drives the checkout hold countdown (M3). Ported from member-web's
 * use-countdown, using the RN global timer instead of window.
 */
export function useCountdown(expiresAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}
