import { defineConfig, devices } from '@playwright/test';

if (
  process.env.DRASI_POSTGRES_E2E !== '1' ||
  !process.env.DRASI_UI_URL ||
  !process.env.DRASI_FIXTURE_MANIFEST
) {
  throw new Error(
    'Positive PostgreSQL proof requires DRASI_POSTGRES_E2E=1, a real gateway and a private compatible signed fixture.',
  );
}

export default defineConfig({
  testDir: './tests/drasi-postgres',
  testMatch: '**/postgres-ui.spec.ts',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.DRASI_UI_URL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    timezoneId: 'UTC',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'real signed PostgreSQL gateway',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
