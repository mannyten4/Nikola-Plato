import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';

export interface BrowserManagerConfig {
  headless: boolean;
  userDataDir: string;
  slowMo?: number;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const SCREENSHOTS_DIR = path.resolve('./screenshots');

export class BrowserManager {
  private context: BrowserContext | null = null;
  private config: BrowserManagerConfig;

  constructor(config: BrowserManagerConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.context) {
      return;
    }

    const lockFile = path.join(this.config.userDataDir, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      throw new Error(
        `Browser data directory is locked — another instance may be running.\n` +
          `Lock file: ${lockFile}\n` +
          `If no other instance is running, delete this file and try again.`
      );
    }

    fs.mkdirSync(this.config.userDataDir, { recursive: true });
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // When headless is true, use --headless=new flag instead of Playwright's headless mode
    // to avoid the headless shell variant which has path issues in Docker
    const launchArgs = [
      '--disable-blink-features=AutomationControlled',
    ];
    
    if (this.config.headless) {
      launchArgs.push('--headless=new');
    }

    this.context = await chromium.launchPersistentContext(this.config.userDataDir, {
      headless: false,  // Always false, use --headless=new flag instead
      slowMo: this.config.slowMo,
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      args: launchArgs,
    });

    this.context.on('close', () => {
      this.context = null;
    });
  }

  async getPage(): Promise<Page> {
    if (!this.context) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    const pages = this.context.pages();
    if (pages.length > 0) {
      return pages[0];
    }

    return this.context.newPage();
  }

  async screenshot(name: string): Promise<string> {
    const page = await this.getPage();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${name}-${timestamp}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);

    await page.screenshot({ path: filepath, fullPage: true });
    console.log(`Screenshot saved: ${filepath}`);
    return filepath;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.context) return false;
    try {
      const pages = this.context.pages();
      if (pages.length === 0) return true; // No pages but context alive is fine
      await Promise.race([
        pages[0].evaluate(() => true),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5000)
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async ensureHealthy(): Promise<void> {
    if (!(await this.isHealthy())) {
      console.log('Browser unhealthy — restarting...');
      await this.restart();
    }
  }

  async exportCookies(): Promise<void> {
    if (!this.context) return;
    try {
      const cookies = await this.context.cookies();
      const cookiePath = path.join(this.config.userDataDir, 'cookies-backup.json');
      fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
    } catch {
      // Non-critical — don't fail the workflow
    }
  }

  async importCookies(): Promise<void> {
    if (!this.context) return;
    const cookiePath = path.join(this.config.userDataDir, 'cookies-backup.json');
    if (!fs.existsSync(cookiePath)) return;
    try {
      const raw = fs.readFileSync(cookiePath, 'utf-8');
      const cookies = JSON.parse(raw);
      await this.context.addCookies(cookies);
      console.log(`Imported ${cookies.length} cookies from backup.`);
    } catch {
      // Non-critical
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.exportCookies();
      await this.context.close();
      this.context = null;
    }
  }

  async restart(): Promise<void> {
    console.log('Restarting browser...');
    try {
      await this.close();
    } catch {
      // Browser may have already crashed — ignore close errors
    }
    this.context = null;
    await this.initialize();
    console.log('Browser restarted successfully.');
  }
}

// Singleton instance using config from environment
import { config } from '../config';

export const browserManager = new BrowserManager({
  headless: config.browser.headless,
  userDataDir: config.browser.dataDir,
  slowMo: config.browser.headless ? undefined : 100,
});
