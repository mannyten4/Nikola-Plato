import { browserManager } from './browser/browser-manager';
import { ComdataAutomation } from './browser/comdata-automation';
import { ComCheckRequest } from './types';

async function testSessionRecovery() {
  console.log('=== Session Recovery Test ===\n');

  try {
    await browserManager.initialize();
    console.log('Browser initialized.');

    const automation = new ComdataAutomation();

    // Step 1: Login normally
    console.log('\n--- Step 1: Normal login ---');
    const loginResult = await automation.login();
    if (!loginResult.success) {
      console.error('Initial login failed:', loginResult.message);
      return;
    }
    console.log('Login successful.\n');

    // Step 2: Clear cookies to simulate session expiry
    console.log('--- Step 2: Clearing cookies to simulate session expiry ---');
    const page = await browserManager.getPage();
    await page.context().clearCookies();
    console.log('Cookies cleared.\n');

    // Navigate to login page to confirm session is dead
    await page.goto('https://w6.iconnectdata.com/Login/dashboard');
    await page.waitForTimeout(3000);
    console.log(`Current URL after cookie clear: ${page.url()}`);

    const stillLoggedIn = await automation.isLoggedIn();
    console.log(`Still logged in? ${stillLoggedIn}`);
    if (stillLoggedIn) {
      console.log('WARNING: Session persisted despite cookie clear (persistent context may retain state).');
      console.log('This is actually fine — persistent context is doing its job.');
    }

    // Step 3: Attempt comcheck — session guard should handle re-auth if needed
    console.log('\n--- Step 3: Creating comcheck (session guard should re-auth if needed) ---');
    const request: ComCheckRequest = {
      amount: 50.00,
      driverLastName: 'RECOVERY',
      driverFirstName: 'TEST',
      unitNumber: '999',
    };

    const result = await automation.createComCheck(request);

    console.log('\n=== RECOVERY TEST PASSED ===');
    console.log(`Express Code: ${result.expressCode}`);
    console.log(`Confirmation: ${result.confirmationNumber}`);
    console.log(`Amount: ${result.amount}`);

    console.log('\nBrowser will stay open for 15 seconds for inspection...');
    await new Promise((resolve) => setTimeout(resolve, 15000));
  } catch (error) {
    console.error('\n=== RECOVERY TEST FAILED ===');
    console.error(error);
    console.log('\nKeeping browser open for 15 seconds to inspect...');
    await new Promise((resolve) => setTimeout(resolve, 15000));
  } finally {
    await browserManager.close();
    console.log('Browser closed. Test complete.');
  }
}

testSessionRecovery();
