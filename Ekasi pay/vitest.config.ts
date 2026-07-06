import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // The backend has its own `node:test` suite that vitest cannot
    // introspect. Keep frontend vitest scoped to src/ so it doesn't
    // pick those files up.
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', 'backend/**'],
  },
});
