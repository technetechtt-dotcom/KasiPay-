/**
 * Local-only dev seed. Registers a merchant + customer + agent via the public
 * API so the DB matches a real-world shape. Designed for the same machine your
 * dev API is running on. Reads BACKEND_PORT / SEED_BASE_URL when set.
 *
 * Usage:
 *   cd backend && node scripts/seed.mjs
 *   SEED_BASE_URL=http://localhost:8787 node scripts/seed.mjs
 */

const base = (process.env.SEED_BASE_URL || `http://localhost:${process.env.BACKEND_PORT || 8787}`).replace(/\/$/, '');

async function api(path, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    throw new Error(`${path} → ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

async function register(label, role, opts = {}) {
  const phone = `07${Math.floor(Math.random() * 9e8 + 1e8)}`;
  const body = {
    name: label,
    phone,
    pin: '4321',
    role,
    ...opts,
  };
  const res = await api('/api/register', { method: 'POST', body: JSON.stringify(body) });
  console.log(`  ✓ ${role} "${label}" → ${phone} (pin 4321)`);
  return { ...res, phone };
}

async function main() {
  console.log(`Seeding via ${base}…`);

  console.log('• Health:');
  const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    throw new Error(`API not reachable at ${base}. Start it with: npm run dev`);
  }
  console.log('  ✓ ok');

  console.log('• Accounts:');
  const merchant = await register('Demo Spaza Owner', 'merchant', {
    businessName: 'Demo Spaza',
    location: 'Soweto',
    category: 'Retail',
  });
  await register('Demo Customer', 'customer');
  await register('Demo Agent', 'agent');

  console.log('• Admin:');
  const { bootstrapAdmin } = await import('./bootstrap-admin.mjs');
  await bootstrapAdmin();

  console.log('• Inventory:');
  const seedProducts = [
    { name: 'White Bread', costPrice: 12, price: 18, stock: 40, category: 'Food', barcode: '6001234567890' },
    { name: 'Maize Meal 2kg', costPrice: 28, price: 39, stock: 25, category: 'Food', barcode: '6009105000426' },
    { name: 'Cooking Oil 750ml', costPrice: 38, price: 55, stock: 15, category: 'Food', barcode: '6001059901234' },
    { name: 'Sugar 1kg', costPrice: 18, price: 25, stock: 30, category: 'Food', barcode: '6001059900123' },
    { name: 'Airtime R10', costPrice: 9, price: 10, stock: 100, category: 'Airtime', barcode: '6001000000010' },
  ];
  for (const p of seedProducts) {
    await api('/api/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${merchant.token}` },
      body: JSON.stringify(p),
    });
    console.log(`  ✓ ${p.name} (R${p.price})`);
  }

  console.log('\nSeed complete. Sign in as:');
  console.log(`  merchant phone: ${merchant.phone}`);
  console.log('  admin phone:    0780000001 (unless ADMIN_BOOTSTRAP_PHONE set)');
  console.log('  pin:            4321');
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
