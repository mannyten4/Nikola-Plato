import { Page } from 'playwright';
import { browserManager } from './browser-manager';
import { log } from './page-helpers';

class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

export class SessionGuard {
  private mutex = new Mutex();

  async withSession<T>(action: () => Promise<T>): Promise<T> {
    await this.mutex.acquire();
    log('Mutex acquired');

    try {
      // Check browser health first
      const healthy = await browserManager.isHealthy();
      if (!healthy) {
        log('Browser unhealthy — restarting...');
        await browserManager.ensureHealthy();
      }

      // Ensure session is valid
      await this.ensureSession();

      // Run the action
      const result = await action();

      // Export cookies as backup after successful action
      await browserManager.exportCookies();

      return result;
    } finally {
      log('Mutex released');
      this.mutex.release();
    }
  }

  async ensureSession(): Promise<void> {
    const page = await browserManager.getPage();

    // Check if session is expired
    if (await this.isSessionExpired(page)) {
      log('Session expired — re-authenticating...');

      // Lazy import to avoid circular dependency
      const { ComdataAutomation } = await import('./comdata-automation');
      const automation = new ComdataAutomation();
      const result = await automation.login();

      if (!result.success) {
        throw new Error(`Re-authentication failed: ${result.message}`);
      }

      log('Re-authentication successful');
      await browserManager.exportCookies();
      return;
    }

    // Check if we're logged in at all
    const { ComdataAutomation } = await import('./comdata-automation');
    const automation = new ComdataAutomation();

    if (!(await automation.isLoggedIn())) {
      log('Not logged in — authenticating...');
      const result = await automation.login();

      if (!result.success) {
        throw new Error(`Authentication failed: ${result.message}`);
      }

      log('Authentication successful');
      await browserManager.exportCookies();
    } else {
      log('Session valid');
    }
  }

  private async isSessionExpired(page: Page): Promise<boolean> {
    const url = page.url();

    // Redirected to login page = session expired
    if (
      url.includes('/Login/init') ||
      url.includes('/Login/login')
    ) {
      return true;
    }

    // Check for session expiry messages in the page
    try {
      const expired = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes('session expired') ||
          text.includes('session has expired') ||
          text.includes('session timed out') ||
          text.includes('please log in again') ||
          text.includes('your session has ended')
        );
      });
      return expired;
    } catch {
      // Page not responsive = likely expired/crashed
      return true;
    }
  }
}

export const sessionGuard = new SessionGuard();
