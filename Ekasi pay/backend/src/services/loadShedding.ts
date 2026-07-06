import type Database from 'better-sqlite3';

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

function readDbSlots(database: Database.Database): SlotRow[] {
  return database
    .prepare('SELECT * FROM load_shedding_slots ORDER BY start_time')
    .all() as SlotRow[];
}

function normalizeRemoteSlot(raw: unknown): SlotRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id ? r.id : '';
  const stage = Number(r.stage);
  const start = typeof r.start_time === 'string' ? r.start_time : r.startTime;
  const end = typeof r.end_time === 'string' ? r.end_time : r.endTime;
  const area = typeof r.area === 'string' ? r.area : '';
  if (!id || !Number.isFinite(stage) || typeof start !== 'string' || typeof end !== 'string' || !area) {
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

export async function getLoadSheddingSlots(
  database: Database.Database,
): Promise<SlotRow[]> {
  if (LOAD_SHEDDING_PROVIDER !== 'http' || !LOAD_SHEDDING_FEED_URL) {
    return readDbSlots(database);
  }
  try {
    const response = await fetch(LOAD_SHEDDING_FEED_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Load shedding feed status ${response.status}`);
    const payload = (await response.json()) as unknown;
    const source = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && Array.isArray((payload as { slots?: unknown[] }).slots)
        ? (payload as { slots: unknown[] }).slots
        : [];
    const slots = source.map(normalizeRemoteSlot).filter((s): s is SlotRow => s !== null);
    return slots.length > 0 ? slots : readDbSlots(database);
  } catch {
    return readDbSlots(database);
  }
}
