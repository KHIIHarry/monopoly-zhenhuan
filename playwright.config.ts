const realStack = process.env.TASK7_REAL_STACK === '1';
const externalStack = process.env.PLAYWRIGHT_EXTERNAL_STACK === '1';
const webServer = {
  command: 'npm run dev -w @zhenhuan/web -- --hostname 127.0.0.1',
  url: 'http://127.0.0.1:3000',
  reuseExistingServer: realStack ? false : !process.env.CI,
  timeout: 120_000,
};

export default {
  tsconfig: 'tests/e2e/tsconfig.json',
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: realStack || externalStack ? 'http://localhost:3000' : 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false } },
    { name: 'desktop-firefox', use: { browserName: 'firefox', viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, hasTouch: false } },
    { name: 'desktop-webkit', use: { browserName: 'webkit', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false } },
    { name: 'android-chromium', use: { browserName: 'chromium', channel: 'chrome', viewport: { width: 360, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
    { name: 'iphone-webkit', use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
    { name: 'short-mobile-webkit', use: { browserName: 'webkit', viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  ],
  webServer: externalStack ? undefined : realStack ? [
    { command: 'npm run dev -w @zhenhuan/api', url: 'http://127.0.0.1:4000/health', reuseExistingServer: false, timeout: 120_000 },
    webServer,
  ] : webServer,
};
