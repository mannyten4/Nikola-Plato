import { Frame, Page } from 'playwright';
import { WebClient } from '@slack/web-api';
import { browserManager } from './browser-manager';
import { selectors } from './selectors';
import { TwoFactorHandler } from './two-factor-handler';
import { config } from '../config';
import { ComCheckRequest, ComCheckResult, LoginResult } from '../types';
import { randomDelay, humanDelay, waitAndFill, detectErrors, log } from './page-helpers';
import { sessionGuard } from './session-guard';

export class ComdataAutomation {
  private slackClient: WebClient | null = null;

  setSlackClient(client: WebClient): void {
    this.slackClient = client;
  }
  async isLoggedIn(): Promise<boolean> {
    const page = await browserManager.getPage();
    try {
      // Check if we're on the dashboard URL or can see the Logout button
      if (page.url().includes(selectors.login.dashboard.dashboardUrl)) {
        return true;
      }
      await page.waitForSelector(selectors.login.dashboard.logoutButton, {
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async login(retries = 2): Promise<LoginResult> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await this.attemptLogin();
        if (result.success) {
          return result;
        }

        if (attempt < retries) {
          console.log(`Login attempt ${attempt + 1} failed: ${result.message}. Retrying in 5s...`);
          const page = await browserManager.getPage();
          await page.waitForTimeout(5000);
        } else {
          return result;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < retries) {
          console.log(`Login attempt ${attempt + 1} threw error: ${message}. Retrying in 5s...`);
          const page = await browserManager.getPage();
          await page.waitForTimeout(5000);
        } else {
          return { success: false, message: `Login failed after ${retries + 1} attempts: ${message}` };
        }
      }
    }

    return { success: false, message: 'Login failed — exhausted all retries' };
  }

  private async attemptLogin(): Promise<LoginResult> {
    const page = await browserManager.getPage();

    // Check if already logged in
    if (await this.isLoggedIn()) {
      console.log('Already logged in — skipping login.');
      await browserManager.screenshot('already-logged-in');
      return { success: true, message: 'Already logged in' };
    }

    // === STEP 1: User ID page ===
    console.log(`Navigating to ${config.comdata.url}...`);
    await page.goto(config.comdata.url, { waitUntil: 'networkidle' });
    await browserManager.screenshot('01-landing-page');
    await humanDelay(page);

    // Check if we landed directly on the Okta sign-in (step 2) or the user ID page (step 1)
    const onOktaPage = await page.locator(selectors.login.step2.passwordField).isVisible().catch(() => false);

    if (!onOktaPage) {
      // We're on Step 1 — enter User ID and click Continue
      console.log('Step 1: Entering User ID...');
      const usernameField = page.locator(selectors.login.step1.usernameField);
      await usernameField.click();
      await usernameField.fill('');
      await usernameField.pressSequentially(config.comdata.username, {
        delay: randomDelay(50, 120),
      });
      await humanDelay(page);
      await browserManager.screenshot('02-userid-entered');

      console.log('Step 1: Clicking Continue...');
      await page.locator(selectors.login.step1.continueButton).click();
      await page.waitForLoadState('networkidle');
      await humanDelay(page);
      await browserManager.screenshot('03-after-continue');
    }

    // === STEP 2: Okta Sign In page ===
    console.log('Step 2: Waiting for Okta sign-in form...');
    await page.waitForSelector(selectors.login.step2.passwordField, { timeout: 10000 });
    await humanDelay(page);

    // Username may already be pre-filled from step 1; clear and re-enter to be safe
    console.log('Step 2: Entering credentials...');
    const oktaUsername = page.locator(selectors.login.step2.usernameField);
    await oktaUsername.click();
    await oktaUsername.fill('');
    await oktaUsername.pressSequentially(config.comdata.username, {
      delay: randomDelay(50, 120),
    });
    await humanDelay(page);

    const oktaPassword = page.locator(selectors.login.step2.passwordField);
    await oktaPassword.click();
    await oktaPassword.fill('');
    await oktaPassword.pressSequentially(config.comdata.password, {
      delay: randomDelay(30, 80),
    });
    await humanDelay(page);
    await browserManager.screenshot('04-credentials-entered');

    // Click Sign In
    console.log('Step 2: Clicking Sign In...');
    await page.locator(selectors.login.step2.submitButton).click();
    await page.waitForLoadState('networkidle');
    await humanDelay(page);
    await browserManager.screenshot('05-after-signin');

    // === Check for 2FA ===
    const mfaVisible = await page
      .locator(selectors.twoFactor.pageIndicator)
      .isVisible()
      .catch(() => false);

    if (mfaVisible) {
      await browserManager.screenshot('06-2fa-detected');

      if (this.slackClient) {
        const twoFactorHandler = new TwoFactorHandler(page, this.slackClient);
        const resolved = await twoFactorHandler.handle();
        if (!resolved) {
          return { success: false, message: '2FA could not be completed' };
        }
      } else {
        // No Slack client available — fall back to console-only wait
        console.log('2FA required — no Slack client configured, waiting 120s for manual completion');
        const mfaCompleted = await this.waitForMfaCompletion(page, 120);
        if (!mfaCompleted) {
          return { success: false, message: '2FA was not completed within 120 seconds' };
        }
      }

      await browserManager.screenshot('07-2fa-completed');
    }

    // === Verify dashboard ===
    await humanDelay(page);

    // Wait a bit longer for the dashboard to load after login/MFA
    try {
      await page.waitForURL(`**${selectors.login.dashboard.dashboardUrl}*`, { timeout: 15000 });
    } catch {
      // URL check failed, try the logout button as fallback
    }

    if (await this.isLoggedIn()) {
      await browserManager.screenshot('08-login-success');
      console.log('Login successful!');
      return { success: true, message: 'Login successful' };
    }

    await browserManager.screenshot('08-login-failed');
    return { success: false, message: 'Login submitted but dashboard not detected' };
  }

  private async waitForMfaCompletion(page: Page, timeoutSeconds: number): Promise<boolean> {
    const pollInterval = 2000;
    const maxAttempts = Math.ceil((timeoutSeconds * 1000) / pollInterval);

    for (let i = 0; i < maxAttempts; i++) {
      await page.waitForTimeout(pollInterval);

      // Check if we've reached the dashboard
      if (page.url().includes(selectors.login.dashboard.dashboardUrl)) {
        return true;
      }

      const stillVisible = await page
        .locator(selectors.twoFactor.pageIndicator)
        .isVisible()
        .catch(() => false);

      if (!stillVisible) {
        return true;
      }
    }

    return false;
  }

  async navigateToExpressCheck(): Promise<Frame> {
    const page = await browserManager.getPage();

    // Navigate to Express Check left nav
    console.log('Navigating to Express Check...');
    await page.goto(
      `https://w6.iconnectdata.com${selectors.navigation.expressCheckUrl}`,
      { waitUntil: 'networkidle' }
    );
    await page.waitForTimeout(2000);

    // Click "Request Express Check Code" in the left nav sidebar
    console.log('Clicking "Request Express Check Code"...');
    const requestLink = page.locator(selectors.navigation.requestExpressCheckLink);
    await requestLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Find the iframe containing the form
    const comCheckFrame = await this.getComCheckFrame(page);
    if (!comCheckFrame) {
      throw new Error('Could not find Express Check form iframe');
    }

    return comCheckFrame;
  }

  private async getComCheckFrame(page: Page): Promise<Frame | null> {
    for (const frame of page.frames()) {
      if (frame.url().includes(selectors.comCheck.iframeUrl)) {
        return frame;
      }
    }
    return null;
  }

  async createComCheck(request: ComCheckRequest): Promise<ComCheckResult> {
    if (config.mockBrowser) {
      console.log('[MOCK] Simulating comcheck creation:', request);
      await new Promise(resolve => setTimeout(resolve, 1500));
      return {
        expressCode: `MOCK-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
        confirmationNumber: `MOCK-CONF-${Date.now()}`,
        amount: request.amount,
        createdAt: new Date(),
      };
    }

    return sessionGuard.withSession(async () => {
      const page = await browserManager.getPage();

      // Navigate to the Express Check form
      const frame = await this.navigateToExpressCheck();
      await browserManager.screenshot('comcheck-01-form-loaded');
      log('Express Check form loaded.');

      // Wait for the amount field to be ready inside the iframe
      await frame.waitForSelector(selectors.comCheck.amount, { timeout: 10000 });
      await humanDelay(page);

      // Fill form fields
      log(`Entering amount: ${request.amount}...`);
      await waitAndFill(frame, selectors.comCheck.amount, request.amount.toFixed(2));
      await humanDelay(page);

      log(`Entering driver last name: ${request.driverLastName}...`);
      await waitAndFill(frame, selectors.comCheck.driverLastName, request.driverLastName);
      await humanDelay(page);

      log(`Entering driver first name: ${request.driverFirstName}...`);
      await waitAndFill(frame, selectors.comCheck.driverFirstName, request.driverFirstName);
      await humanDelay(page);

      // Fees plus/less (required — default to "P")
      const feePlusLess = request.feePlusLess || 'P';
      log(`Entering fee plus/less: ${feePlusLess}...`);
      await waitAndFill(frame, selectors.comCheck.feePlusLess, feePlusLess);
      await humanDelay(page);

      // Optional fields
      if (request.unitNumber) {
        log(`Entering unit number: ${request.unitNumber}...`);
        await waitAndFill(frame, selectors.comCheck.unitNumber, request.unitNumber);
        await humanDelay(page);
      }

      if (request.purposeCode) {
        log(`Entering purpose code: ${request.purposeCode}...`);
        await waitAndFill(frame, selectors.comCheck.purposeCode, request.purposeCode);
        await humanDelay(page);
      }

      await browserManager.screenshot('comcheck-02-form-filled');
      log('Form filled. Clicking "Retrieve Code"...');

      // Click Retrieve Code
      await frame.locator(selectors.comCheck.retrieveCodeButton).click();
      await page.waitForTimeout(5000);
      await browserManager.screenshot('comcheck-03-after-retrieve');

      // Check for errors before parsing
      const errors = await detectErrors(frame);
      if (errors.hasError) {
        log(`Error detected after submit: ${errors.message}`);
        throw new Error(`Form submission error: ${errors.message}`);
      }

      // Parse the result from the page
      const result = await this.parseComCheckResult(frame, request);
      log(`Express Code: ${result.expressCode}`);
      log(`Confirmation: ${result.confirmationNumber}`);

      await browserManager.screenshot('comcheck-04-result');
      return result;
    });
  }

  private async parseComCheckResult(frame: Frame, request: ComCheckRequest): Promise<ComCheckResult> {
    // After clicking "Retrieve Code", the page should show the express code
    // We need to extract it from the response page
    const resultData = await frame.evaluate(() => {
      const bodyText = document.body.innerText;

      let expressCode = '';
      let confirmationNumber = '';
      let amount = '';

      // The express code appears after "Express\nCode:" as a spaced number like "96341 02401 6483"
      const codeMatch = bodyText.match(/Express\s*Code[:\s]+(\d[\d\s]{8,})/i);
      if (codeMatch) {
        expressCode = codeMatch[1].trim();
      }

      // Amount appears after "Amount:" on the result side
      const amountMatch = bodyText.match(/Amount:\s*([\d,.]+)/);
      if (amountMatch) {
        amount = amountMatch[1];
      }

      // Reference number appears after "Reference\nNumber:"
      const refMatch = bodyText.match(/Reference\s*Number[:\s]+(\S+)/i);
      if (refMatch && refMatch[1] !== ' ') {
        confirmationNumber = refMatch[1].trim();
      }

      // Grab the visible text for debugging if we couldn't parse
      const visibleText = bodyText.substring(0, 3000);

      return { expressCode, confirmationNumber, amount, visibleText };
    });

    if (!resultData.expressCode) {
      console.log('Could not auto-parse express code. Page text:');
      console.log(resultData.visibleText);
      throw new Error(
        'Failed to parse express code from result page. Check screenshot comcheck-03-after-retrieve for details.'
      );
    }

    return {
      expressCode: resultData.expressCode,
      confirmationNumber: resultData.confirmationNumber || 'N/A',
      amount: parseFloat(resultData.amount) || request.amount,
      createdAt: new Date(),
    };
  }
}
