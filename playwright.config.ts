import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:1421',
    channel: 'msedge',
    viewport: { width: 1120, height: 720 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 1421 --strictPort',
    url: 'http://127.0.0.1:1421',
    reuseExistingServer: false,
  },
});
