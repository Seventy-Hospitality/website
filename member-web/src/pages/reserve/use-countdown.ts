import { useEffect, useState } from 'react';

/**
 * Seconds until the ISO instant, ticking every second; null without one.
 * Drives the checkout hold countdown (W3) and the reschedule-grow's parked
 * change TTL (W4), which ride the same server-side hold window.
 */
export function useCountdown(expiresAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}
