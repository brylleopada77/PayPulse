/**
 * Bank Transfer dropdown in a real browser: Philippine banks and e-wallets grouped by category, each
 * option tagged with its routes, and PESONet offered only where the destination accepts it.
 */
import { test, expect } from '@playwright/test';
import { createFundedUser } from '../helpers/api';
import { login } from '../helpers/ui';

test.describe('Bank Transfer: banks and e-wallets', () => {
  test('grouped dropdown with route tags; e-wallets are InstaPay only, banks offer PESONet', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await page.getByTestId('open-send').click();
    await page.getByTestId('method-bank').click();

    const select = page.getByTestId('bank-select');
    await expect(select.locator('optgroup')).toHaveCount(2);
    await expect(select.locator('optgroup').first()).toHaveAttribute('label', 'E-wallets & digital banks');
    await expect(select.locator('optgroup[label="E-wallets & digital banks"] option')).toHaveCount(8);
    await expect(select.locator('optgroup[label="Banks"] option')).toHaveCount(11);
    await expect(select.locator('option[value="GCASH"]')).toHaveText('GCash · InstaPay');
    await expect(select.locator('option[value="BDO"]')).toHaveText('BDO · InstaPay / PESONet');

    // E-wallet: account label is the mobile number, PESONet is disabled, InstaPay selected
    const rail = page.getByTestId('bank-rail');
    await select.selectOption('GCASH');
    await expect(page.locator('#bank-account-label')).toHaveText('GCash mobile number');
    await expect(rail.locator('option[value="PESONET"]')).toHaveJSProperty('disabled', true);
    await expect(rail).toHaveValue('INSTAPAY');
    await expect(page.getByTestId('bank-rail-hint')).toHaveText('GCash receives InstaPay only');

    // Bank: PESONet available again and can be chosen
    await select.selectOption('LANDBANK');
    await expect(page.locator('#bank-account-label')).toHaveText('Landbank account number');
    await expect(rail.locator('option[value="PESONET"]')).toHaveJSProperty('disabled', false);
    await rail.selectOption('PESONET');
    await expect(page.getByTestId('bank-rail-hint')).toHaveText('');

    // Switching back to a digital bank moves an unsupported PESONet choice back to InstaPay
    await select.selectOption('TONIK');
    await expect(rail).toHaveValue('INSTAPAY');
    await expect(page.locator('#bank-account-label')).toHaveText('Tonik account number');
  });

  test('sends to a digital bank end to end (review shows the bank and InstaPay)', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await page.getByTestId('open-send').click();
    await page.getByTestId('method-bank').click();

    await page.getByTestId('bank-select').selectOption('SEABANK');
    await page.getByTestId('bank-account').fill('012345678901');
    await page.getByTestId('bank-account-name').fill('Ana Reyes');
    await page.getByTestId('bank-amount').fill('250');
    await page.getByTestId('bank-submit').click();

    const review = page.locator('#send-review');
    await expect(review).toContainText('SeaBank');
    await expect(review).toContainText('InstaPay (instant)');
  });
});
