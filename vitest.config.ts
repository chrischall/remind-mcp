import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index.ts is the stdio bootstrap; server-boot.test.ts covers it by
      // spawning the real artifacts, which v8 coverage cannot attribute.
      exclude: ['src/index.ts'],
      // Branches sits below the others deliberately: the remaining uncovered
      // arms are the live-bridge paths (constructing a transport and lifting
      // headers from a real signed-in tab), which need a browser + the
      // Transporter extension and so cannot run in CI. They are exercised by
      // the manual bootstrap in docs/REMIND-API.md; everything reachable
      // without a browser is covered.
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
