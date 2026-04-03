import { Frame, Page } from 'playwright';
import { browserManager } from './browser-manager';

type Target = Page | Frame;

export function randomDelay(min = 500, max = 1500): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function humanDelay(target: Target, min = 500, max = 1500): Promise<void> {
  await target.waitForTimeout(randomDelay(min, max));
}

export async function waitAndClick(
  target: Target,
  selector: string,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 10000;
  const locator = target.locator(selector);
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
}

export async function waitAndFill(
  target: Target,
  selector: string,
  value: string,
  options?: { timeout?: number; delayMin?: number; delayMax?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 10000;
  const locator = target.locator(selector);
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await locator.fill('');
  await locator.pressSequentially(value, {
    delay: randomDelay(options?.delayMin ?? 30, options?.delayMax ?? 80),
  });
}

export async function waitForNavigation(
  page: Page,
  urlPattern?: string,
  timeout = 15000
): Promise<void> {
  if (urlPattern) {
    await page.waitForURL(`**${urlPattern}*`, { timeout });
  } else {
    await page.waitForLoadState('networkidle', { timeout });
  }
}

export async function getTextContent(
  target: Target,
  selector: string
): Promise<string | null> {
  try {
    const locator = target.locator(selector);
    const count = await locator.count();
    if (count === 0) return null;
    return await locator.first().textContent();
  } catch {
    return null;
  }
}

export async function screenshotWithContext(
  page: Page,
  name: string
): Promise<string> {
  const urlSlug = new URL(page.url()).pathname.replace(/\//g, '_').substring(0, 50);
  const fullName = `${name}-${urlSlug}`;
  return browserManager.screenshot(fullName);
}

export interface ErrorDetection {
  hasError: boolean;
  message: string | null;
}

export async function detectErrors(target: Target): Promise<ErrorDetection> {
  try {
    const result = await target.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();

      // Check for common error patterns
      const errorPatterns = [
        /error[:\s]+(.{1,100})/i,
        /session\s*(has\s*)?expired/i,
        /timed?\s*out/i,
        /unauthorized/i,
        /access\s*denied/i,
        /please\s*log\s*in\s*again/i,
        /invalid\s*session/i,
      ];

      for (const pattern of errorPatterns) {
        const match = document.body.innerText.match(pattern);
        if (match) {
          return { hasError: true, message: match[0].trim() };
        }
      }

      // Check for modal dialogs / alert overlays
      const modals = document.querySelectorAll(
        '.modal.show, .modal[style*="display: block"], [role="alertdialog"], .alert-danger, .alert-error'
      );
      for (const modal of Array.from(modals)) {
        const text = modal.textContent?.trim();
        if (text) {
          return { hasError: true, message: text.substring(0, 200) };
        }
      }

      // Check if we've been redirected to a login page
      if (
        bodyText.includes('sign in') &&
        bodyText.includes('password') &&
        bodyText.includes('user')
      ) {
        return { hasError: true, message: 'Session expired — redirected to login page' };
      }

      return { hasError: false, message: null };
    });

    return result;
  } catch {
    return { hasError: true, message: 'Page not responsive — possible crash' };
  }
}

function timestamp(): string {
  return new Date().toISOString().substring(11, 19);
}

export function log(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
}
