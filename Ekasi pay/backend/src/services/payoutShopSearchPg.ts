import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { cashLiquidityIsStale } from './cashAvailabilityPg.js';

type Db = Pool | PoolClient;

export type PayoutShop = {
  merchantId: string;
  businessName: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  freeCents: string;
  stale: boolean;
  agentStatus: string;
  distanceKm: number | null;
};

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function searchPayoutShopsPg(
  database: Db,
  input: {
    amountCents: Cents;
    latitude?: number;
    longitude?: number;
    includeStale?: boolean;
  },
): Promise<{ shops: PayoutShop[] }> {
  const amount = parseIntegerCents(input.amountCents);
  const rows = await database.query<{
    merchant_id: string;
    business_name: string;
    location: string;
    latitude: string | number | null;
    longitude: string | number | null;
    available_cents: string;
    reserved_cents: string;
    last_verified_at: string | null;
    agent_status: string;
    float_suspended: boolean;
  }>(
    `SELECT m.id AS merchant_id, m.business_name, m.location, m.latitude, m.longitude,
            COALESCE(l.available_cents, 0)::text AS available_cents,
            COALESCE(l.reserved_cents, 0)::text AS reserved_cents,
            l.last_verified_at::text AS last_verified_at,
            pa.status AS agent_status,
            pa.float_suspended
       FROM merchants m
       JOIN payout_agents pa ON pa.merchant_id = m.user_id
       JOIN merchant_cash_liquidity l ON l.merchant_id = m.id
      WHERE m.approval_status = 'approved'
        AND pa.status IN ('enrolled','approved')
        AND pa.float_suspended = FALSE
        AND m.latitude IS NOT NULL AND m.longitude IS NOT NULL
        AND (l.available_cents - l.reserved_cents) >= $1`,
    [amount.toString()],
  );
  const shops = rows.rows
    .map((row) => {
      const lat = row.latitude == null ? null : Number(row.latitude);
      const lng = row.longitude == null ? null : Number(row.longitude);
      const stale = cashLiquidityIsStale(row.last_verified_at);
      const free =
        parseIntegerCents(row.available_cents, { allowZero: true }) -
        parseIntegerCents(row.reserved_cents, { allowZero: true });
      const distanceKm =
        input.latitude != null && input.longitude != null && lat != null && lng != null
          ? haversineKm(input.latitude, input.longitude, lat, lng)
          : null;
      return {
        merchantId: row.merchant_id,
        businessName: row.business_name,
        location: row.location,
        latitude: lat,
        longitude: lng,
        freeCents: free.toString(),
        stale,
        agentStatus: row.agent_status,
        distanceKm,
      } satisfies PayoutShop;
    })
    .filter((shop) => input.includeStale === true || !shop.stale)
    .sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) return 0;
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    })
    .slice(0, 50);
  return { shops };
}
