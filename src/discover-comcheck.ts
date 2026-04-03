import { browserManager } from './browser/browser-manager';
import { ComdataAutomation } from './browser/comdata-automation';
import { Page } from 'playwright';
import fs from 'fs';
import path from 'path';

const DISCOVERY_DIR = path.resolve('./discovery');

async function scanPage(page: Page) {
  return await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
      placeholder: el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
      dataTestId: el.getAttribute('data-testid'),
      className: el.className,
      label: el.id
        ? document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || null
        : null,
      options:
        el.tagName === 'SELECT'
          ? Array.from((el as HTMLSelectElement).options).map((o) => ({
              value: o.value,
              text: o.text,
            }))
          : null,
    }));

    const buttons = Array.from(
      document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], a[role="button"], a.btn'
      )
    ).map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      type: el.getAttribute('type'),
      text: (el.textContent || '').trim().substring(0, 100),
      ariaLabel: el.getAttribute('aria-label'),
      className: el.className,
      href: el.getAttribute('href'),
      onclick: el.getAttribute('onclick')?.substring(0, 200) || null,
    }));

    const links = Array.from(document.querySelectorAll('a[href]'))
      .filter((a) => {
        const text = (a.textContent || '').toLowerCase();
        return (
          text.includes('check') ||
          text.includes('express') ||
          text.includes('comcheck') ||
          text.includes('comcheck') ||
          text.includes('fund') ||
          text.includes('issue') ||
          text.includes('create') ||
          text.includes('new')
        );
      })
      .map((a) => ({
        text: (a.textContent || '').trim().substring(0, 100),
        href: a.getAttribute('href'),
        id: a.id || null,
        className: a.className,
      }));

    const navItems = Array.from(
      document.querySelectorAll('nav a, .nav a, .menu a, .navbar a, [role="menuitem"], li > a')
    ).map((a) => ({
      text: (a.textContent || '').trim().substring(0, 100),
      href: a.getAttribute('href'),
      id: a.id || null,
      className: a.className,
    }));

    const forms = Array.from(document.querySelectorAll('form')).map((el) => ({
      id: el.id || null,
      action: el.action,
      method: el.method,
      className: el.className,
      inputCount: el.querySelectorAll('input, textarea, select').length,
    }));

    return {
      title: document.title,
      bodyText: document.body.innerText.substring(0, 3000),
      inputs,
      buttons,
      links,
      navItems,
      forms,
    };
  });
}

async function main() {
  console.log('=== Comcheck Discovery ===\n');
  fs.mkdirSync(DISCOVERY_DIR, { recursive: true });

  // Step 1: Log in
  await browserManager.initialize();
  const automation = new ComdataAutomation();
  const loginResult = await automation.login();

  if (!loginResult.success) {
    console.error('Login failed:', loginResult.message);
    await browserManager.close();
    return;
  }

  const page = await browserManager.getPage();
  console.log('\n=== Logged in. Scanning dashboard navigation... ===\n');

  // Step 2: Scan the dashboard for navigation clues
  await page.waitForTimeout(2000);
  const dashboardScan = await scanPage(page);

  console.log('--- Navigation items found ---');
  for (const nav of dashboardScan.navItems) {
    if (nav.text) {
      console.log(`  [${nav.text}] -> ${nav.href || 'no href'}`);
    }
  }

  console.log('\n--- Relevant links (check/express/fund/create) ---');
  for (const link of dashboardScan.links) {
    console.log(`  [${link.text}] -> ${link.href}`);
  }

  fs.writeFileSync(
    path.join(DISCOVERY_DIR, 'dashboard-nav-scan.json'),
    JSON.stringify(dashboardScan, null, 2)
  );
  console.log('\nSaved: discovery/dashboard-nav-scan.json');

  // Step 3: Monitor navigation and scan each new page
  console.log('\n=== Now navigate to the Comcheck page in the browser ===');
  console.log('I will automatically scan each page you visit.\n');

  let lastUrl = page.url();
  let scanCount = 0;

  for (let i = 0; i < 300; i++) {
    // 10 minutes
    await page.waitForTimeout(2000).catch(() => {});

    const currentUrl = page.url();
    if (currentUrl !== lastUrl) {
      scanCount++;
      console.log(`\n--- Page change detected (#${scanCount}) ---`);
      console.log(`URL: ${currentUrl}`);

      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);

      try {
        const scan = await scanPage(page);
        const filename = `page-scan-${scanCount}`;

        fs.writeFileSync(
          path.join(DISCOVERY_DIR, `${filename}.json`),
          JSON.stringify({ url: currentUrl, ...scan }, null, 2)
        );

        await page.screenshot({
          path: path.join(DISCOVERY_DIR, `${filename}.png`),
          fullPage: true,
        });

        console.log(`Inputs: ${scan.inputs.length}, Buttons: ${scan.buttons.length}, Forms: ${scan.forms.length}`);
        if (scan.inputs.length > 0) {
          console.log('Input fields:');
          for (const input of scan.inputs) {
            const label = input.label || input.placeholder || input.name || input.id || '(unnamed)';
            console.log(`  - ${label} [${input.tag}${input.type ? ' type=' + input.type : ''}] id=${input.id}, name=${input.name}`);
          }
        }
        if (scan.buttons.length > 0) {
          console.log('Buttons:');
          for (const btn of scan.buttons) {
            console.log(`  - "${btn.text}" [${btn.tag}] id=${btn.id}`);
          }
        }

        console.log(`Saved: discovery/${filename}.json + .png`);
      } catch (err) {
        console.log('Failed to scan page:', err);
      }

      lastUrl = currentUrl;
    }
  }

  console.log('\nDiscovery timeout. Closing browser.');
  await browserManager.close();
}

main().catch((error) => {
  console.error('Discovery failed:', error);
  browserManager.close();
  process.exit(1);
});
