import { browserManager } from './browser/browser-manager';
import { ComdataAutomation } from './browser/comdata-automation';
import { Frame } from 'playwright';
import fs from 'fs';
import path from 'path';

const DISCOVERY_DIR = path.resolve('./discovery');

async function scanFrame(frame: Frame) {
  return await frame.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map((el) => {
      const tag = el.tagName.toLowerCase();
      let label: string | null = null;

      // Try to find label by for attribute
      if (el.id) {
        label = document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || null;
      }
      // Try previous sibling or parent text
      if (!label) {
        const prev = el.previousElementSibling;
        if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'TD')) {
          label = prev.textContent?.trim() || null;
        }
      }
      // Try parent TD's previous TD
      if (!label && el.closest('td')) {
        const td = el.closest('td');
        const prevTd = td?.previousElementSibling;
        if (prevTd) {
          label = prevTd.textContent?.trim() || null;
        }
      }

      return {
        tag,
        id: el.id || null,
        name: el.getAttribute('name'),
        type: el.getAttribute('type'),
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        className: el.className,
        value: (el as HTMLInputElement).value || '',
        label,
        disabled: (el as HTMLInputElement).disabled,
        readonly: el.hasAttribute('readonly'),
        options:
          tag === 'select'
            ? Array.from((el as HTMLSelectElement).options).map((o) => ({
                value: o.value,
                text: o.text.trim(),
                selected: o.selected,
              }))
            : null,
      };
    });

    const buttons = Array.from(
      document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], a.button, a.btn, [onclick]'
      )
    )
      .filter((el) => {
        // Filter out inputs already captured
        const tag = el.tagName.toLowerCase();
        if (tag === 'input') {
          const type = el.getAttribute('type');
          return type === 'submit' || type === 'button';
        }
        return true;
      })
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        type: el.getAttribute('type'),
        text: (el.textContent || '').trim().substring(0, 100),
        value: el.getAttribute('value'),
        className: el.className,
        href: el.getAttribute('href'),
        onclick: el.getAttribute('onclick')?.substring(0, 300) || null,
        name: el.getAttribute('name'),
      }));

    const forms = Array.from(document.querySelectorAll('form')).map((el) => ({
      id: el.id || null,
      name: el.getAttribute('name'),
      action: el.action,
      method: el.method,
      className: el.className,
      inputCount: el.querySelectorAll('input, textarea, select').length,
    }));

    const tables = Array.from(document.querySelectorAll('table')).map((table) => ({
      id: table.id || null,
      className: table.className,
      rows: table.rows.length,
      headerText: Array.from(table.querySelectorAll('th'))
        .map((th) => th.textContent?.trim())
        .filter(Boolean)
        .join(', '),
    }));

    return {
      url: window.location.href,
      title: document.title,
      bodyText: document.body.innerText.substring(0, 5000),
      inputs,
      buttons,
      forms,
      tables,
    };
  });
}

async function main() {
  console.log('=== iframe Scanner for Express Check Form ===\n');
  fs.mkdirSync(DISCOVERY_DIR, { recursive: true });

  await browserManager.initialize();
  const automation = new ComdataAutomation();
  const loginResult = await automation.login();

  if (!loginResult.success) {
    console.error('Login failed:', loginResult.message);
    await browserManager.close();
    return;
  }

  const page = await browserManager.getPage();
  console.log('\nLogged in. Navigating to Express Check...\n');

  // Navigate directly to Express Check page (menu item uses onclick with this URL)
  await page.goto('https://w6.iconnectdata.com/Login/leftNav?LVL1=manage&LVL2=express_chk', {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(3000);

  // Look for the left nav option "Request Express Check Code" or similar
  // From the screenshot, we saw left sidebar links
  console.log('Looking for Express Check sub-menu...\n');

  // Scan all frames
  const allFrames = page.frames();
  console.log(`Found ${allFrames.length} frames total.\n`);

  for (let i = 0; i < allFrames.length; i++) {
    const frame = allFrames[i];
    const frameUrl = frame.url();
    console.log(`--- Frame ${i}: ${frameUrl} ---`);

    if (frameUrl === 'about:blank' || !frameUrl) continue;

    try {
      const scan = await scanFrame(frame);
      const filename = `iframe-scan-${i}`;

      fs.writeFileSync(
        path.join(DISCOVERY_DIR, `${filename}.json`),
        JSON.stringify(scan, null, 2)
      );

      console.log(`Inputs: ${scan.inputs.length}, Buttons: ${scan.buttons.length}, Forms: ${scan.forms.length}, Tables: ${scan.tables.length}`);

      if (scan.inputs.length > 0) {
        console.log('\nInput fields:');
        for (const input of scan.inputs) {
          const label = input.label || input.placeholder || input.name || input.id || '(unnamed)';
          console.log(
            `  ${label} | tag=${input.tag} type=${input.type} id="${input.id}" name="${input.name}" value="${input.value}" disabled=${input.disabled}${input.options ? ` options=[${input.options.map((o) => `${o.value}:${o.text}`).join(', ')}]` : ''}`
          );
        }
      }

      if (scan.buttons.length > 0) {
        console.log('\nButtons:');
        for (const btn of scan.buttons) {
          console.log(
            `  "${btn.text || btn.value}" | tag=${btn.tag} id="${btn.id}" name="${btn.name}" onclick="${btn.onclick || 'none'}"`
          );
        }
      }

      if (scan.forms.length > 0) {
        console.log('\nForms:');
        for (const form of scan.forms) {
          console.log(
            `  id="${form.id}" name="${form.name}" action="${form.action}" method="${form.method}" inputs=${form.inputCount}`
          );
        }
      }

      console.log('');
    } catch (err) {
      console.log(`  Could not scan frame: ${err}\n`);
    }
  }

  // Now try clicking into "Request Express Check Code" via the left nav iframe
  console.log('=== Attempting to click "Request Express Check Code" link... ===\n');

  // Try finding the link in any frame
  let found = false;
  for (const frame of page.frames()) {
    try {
      const link = frame.locator('a:has-text("Request Express Check Code"), a:has-text("Request Express"), a:has-text("Retrieve")');
      if (await link.count() > 0) {
        console.log(`Found link in frame: ${frame.url()}`);
        await link.first().click();
        found = true;
        break;
      }
    } catch {
      // continue
    }
  }

  if (!found) {
    // Try main page
    const link = page.locator('a:has-text("Request Express Check Code"), a:has-text("Request Express")');
    if (await link.count() > 0) {
      await link.first().click();
      found = true;
    }
  }

  if (found) {
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    console.log('\n=== Scanning frames after clicking Request Express Check Code ===\n');

    const frames2 = page.frames();
    console.log(`Found ${frames2.length} frames.\n`);

    for (let i = 0; i < frames2.length; i++) {
      const frame = frames2[i];
      const frameUrl = frame.url();
      console.log(`--- Frame ${i}: ${frameUrl} ---`);

      if (frameUrl === 'about:blank' || !frameUrl) continue;

      try {
        const scan = await scanFrame(frame);
        const filename = `iframe-comcheck-${i}`;

        fs.writeFileSync(
          path.join(DISCOVERY_DIR, `${filename}.json`),
          JSON.stringify(scan, null, 2)
        );

        await frame.locator('body').screenshot({
          path: path.join(DISCOVERY_DIR, `${filename}.png`),
        }).catch(() => {});

        console.log(`Inputs: ${scan.inputs.length}, Buttons: ${scan.buttons.length}, Forms: ${scan.forms.length}`);

        if (scan.inputs.length > 0) {
          console.log('\nInput fields:');
          for (const input of scan.inputs) {
            const label = input.label || input.placeholder || input.name || input.id || '(unnamed)';
            console.log(
              `  ${label} | tag=${input.tag} type=${input.type} id="${input.id}" name="${input.name}" value="${input.value}" disabled=${input.disabled}${input.options ? ` options=[${input.options.map((o) => `${o.value}:${o.text}`).join(', ')}]` : ''}`
            );
          }
        }

        if (scan.buttons.length > 0) {
          console.log('\nButtons:');
          for (const btn of scan.buttons) {
            console.log(
              `  "${btn.text || btn.value}" | tag=${btn.tag} id="${btn.id}" name="${btn.name}" onclick="${btn.onclick || 'none'}"`
            );
          }
        }

        console.log('');
      } catch (err) {
        console.log(`  Could not scan: ${err}\n`);
      }
    }
  } else {
    console.log('Could not find the link. Keeping browser open for manual navigation.\n');
  }

  // Take a full page screenshot
  await page.screenshot({
    path: path.join(DISCOVERY_DIR, 'express-check-full.png'),
    fullPage: true,
  });
  console.log('Saved: discovery/express-check-full.png');

  console.log('\nBrowser staying open for 60 seconds for inspection...');
  await new Promise((resolve) => setTimeout(resolve, 60000));

  await browserManager.close();
  console.log('Done.');
}

main().catch((error) => {
  console.error('Discovery failed:', error);
  browserManager.close();
  process.exit(1);
});
