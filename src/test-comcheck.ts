import { browserManager } from './browser/browser-manager';
import { ComdataAutomation } from './browser/comdata-automation';
import { ComCheckRequest } from './types';

async function testComCheck() {
  console.log('=== Comcheck Creation Test ===\n');

  try {
    await browserManager.initialize();
    console.log('Browser initialized.');

    const automation = new ComdataAutomation();

    // Login first
    const loginResult = await automation.login();
    if (!loginResult.success) {
      console.error('Login failed:', loginResult.message);
      return;
    }

    // Create a test comcheck
    const request: ComCheckRequest = {
      amount: 100.00,
      driverLastName: 'TEST',
      driverFirstName: 'DRIVER',
      unitNumber: '101',
    };

    console.log('\n--- Creating Comcheck ---');
    console.log(`Amount: $${request.amount}`);
    console.log(`Driver: ${request.driverFirstName} ${request.driverLastName}`);
    console.log(`Unit: ${request.unitNumber}`);
    console.log();

    const result = await automation.createComCheck(request);

    console.log('\n=== RESULT ===');
    console.log(`Express Code: ${result.expressCode}`);
    console.log(`Confirmation: ${result.confirmationNumber}`);
    console.log(`Created At: ${result.createdAt.toISOString()}`);

    // Keep browser open for inspection
    console.log('\nBrowser will stay open for 30 seconds for inspection...');
    await new Promise((resolve) => setTimeout(resolve, 30000));
  } catch (error) {
    console.error('Test failed:', error);
    // Keep browser open on failure too so we can see what happened
    console.log('\nKeeping browser open for 30 seconds to inspect failure...');
    await new Promise((resolve) => setTimeout(resolve, 30000));
  } finally {
    await browserManager.close();
    console.log('Browser closed. Test complete.');
  }
}

testComCheck();
