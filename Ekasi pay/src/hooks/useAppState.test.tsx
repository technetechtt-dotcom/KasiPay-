import { act, renderHook, waitFor } from '@testing-library/react';
import { setToken } from '../services/api';
import { useAppState } from './useAppState';

describe('useAppState with API', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    setToken(null);
    vi.unstubAllGlobals();
  });

  it('starts unauthenticated when no token', async () => {
    const { result } = renderHook(() => useAppState());

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('hydrates session when a valid token is stored', async () => {
    setToken('fake-jwt');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.endsWith('/api/me')) {
          return new Response(
            JSON.stringify({
              user: {
                id: 'u1',
                name: 'Test User',
                phone: '0820000000',
                role: 'customer',
                kycStatus: 'pending',
                accountTier: 'Basic',
                countryCode: 'ZA',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            }),
            { status: 200 }
          );
        }
        if (u.includes('/api/wallets/me')) {
          return new Response(
            JSON.stringify({
              wallet: {
                id: 'w1',
                userId: 'u1',
                balance: 100,
                currency: 'ZAR',
                status: 'active',
                poolId: 'ZA',
                walletKind: 'user',
              },
            }),
            { status: 200 }
          );
        }
        if (u.includes('/api/transactions/me')) {
          return new Response(JSON.stringify({ transactions: [] }), {
            status: 200,
          });
        }
        if (u.includes('/api/ledger/me')) {
          return new Response(JSON.stringify({ ledger: [] }), { status: 200 });
        }
        if (u.includes('/api/merchants/me')) {
          return new Response(JSON.stringify({ merchant: null }), {
            status: 200,
          });
        }
        if (u.includes('/api/loadshedding')) {
          return new Response(JSON.stringify({ slots: [] }), { status: 200 });
        }
        if (u.includes('/api/suppliers')) {
          return new Response(JSON.stringify({ suppliers: [] }), { status: 200 });
        }
        if (u.includes('/api/supplier-verifications')) {
          return new Response(JSON.stringify({ verifications: [] }), {
            status: 200,
          });
        }
        if (u.includes('/api/loans/me')) {
          return new Response(JSON.stringify({ loans: [] }), { status: 200 });
        }
        if (u.includes('/api/compliance/me')) {
          return new Response(JSON.stringify({ flags: [] }), { status: 200 });
        }
        if (u.includes('/api/cash-send/me')) {
          return new Response(JSON.stringify({ vouchers: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'test unmocked ' + u }), {
          status: 404,
        });
      })
    );

    const { result } = renderHook(() => useAppState());

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.currentUser?.name).toBe('Test User');
    expect(result.current.getMyWallet()?.balance).toBe(100);
  });

  it('logs in with phone and PIN against the API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u.endsWith('/api/login')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            phone: string;
            pin: string;
          };
          if (body.pin !== '1234') {
            return new Response(JSON.stringify({ error: 'Invalid' }), {
              status: 401,
            });
          }
          return new Response(
            JSON.stringify({
              token: 't1',
              refreshToken: 'refresh-test-token',
              user: {
                id: 'u2',
                name: 'Merchant',
                phone: body.phone,
                role: 'merchant',
                kycStatus: 'verified',
                accountTier: 'Premium',
                countryCode: 'ZA',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            }),
            { status: 200 }
          );
        }
        if (u.includes('/api/wallets/me')) {
          return new Response(
            JSON.stringify({
              wallet: {
                id: 'w2',
                userId: 'u2',
                balance: 50,
                currency: 'ZAR',
                status: 'active',
                poolId: 'ZA',
                walletKind: 'user',
              },
            }),
            { status: 200 }
          );
        }
        if (u.includes('/api/transactions/me')) {
          return new Response(JSON.stringify({ transactions: [] }), {
            status: 200,
          });
        }
        if (u.includes('/api/ledger/me')) {
          return new Response(JSON.stringify({ ledger: [] }), { status: 200 });
        }
        if (u.includes('/api/merchants/me')) {
          return new Response(
            JSON.stringify({
              merchant: {
                id: 'm1',
                userId: 'u2',
                businessName: 'Test Shop',
                location: 'JHB',
                category: 'Retail',
              },
            }),
            { status: 200 }
          );
        }
        if (u.includes('/api/products?')) {
          return new Response(JSON.stringify({ products: [] }), {
            status: 200,
          });
        }
        if (u.endsWith('/api/sales') && init?.method !== 'POST') {
          return new Response(JSON.stringify({ sales: [] }), { status: 200 });
        }
        if (u.endsWith('/api/expenses')) {
          return new Response(JSON.stringify({ expenses: [] }), {
            status: 200,
          });
        }
        if (u.includes('/api/credit/customers')) {
          return new Response(JSON.stringify({ customers: [] }), {
            status: 200,
          });
        }
        if (u.includes('/api/credit/transactions')) {
          return new Response(JSON.stringify({ transactions: [] }), {
            status: 200,
          });
        }
        if (u.includes('/api/loadshedding')) {
          return new Response(JSON.stringify({ slots: [] }), { status: 200 });
        }
        if (u.includes('/api/suppliers')) {
          return new Response(JSON.stringify({ suppliers: [] }), { status: 200 });
        }
        if (u.includes('/api/supplier-verifications')) {
          return new Response(JSON.stringify({ verifications: [] }), {
            status: 200,
          });
        }
        if (u.includes('/api/loans/me')) {
          return new Response(JSON.stringify({ loans: [] }), { status: 200 });
        }
        if (u.includes('/api/compliance/me')) {
          return new Response(JSON.stringify({ flags: [] }), { status: 200 });
        }
        if (u.includes('/api/cash-send/me')) {
          return new Response(JSON.stringify({ vouchers: [] }), { status: 200 });
        }
        if (u.includes('/api/supplier-orders')) {
          return new Response(JSON.stringify({ orders: [] }), { status: 200 });
        }
        if (u.includes('/api/stokvel')) {
          return new Response(JSON.stringify({ groups: [] }), { status: 200 });
        }
        if (u.includes('/api/layby')) {
          return new Response(JSON.stringify({ orders: [] }), { status: 200 });
        }
        if (u.includes('/api/price-comparisons')) {
          return new Response(JSON.stringify({ comparisons: [] }), {
            status: 200,
          });
        }
        if (u.includes('/api/insurance')) {
          return new Response(JSON.stringify({ policies: [] }), { status: 200 });
        }
        if (u.includes('/api/voice-notes')) {
          return new Response(JSON.stringify({ notes: [] }), { status: 200 });
        }
        if (u.includes('/api/expiry-items')) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (u.includes('/api/food-safety-alerts')) {
          return new Response(JSON.stringify({ alerts: [] }), { status: 200 });
        }
        if (u.includes('/api/stock-movements')) {
          return new Response(JSON.stringify({ movements: [] }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ error: 'unmocked ' + u }), {
          status: 404,
        });
      })
    );

    const { result } = renderHook(() => useAppState());

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    await act(async () => {
      expect(result.current.loginStep1('0829999999')).toBe(true);
    });
    await act(async () => {
      const ok = await result.current.loginStep2('1234');
      expect(ok).toBe(true);
    });

    expect(result.current.isAuthenticated).toBe(true);
    await waitFor(() => {
      expect(result.current.merchantProfile?.businessName).toBe('Test Shop');
    });
  });

  it('locks out after 5 bad PIN attempts and exposes pinLockedUntil', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.endsWith('/api/login')) {
          return new Response(JSON.stringify({ error: 'Invalid' }), {
            status: 401,
          });
        }
        return new Response('{}', { status: 200 });
      }),
    );

    const { result } = renderHook(() => useAppState());
    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    await act(async () => {
      result.current.loginStep1('0829999999');
    });

    // First four bad PINs increment the counter without locking.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        const ok = await result.current.loginStep2('0000');
        expect(ok).toBe(false);
      });
    }
    expect(result.current.failedPinAttempts).toBe(4);
    expect(result.current.pinLockedUntil).toBeNull();

    // Fifth attempt trips the lockout, resets the counter to 0, and
    // populates `pinLockedUntil` with a timestamp ~5 min in the future.
    const before = Date.now();
    await act(async () => {
      const ok = await result.current.loginStep2('0000');
      expect(ok).toBe(false);
    });
    expect(result.current.failedPinAttempts).toBe(0);
    expect(result.current.pinLockedUntil).not.toBeNull();
    const lockMs = (result.current.pinLockedUntil ?? 0) - before;
    expect(lockMs).toBeGreaterThanOrEqual(4 * 60 * 1000);
    expect(lockMs).toBeLessThanOrEqual(6 * 60 * 1000);

    // While locked, even submitting the correct PIN is refused without
    // touching the API.
    await act(async () => {
      const ok = await result.current.loginStep2('1234');
      expect(ok).toBe(false);
    });
  });
});
