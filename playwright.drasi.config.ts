import { defineConfig, devices } from '@playwright/test';

if (!process.env.DRASI_UI_URL || !process.env.DRASI_FIXTURE_MANIFEST) {
  throw new Error(
    'Set DRASI_UI_URL to this fork’s Go gateway and DRASI_FIXTURE_MANIFEST to the live native server fixture manifest.',
  );
}

export default defineConfig({
  testDir: './tests/drasi',
  timeout: 180_000,
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
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'real native gateway', use: { ...devices['Desktop Chrome'] } },
  ],
});
