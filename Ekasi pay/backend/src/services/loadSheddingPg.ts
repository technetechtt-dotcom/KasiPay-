import type { Pool } from 'pg';

import {
  LOAD_SHEDDING_FEED_URL,
  LOAD_SHEDDING_PROVIDER,
} from '../config.js';

type SlotRow = {
  id: string;
  stage: number;
  start_time: string;
  end_time: string;
  area: string;
};

async function readDbSlots(pool: Pool): Promise<SlotRow[]> {
  const r = await pool.query<SlotRow>(
    `SELECT * FROM load_shedding_slots ORDER BY start_time`,
  );
  return r.rows;
}

function normalizeRemoteSlot(raw: unknown): SlotRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' && row.id ? row.id : '';
  const stage = Number(row.stage);
  const start =
    typeof row.start_time === 'string' ? row.start_time : row.startTime;
  const end = typeof row.end_time === 'string' ? row.end_time : row.endTime;
  const area = typeof row.area === 'string' ? row.area : '';
  if (
    !id ||
    !Number.isFinite(stage) ||
    typeof start !== 'string' ||
    typeof end !== 'string' ||
    !area
  ) {
    return null;
  }
  return {
    id,
    stage,
    start_time: start,
    end_time: end,
    area,
  };
}

export async function getLoadSheddingSlotsPg(pool: Pool): Promise<SlotRow[]> {
  if (LOAD_SHEDDING_PROVIDER !== 'http' || !LOAD_SHEDDING_FEED_URL) {
    return readDbSlots(pool);
  }
  try {
    const response = await fetch(LOAD_SHEDDING_FEED_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Load shedding feed status ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    const source = Array.isArray(payload)
      ? payload
      : payload &&
          typeof payload === 'object' &&
          Array.isArray((payload as { slots?: unknown[] }).slots)
        ? (payload as { slots: unknown[] }).slots
        : [];
    const slots = source
      .map(normalizeRemoteSlot)
      .filter((s): s is SlotRow => s !== null);
    return slots.length > 0 ? slots : readDbSlots(pool);
  } catch {
    return readDbSlots(pool);
  }
}
