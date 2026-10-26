/**
 * Enterprise QA features in a real browser:
 *   - Chaos Engine (QA panel): random HTTP 500 fault injection, the glass "Server Fault Injected"
 *     toast, automatic recovery, and exactly one transfer in the ledger.
 *   - ISO 20022 Message Inspector (receipt tab): the pacs.008 XML of a transfer, highlighted, copyable.
 */
import { test, expect } from '@playwright/test';
import { createFundedAdmin, createFundedUser, createUser, getBalanceCents, transfer } from '../helpers/api';
import { checkLedgerIntegrity } from '../helpers/db';
import { login } from '../helpers/ui';

test.describe('Chaos Engine', () => {
  test('fault injection: a 500 shows the chaos toast, the transfer is retried and completes exactly once', async ({ page, request }) => {
    const alice = await createFundedAdmin(request, 500, 'Alice Tan');
    const bob = await createUser(request, 'Bob Cruz');
    await login(page, alice);

    await page.getByTestId('qa-toggle').click();
    await expect(page.getByTestId('chaos-engine')).toBeVisible();
    await page.getByTestId('qa-fault').check();
    await expect(page.getByTestId('chaos-live')).toBeVisible();
    await expect(page.getByTestId('qa-status')).toContainText('20% of transfers and payments');
    await page.locator('#qa-close').click();

    // The app asks for 500s on 20% of payments; make it deterministic: the first 2 attempts fail.
    await page.setExtraHTTPHeaders({ 'x-chaos-drop-attempts': '2' });
    await page.getByTestId('open-send').click();
    await page.getByTestId('method-express').click();
    await page.getByTestId('send-to').fill(bob.accountNumber);
    await page.getByTestId('send-amount').fill('120');
    await page.getByTestId('send-submit').click();
    await page.getByTestId('review-confirm').click();
    await page.getByTestId('mpin-input-digit').first().click();
    await page.keyboard.type(alice.mpin);
    await page.getByTestId('mpin-submit').click();

    const toast = page.getByTestId('toast');
    await expect(toast).toContainText('⚠️ Chaos Engine: Server Fault Injected. Retrying transaction… (1/3)');
    await expect(toast).toHaveClass(/chaos/);
    await expect(toast).toContainText('(2/3)');
    await expect(page.getByTestId('receipt-title')).toHaveText('Transfer Successful');
    await expect(toast).toContainText('Chaos Engine: recovered');

    expect(await getBalanceCents(request, alice)).toBe(38_000);
    expect(await getBalanceCents(request, bob)).toBe(12_000);
    const report = await checkLedgerIntegrity([alice.accountNumber, bob.accountNumber]);
    expect(report.unbalancedTransactions).toEqual([]);
  });
});

test.describe('ISO 20022 Message Inspector', () => {
  test('a transfer receipt has an ISO 20022 tab with the pacs.008 XML, and Copy Payload copies it', async ({ page, context, request }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const alice = await createFundedUser(request, 500, 'Alice Tan');
    const bob = await createUser(request, 'Bob Cruz');
    expect((await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 40, description: 'Lunch' })).status()).toBe(201);

    await login(page, alice);
    await page.getByTestId('tx-item').first().click();
    await expect(page.getByTestId('receipt-tabs')).toBeVisible();
    await expect(page.getByTestId('iso-inspector')).toBeHidden();

    await page.getByTestId('receipt-tab-iso').click();
    await expect(page.getByTestId('receipt-tab-iso')).toHaveAttribute('aria-selected', 'true');
    const xml = page.getByTestId('iso-xml');
    await expect(xml).toContainText('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">');
    await expect(xml).toContainText('<IntrBkSttlmAmt Ccy="PHP">40.00</IntrBkSttlmAmt>');
    await expect(xml).toContainText(`<Id>${bob.accountNumber}</Id>`);
    await expect(xml.locator('.x-tag').first()).toBeVisible(); // syntax highlighted
    await expect(page.locator('.iso-xml')).toHaveCSS('background-color', 'rgb(31, 41, 55)'); // #1F2937
    await expect(page.getByTestId('iso-ids')).toContainText('EndToEndId');
    await expect(page.getByTestId('iso-meta')).toContainText('built from the ledger');

    await page.getByTestId('iso-copy').click();
    await expect(page.getByTestId('toast')).toContainText('payload copied');
    // (the Windows clipboard turns \n into \r\n)
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n');
    expect(copied).toBe(await xml.textContent());
    expect(copied).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);

    // Back to the receipt; a top-up receipt has no ISO tab
    await page.getByTestId('receipt-tab-receipt').click();
    await expect(page.getByTestId('receipt-rows')).toBeVisible();
    await page.getByTestId('receipt-done').click();
    await page.getByTestId('tx-item').last().click();
    await expect(page.getByTestId('receipt-title')).toBeVisible();
    await expect(page.getByTestId('receipt-tabs')).toBeHidden();
  });
});
