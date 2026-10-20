/**
 * Expiring holds: a seat or a discounted offer reserved for N minutes while
 * the buyer pays. A cron every minute or two releases what timed out, so a
 * 15-minute countdown on the page is honest.
 */

export interface Hold {
  id: string;
  status: "pending" | "paid" | "expired";
  expiresAt: Date;
  resourceId?: string | null;
}

export function expiredHolds<T extends Hold>(holds: T[], now: Date): { expire: T[]; release: string[] } {
  const expire = holds.filter((h) => h.status === "pending" && h.expiresAt.getTime() < now.getTime());
  return { expire, release: expire.map((h) => h.resourceId).filter((r): r is string => Boolean(r)) };
}
