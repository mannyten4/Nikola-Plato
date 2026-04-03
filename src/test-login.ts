import { config } from './config';
import { browserManager } from './browser/browser-manager';
import { ComdataAutomation } from './browser/comdata-automation';

async function testLogin() {
  console.log('=== Comdata Login Test ===');
  console.log(`URL: ${config.comdata.url}`);
  console.log(`User: ${config.comdata.username}`);
  console.log(`Headless: ${config.browser.headless}`);
  console.log();

  try {
    await browserManager.initialize();
    console.log('Browser initialized.');

    const automation = new ComdataAutomation();
    const result = await automation.login();

    console.log();
    console.log(`Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`Message: ${result.message}`);

    await browserManager.screenshot('test-login-final');

    // Keep browser open for 30 seconds for manual inspection
    console.log();
    console.log('Browser will stay open for 30 seconds for inspection...');
    await new Promise((resolve) => setTimeout(resolve, 30000));
  } catch (error) {
    console.error('Test failed with error:', error);
  } finally {
    await browserManager.close();
    console.log('Browser closed. Test complete.');
  }
}

testLogin();
