import { useCallback, useEffect, useRef, useState } from 'react';

import {
  apiMerchants,
  apiSaveMerchantMapPin,
  type OpsMerchant,
} from './api';

const SA_CENTER = { lat: -28.4793, lng: 24.6727 };

type GoogleMaps = {
  Map: new (
    el: HTMLElement,
    opts: Record<string, unknown>,
  ) => {
    fitBounds: (b: unknown) => void;
    setCenter: (ll: { lat: number; lng: number }) => void;
    setZoom: (z: number) => void;
  };
  Marker: new (opts: Record<string, unknown>) => {
    addListener: (event: string, fn: () => void) => void;
  };
  InfoWindow: new (opts?: Record<string, unknown>) => {
    setContent: (html: string) => void;
    open: (map: unknown, anchor: unknown) => void;
  };
  Geocoder: new () => {
    geocode: (
      req: { address: string; region?: string },
      cb: (
        results: Array<{ geometry?: { location?: { lat: () => number; lng: () => number } } }> | null,
        status: string,
      ) => void,
    ) => void;
  };
  LatLngBounds: new () => { extend: (ll: { lat: number; lng: number }) => void; isEmpty?: () => boolean };
};

function mapsKey(): string {
  if (typeof window !== 'undefined') {
    const runtime = window.__KASIPAY_GOOGLE_MAPS_KEY__;
    if (runtime?.trim()) return runtime.trim();
  }
  return String(import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '').trim();
}

function loadGoogleMaps(key: string): Promise<GoogleMaps> {
  const existing = window.google?.maps as GoogleMaps | undefined;
  if (existing?.Map) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const prior = document.querySelector('script[data-kasipay-maps]');
    const done = () => {
      const maps = window.google?.maps as GoogleMaps | undefined;
      if (maps?.Map) resolve(maps);
      else reject(new Error('Google Maps loaded without a Map constructor.'));
    };
    if (prior) {
      prior.addEventListener('load', done);
      prior.addEventListener('error', () =>
        reject(new Error('Google Maps failed to load.')),
      );
      return;
    }
    const script = document.createElement('script');
    script.dataset.kasipayMaps = '1';
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
    script.onload = done;
    script.onerror = () => reject(new Error('Google Maps failed to load.'));
    document.head.appendChild(script);
  });
}

function parseCoord(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function geocodeQuery(location: string): string | null {
  const text = location.trim();
  if (!text) return null;
  if (/^south africa$/i.test(text)) return null;
  return /south africa/i.test(text) ? text : `${text}, South Africa`;
}

function pinFor(merchant: OpsMerchant): { lat: number; lng: number } | null {
  const lat = parseCoord(merchant.latitude ?? null);
  const lng = parseCoord(merchant.longitude ?? null);
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

export function ShopsMapTab() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState('approved');
  const [merchants, setMerchants] = useState<OpsMerchant[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const key = mapsKey();

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await apiMerchants(status || undefined);
      setMerchants(r.merchants);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load shops');
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !key) return;
    let cancelled = false;
    const markers: Array<{ addListener?: unknown }> = [];

    void (async () => {
      try {
        const maps = await loadGoogleMaps(key);
        if (cancelled || !hostRef.current) return;
        const map = new maps.Map(hostRef.current, {
          center: SA_CENTER,
          zoom: 5,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
        });
        const info = new maps.InfoWindow();
        const geocoder = new maps.Geocoder();
        const bounds = new maps.LatLngBounds();
        let pinned = 0;
        let geocoded = 0;
        let skipped = 0;

        const addMarker = (shop: OpsMerchant, position: { lat: number; lng: number }) => {
          const marker = new maps.Marker({
            map,
            position,
            title: shop.businessName,
          });
          marker.addListener('click', () => {
            info.setContent(
              `<strong>${escapeHtml(shop.businessName)}</strong><br/>${escapeHtml(shop.location)}<br/><span>${escapeHtml((shop.approvalStatus ?? '').replace(/_/g, ' '))}</span>`,
            );
            info.open(map, marker);
          });
          bounds.extend(position);
          pinned += 1;
          markers.push(marker);
        };

        for (const shop of merchants) {
          const stored = pinFor(shop);
          if (stored) {
            addMarker(shop, stored);
            continue;
          }
          const query = geocodeQuery(shop.location);
          if (!query) {
            skipped += 1;
            continue;
          }
          const found = await new Promise<{ lat: number; lng: number } | null>((resolve) => {
            geocoder.geocode({ address: query, region: 'ZA' }, (results, geocodeStatus) => {
              const loc = results?.[0]?.geometry?.location;
              if (geocodeStatus !== 'OK' || !loc) {
                resolve(null);
                return;
              }
              resolve({ lat: loc.lat(), lng: loc.lng() });
            });
          });
          if (cancelled) return;
          if (!found) {
            skipped += 1;
            continue;
          }
          geocoded += 1;
          addMarker(shop, found);
          void apiSaveMerchantMapPin(shop.id, {
            latitude: found.lat,
            longitude: found.lng,
          }).catch(() => undefined);
        }

        if (pinned > 0) {
          map.fitBounds(bounds);
        }
        const bits = [`${pinned} shop${pinned === 1 ? '' : 's'} on the map`];
        if (geocoded) bits.push(`${geocoded} geocoded from address`);
        if (skipped) bits.push(`${skipped} need a more specific location`);
        setNotice(bits.join(' · '));
        setError('');
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not draw the map');
        }
      }
    })();

    return () => {
      cancelled = true;
      void markers;
    };
  }, [key, merchants]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Spaza shop map</h2>
        <button type="button" className="ghost" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Visible only in Ops. Pins use saved coordinates, or Google Geocoding of the
        shop location (South Africa). The merchant app never loads this map.
      </p>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="approved">Approved shops</option>
          <option value="pending_approval">Pending approval</option>
          <option value="pending_docs">Pending docs</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>
      {!key ? (
        <p className="error">
          Set <code>VITE_GOOGLE_MAPS_API_KEY</code> on the ops dashboard (Render env,
          HTTP referrer restricted to this ops host) and rebuild. Do not put the key
          on the merchant web app.
        </p>
      ) : (
        <div ref={hostRef} className="shops-map" role="region" aria-label="Spaza shop map" />
      )}
      {notice ? <p className="muted">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {merchants.length === 0 ? <p className="muted">No shops in this filter.</p> : null}
    </div>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

declare global {
  interface Window {
    __KASIPAY_GOOGLE_MAPS_KEY__?: string;
    google?: { maps: GoogleMaps };
  }
}
