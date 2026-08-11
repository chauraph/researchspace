import { defineConfig, devices } from '@playwright/test';

// Point at whichever instance you want to inspect.
//   RS_BASE_URL=http://127.0.0.1:10214   (default, local dev)
const baseURL = process.env.RS_BASE_URL ?? 'http://127.0.0.1:10214';

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  // Probes read shared state; never run them against each other in parallel.
  fullyParallel: false,
  workers: 1,
  // A probe reports, it does not gate anything — never retry, never fail a build.
  retries: 0,
  reporter: [['list']],
  outputDir: './output',
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 90_000,
  },
  projects: [
    { name: 'auth', testMatch: /auth\.setup\.ts/ },
    {
      name: 'probe',
      testIgnore: /\.standalone\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: '.auth/user.json' },
      dependencies: ['auth'],
    },
    {
      // Probes that need no ResearchSpace stack and no login — they serve
      // everything themselves via route interception (e.g. the SAM2 WebGPU probe).
      name: 'standalone',
      testMatch: /\.standalone\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
