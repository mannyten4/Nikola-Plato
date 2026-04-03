/**
 * E2E Test Suite for BrowserAi
 *
 * Tests the full flow: AI tool call → orchestrator → browser automation → result.
 *
 * Usage:
 *   MOCK_BROWSER=true npx ts-node src/test/e2e-test.ts
 *
 * For real browser tests (requires credentials):
 *   MOCK_BROWSER=false npx ts-node src/test/e2e-test.ts
 */

import { config } from '../config';
import { ComdataAutomation } from '../browser/comdata-automation';
import { ComCheckOrchestrator } from '../orchestrator';
import { RequestTracker } from '../state/request-tracker';
import { CreateComcheckInput } from '../ai/tools';
import { browserManager } from '../browser/browser-manager';

// ── Helpers ───────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function makeInput(overrides?: Partial<CreateComcheckInput>): CreateComcheckInput {
  return {
    carrier: 'Rex Logistics LLC',
    payee_name: 'John Smith',
    amount: 100,
    memo: 'Lumper',
    unit_number: '101',
    reference_number: 'LD-12345',
    ...overrides,
  };
}

// ── Test Cases ────────────────────────────────────────────────────

async function testMockBrowserHappyPath(): Promise<void> {
  console.log('  Testing mock browser happy path...');
  assert(config.mockBrowser, 'MOCK_BROWSER must be true for this test');

  const tracker = new RequestTracker();
  const automation = new ComdataAutomation();
  const orchestrator = new ComCheckOrchestrator(automation, tracker);

  const request = tracker.createRequest('test-thread-1', 'U001', 'Test User');
  tracker.updateRequest(request.id, { status: 'processing' });

  const result = await orchestrator.executeComCheck(request.id, makeInput(), 'test-thread-1');

  assert(result.expressCode.startsWith('MOCK-'), `Expected MOCK- prefix, got: ${result.expressCode}`);
  assert(!!result.confirmationNumber, 'Expected confirmation number');
  assert(result.amount === 100, `Expected amount 100, got: ${result.amount}`);

  const updated = tracker.getRequest(request.id);
  assert(updated?.status === 'completed', `Expected status completed, got: ${updated?.status}`);
  assert(updated?.express_code === result.expressCode, 'Express code should be saved');

  tracker.close();
}

async function testValidation(): Promise<void> {
  console.log('  Testing input validation...');

  const tracker = new RequestTracker();
  const automation = new ComdataAutomation();
  const orchestrator = new ComCheckOrchestrator(automation, tracker);

  // Amount = 0
  try {
    const req = tracker.createRequest('test-val-1', 'U001', 'Test');
    await orchestrator.executeComCheck(req.id, makeInput({ amount: 0 }), 'test-val-1');
    throw new Error('Should have thrown for amount=0');
  } catch (e: any) {
    assert(e.message.includes('greater than zero'), `Unexpected error: ${e.message}`);
  }

  // Amount exceeds max
  try {
    const req = tracker.createRequest('test-val-2', 'U001', 'Test');
    await orchestrator.executeComCheck(
      req.id,
      makeInput({ amount: config.comcheckMaxAmount + 1 }),
      'test-val-2'
    );
    throw new Error('Should have thrown for amount exceeding max');
  } catch (e: any) {
    assert(e.message.includes('exceeds the maximum'), `Unexpected error: ${e.message}`);
  }

  // Empty payee name
  try {
    const req = tracker.createRequest('test-val-3', 'U001', 'Test');
    await orchestrator.executeComCheck(req.id, makeInput({ payee_name: '' }), 'test-val-3');
    throw new Error('Should have thrown for empty payee');
  } catch (e: any) {
    assert(e.message.includes('Payee name is required'), `Unexpected error: ${e.message}`);
  }

  tracker.close();
}

async function testQueueOverflow(): Promise<void> {
  console.log('  Testing queue overflow...');
  assert(config.mockBrowser, 'MOCK_BROWSER must be true for this test');

  const tracker = new RequestTracker();
  const automation = new ComdataAutomation();
  const orchestrator = new ComCheckOrchestrator(automation, tracker);

  // Enqueue 10 items (don't await yet)
  const promises: Promise<any>[] = [];
  for (let i = 0; i < 10; i++) {
    const req = tracker.createRequest(`test-overflow-${i}`, 'U001', 'Test');
    tracker.updateRequest(req.id, { status: 'processing' });
    promises.push(orchestrator.executeComCheck(req.id, makeInput(), `test-overflow-${i}`));
  }

  // 11th should be rejected
  try {
    const req = tracker.createRequest('test-overflow-11', 'U001', 'Test');
    tracker.updateRequest(req.id, { status: 'processing' });
    await orchestrator.executeComCheck(req.id, makeInput(), 'test-overflow-11');
    throw new Error('Should have thrown for queue overflow');
  } catch (e: any) {
    assert(e.message.includes('Queue full'), `Unexpected error: ${e.message}`);
  }

  // Wait for all 10 to complete
  await Promise.all(promises);

  tracker.close();
}

async function testNameSplitting(): Promise<void> {
  console.log('  Testing name splitting...');
  assert(config.mockBrowser, 'MOCK_BROWSER must be true for this test');

  const tracker = new RequestTracker();
  const automation = new ComdataAutomation();
  const orchestrator = new ComCheckOrchestrator(automation, tracker);

  const names = ['John Smith', 'Madonna', 'Mary Jane Watson'];

  for (const name of names) {
    const req = tracker.createRequest(`test-name-${name}`, 'U001', 'Test');
    tracker.updateRequest(req.id, { status: 'processing' });
    const result = await orchestrator.executeComCheck(req.id, makeInput({ payee_name: name }), `test-name-${name}`);
    assert(!!result.expressCode, `Name "${name}" should produce an express code`);

    const updated = tracker.getRequest(req.id);
    assert(updated?.status === 'completed', `Name "${name}" request should be completed`);
  }

  tracker.close();
}

async function testSessionErrorRetry(): Promise<void> {
  console.log('  Testing session error retry...');
  assert(config.mockBrowser, 'MOCK_BROWSER must be true for this test');

  const tracker = new RequestTracker();
  const automation = new ComdataAutomation();
  const orchestrator = new ComCheckOrchestrator(automation, tracker);

  // Override createComCheck to fail with session error on first call
  let callCount = 0;
  const originalCreateComCheck = automation.createComCheck.bind(automation);
  automation.createComCheck = async (request) => {
    callCount++;
    if (callCount === 1) {
      throw new Error('Session expired — please log in again');
    }
    return originalCreateComCheck(request);
  };

  const req = tracker.createRequest('test-retry-1', 'U001', 'Test');
  tracker.updateRequest(req.id, { status: 'processing' });

  const result = await orchestrator.executeComCheck(req.id, makeInput(), 'test-retry-1');
  assert(callCount === 2, `Expected 2 calls, got: ${callCount}`);
  assert(!!result.expressCode, 'Should succeed on retry');

  const updated = tracker.getRequest(req.id);
  assert(updated?.status === 'completed', `Expected completed, got: ${updated?.status}`);

  // Restore
  automation.createComCheck = originalCreateComCheck;
  tracker.close();
}

async function testFormErrorNoRetry(): Promise<void> {
  console.log('  Testing form error (no retry)...');
  assert(config.mockBrowser, 'MOCK_BROWSER must be true for this test');

  const tracker = new RequestTracker();
  const automation = new ComdataAutomation();
  const orchestrator = new ComCheckOrchestrator(automation, tracker);

  let callCount = 0;
  const originalCreateComCheck = automation.createComCheck.bind(automation);
  automation.createComCheck = async () => {
    callCount++;
    throw new Error('Form submission error: Invalid account number');
  };

  const req = tracker.createRequest('test-form-err', 'U001', 'Test');
  tracker.updateRequest(req.id, { status: 'processing' });

  try {
    await orchestrator.executeComCheck(req.id, makeInput(), 'test-form-err');
    throw new Error('Should have thrown');
  } catch (e: any) {
    assert(e.message.includes('Form submission error'), `Unexpected error: ${e.message}`);
    assert(callCount === 1, `Form errors should NOT retry, got ${callCount} calls`);
  }

  const updated = tracker.getRequest(req.id);
  assert(updated?.status === 'failed', `Expected failed, got: ${updated?.status}`);

  automation.createComCheck = originalCreateComCheck;
  tracker.close();
}

async function testIntegrationWithRealBrowser(): Promise<void> {
  if (config.mockBrowser) {
    console.log('  Skipping real browser test (MOCK_BROWSER=true)');
    return;
  }

  console.log('  Testing with REAL browser...');
  console.log('  Initializing browser...');
  await browserManager.initialize();

  const tracker = new RequestTracker();
  const automation = new ComdataAutomation();
  const orchestrator = new ComCheckOrchestrator(automation, tracker);

  const req = tracker.createRequest('test-real-1', 'U001', 'Integration Test');
  tracker.updateRequest(req.id, { status: 'processing' });

  const result = await orchestrator.executeComCheck(
    req.id,
    makeInput({ payee_name: 'Test Driver', amount: 1, memo: 'Integration test' }),
    'test-real-1'
  );

  console.log(`  Express Code: ${result.expressCode}`);
  console.log(`  Confirmation: ${result.confirmationNumber}`);
  console.log(`  Amount: $${result.amount}`);

  assert(!!result.expressCode, 'Expected an express code');

  const updated = tracker.getRequest(req.id);
  assert(updated?.status === 'completed', `Expected completed, got: ${updated?.status}`);

  await browserManager.close();
  tracker.close();
}

// ── Runner ────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  skipped?: boolean;
}

async function runTests(): Promise<void> {
  console.log('=== BrowserAi E2E Test Suite ===');
  console.log(`  MOCK_BROWSER: ${config.mockBrowser}`);
  console.log(`  Max amount: $${config.comcheckMaxAmount}`);
  console.log();

  const tests = [
    testMockBrowserHappyPath,
    testValidation,
    testQueueOverflow,
    testNameSplitting,
    testSessionErrorRetry,
    testFormErrorNoRetry,
    testIntegrationWithRealBrowser,
  ];

  const results: TestResult[] = [];

  for (const test of tests) {
    try {
      await test();
      results.push({ name: test.name, passed: true });
      console.log(`  ✓ PASS: ${test.name}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ name: test.name, passed: false, error: msg });
      console.log(`  ✗ FAIL: ${test.name} — ${msg}`);
    }
    console.log();
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('=== Summary ===');
  console.log(`  ${passed} passed, ${failed} failed, ${results.length} total`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }

  console.log('\nAll tests passed!');
}

runTests().catch((error) => {
  console.error('Test suite crashed:', error);
  process.exit(1);
});
