import { Page } from 'playwright';
import { browserManager } from './browser-manager';
import { config } from '../config';
import fs from 'fs';
import path from 'path';

const DISCOVERY_DIR = path.resolve('./discovery');

interface InputInfo {
  tag: string;
  id: string | null;
  name: string | null;
  type: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  dataTestId: string | null;
  className: string;
  value: string;
}

interface ButtonInfo {
  tag: string;
  id: string | null;
  type: string | null;
  text: string;
  ariaLabel: string | null;
  dataTestId: string | null;
  className: string;
  href: string | null;
}

interface FormInfo {
  id: string | null;
  action: string;
  method: string;
  className: string;
  inputCount: number;
}

interface PageScan {
  url: string;
  title: string;
  timestamp: string;
  inputs: InputInfo[];
  buttons: ButtonInfo[];
  forms: FormInfo[];
}

async function scanPage(page: Page): Promise<PageScan> {
  const result = await page.evaluate(() => {
    const inputs: InputInfo[] = Array.from(document.querySelectorAll('input, textarea, select')).map(
      (el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        name: el.getAttribute('name'),
        type: el.getAttribute('type'),
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        dataTestId: el.getAttribute('data-testid'),
        className: el.className,
        value: (el as HTMLInputElement).value || '',
      })
    );

    const buttons: ButtonInfo[] = Array.from(
      document.querySelectorAll('button, input[type="submit"], a[role="button"], a.btn, a.button')
    ).map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      type: el.getAttribute('type'),
      text: (el.textContent || '').trim().substring(0, 100),
      ariaLabel: el.getAttribute('aria-label'),
      dataTestId: el.getAttribute('data-testid'),
      className: el.className,
      href: el.getAttribute('href'),
    }));

    const forms: FormInfo[] = Array.from(document.querySelectorAll('form')).map((el) => ({
      id: el.id || null,
      action: el.action,
      method: el.method,
      className: el.className,
      inputCount: el.querySelectorAll('input, textarea, select').length,
    }));

    return { inputs, buttons, forms };
  });

  return {
    url: page.url(),
    title: await page.title(),
    timestamp: new Date().toISOString(),
    ...result,
  };
}

function saveDiscovery(name: string, data: PageScan): void {
  const jsonPath = path.join(DISCOVERY_DIR, `${name}-selectors.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  console.log(`Saved: ${jsonPath}`);
}

async function screenshotDiscovery(page: Page, name: string): Promise<void> {
  const imgPath = path.join(DISCOVERY_DIR, `${name}.png`);
  await page.screenshot({ path: imgPath, fullPage: true });
  console.log(`Screenshot: ${imgPath}`);
}

async function waitForManualLogin(page: Page): Promise<void> {
  const startUrl = page.url();
  console.log('\n=== Waiting for manual login ===');
  console.log('Please log in manually in the browser window.');
  console.log('Polling for URL change or dashboard element...\n');

  for (let i = 0; i < 300; i++) {
    // 10 minutes max
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (currentUrl !== startUrl) {
      console.log(`URL changed: ${startUrl} -> ${currentUrl}`);
      await page.waitForLoadState('networkidle');
      return;
    }

    // Also check for common dashboard indicators
    const dashboardFound = await page
      .evaluate(() => {
        const body = document.body.innerText.toLowerCase();
        return (
          body.includes('dashboard') ||
          body.includes('welcome') ||
          body.includes('home') ||
          body.includes('logout') ||
          body.includes('sign out')
        );
      })
      .catch(() => false);

    if (dashboardFound && currentUrl !== startUrl) {
      console.log('Dashboard content detected.');
      return;
    }

    if (i % 15 === 0 && i > 0) {
      console.log(`Still waiting... (${Math.floor((i * 2) / 60)} minutes elapsed)`);
    }
  }

  console.log('Timeout waiting for login. Continuing with current page...');
}

async function promptForNavigation(page: Page, target: string): Promise<void> {
  console.log(`\n=== Please navigate to the ${target} page ===`);
  console.log('Waiting for you to navigate in the browser...');
  console.log('Polling for page change...\n');

  const startUrl = page.url();

  for (let i = 0; i < 150; i++) {
    // 5 minutes max
    await page.waitForTimeout(2000);

    if (page.url() !== startUrl) {
      console.log(`Navigated to: ${page.url()}`);
      await page.waitForLoadState('networkidle');
      return;
    }

    if (i % 15 === 0 && i > 0) {
      console.log(`Still waiting... (${Math.floor((i * 2) / 60)} minutes elapsed)`);
    }
  }

  console.log('Timeout. Scanning current page anyway...');
}

async function main() {
  console.log('=== Comdata Selector Discovery Utility ===\n');

  fs.mkdirSync(DISCOVERY_DIR, { recursive: true });

  await browserManager.initialize();
  const page = await browserManager.getPage();

  // Step 1: Scan the login page
  console.log('--- Step 1: Login Page ---');
  await page.goto(config.comdata.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const loginScan = await scanPage(page);
  saveDiscovery('login-page', loginScan);
  await screenshotDiscovery(page, 'login-page');

  console.log(`Found: ${loginScan.inputs.length} inputs, ${loginScan.buttons.length} buttons, ${loginScan.forms.length} forms`);

  // Step 2: Wait for manual login
  await waitForManualLogin(page);

  // Step 3: Scan the dashboard
  console.log('\n--- Step 2: Dashboard Page ---');
  await page.waitForTimeout(2000);

  const dashboardScan = await scanPage(page);
  saveDiscovery('dashboard', dashboardScan);
  await screenshotDiscovery(page, 'dashboard');

  console.log(`Found: ${dashboardScan.inputs.length} inputs, ${dashboardScan.buttons.length} buttons, ${dashboardScan.forms.length} forms`);

  // Step 4: Navigate to comcheck / express code form
  console.log('\n--- Step 3: Comcheck Form ---');
  console.log('Please navigate to the "create comcheck" or "express code" page.');
  await promptForNavigation(page, 'comcheck / express code');

  await page.waitForTimeout(2000);

  const comCheckScan = await scanPage(page);
  saveDiscovery('comcheck-form', comCheckScan);
  await screenshotDiscovery(page, 'comcheck-form');

  console.log(`Found: ${comCheckScan.inputs.length} inputs, ${comCheckScan.buttons.length} buttons, ${comCheckScan.forms.length} forms`);

  // Keep browser open
  console.log('\n=== Discovery complete ===');
  console.log(`All results saved to: ${DISCOVERY_DIR}/`);
  console.log('Browser will stay open for manual exploration.');
  console.log('Press Ctrl+C to exit.\n');

  // Keep alive indefinitely
  await new Promise(() => {});
}

main().catch((error) => {
  console.error('Discovery failed:', error);
  browserManager.close();
  process.exit(1);
});
