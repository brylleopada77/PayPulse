/**
 * Bank Transfer picker in a real browser: a custom select-only combobox (WAI-ARIA APG) listing the
 * Philippine banks and e-wallets by category, each row with its badge, name and network tags, and
 * PESONet offered only where the destination accepts it.
 */
import { test, expect, type Page } from '@playwright/test';
import { createFundedUser } from '../helpers/api';
import { login } from '../helpers/ui';

async function openBankTransfer(page: Page) {
  await page.getByTestId('open-send').click();
  await page.getByTestId('method-bank').click();
  await expect(page.getByTestId('bank-trigger-name')).toHaveText('GCash');
}

test.describe('Bank Transfer: bank picker', () => {
  test('grouped list with badges and network tags; choosing a bank updates the trigger and the routes', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await openBankTransfer(page);

    const trigger = page.getByTestId('bank-trigger');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const listbox = page.getByRole('listbox', { name: 'Bank or e-wallet' });
    await expect(listbox.getByRole('group', { name: 'E-wallets & digital banks' }).getByRole('option')).toHaveCount(8);
    await expect(listbox.getByRole('group', { name: 'Universal & commercial banks' }).getByRole('option')).toHaveCount(11);
    const bdo = listbox.getByRole('option', { name: 'BDO InstaPay PESONet' });
    await expect(bdo.locator('.bank-avatar')).toHaveText('BDO');
    await expect(bdo.locator('.rail-tag')).toHaveText(['InstaPay', 'PESONet']);
    await expect(listbox.getByRole('option', { name: 'GCash InstaPay' })).toHaveAttribute('aria-selected', 'true');

    // E-wallet selected: PESONet disabled, InstaPay forced
    const rail = page.getByTestId('bank-rail');
    await expect(rail.locator('option[value="PESONET"]')).toHaveJSProperty('disabled', true);
    await expect(page.getByTestId('bank-rail-hint')).toHaveText('GCash receives InstaPay only');

    // Choose Landbank with the mouse: list closes, trigger shows its badge, name and both routes
    await listbox.getByRole('option', { name: 'Landbank InstaPay PESONet' }).click();
    await expect(listbox).toBeHidden();
    await expect(page.getByTestId('bank-trigger-name')).toHaveText('Landbank');
    await expect(trigger.locator('.bank-avatar')).toHaveText('LB');
    await expect(trigger.locator('.rail-tag')).toHaveText(['InstaPay', 'PESONet']);
    await expect(page.getByTestId('bank-code')).toHaveValue('LANDBANK');
    await expect(page.locator('#bank-account-label')).toHaveText('Landbank account number');
    await expect(rail.locator('option[value="PESONET"]')).toHaveJSProperty('disabled', false);
    await rail.selectOption('PESONET');

    // Back to a digital bank: the unsupported PESONet choice falls back to InstaPay
    await trigger.click();
    await listbox.getByRole('option', { name: 'Tonik InstaPay' }).click();
    await expect(rail).toHaveValue('INSTAPAY');
    await expect(page.locator('#bank-account-label')).toHaveText('Tonik account number');
  });

  test('keyboard: arrows, type-ahead, Enter, and Escape closes only the list', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await openBankTransfer(page);

    const trigger = page.getByTestId('bank-trigger');
    await expect(trigger).toBeFocused(); // the picker is the first field

    await page.keyboard.press('ArrowDown'); // opens on the selected option
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(trigger).toHaveAttribute('aria-activedescendant', 'bank-option-GCASH');
    await page.keyboard.press('ArrowDown');
    await expect(trigger).toHaveAttribute('aria-activedescendant', 'bank-option-MAYA');
    await page.keyboard.press('End');
    await expect(trigger).toHaveAttribute('aria-activedescendant', 'bank-option-LANDBANK');
    await page.keyboard.type('se'); // type-ahead: Security Bank
    await expect(trigger).toHaveAttribute('aria-activedescendant', 'bank-option-SECURITYBANK');

    await page.keyboard.press('Escape'); // closes the list; the dialog stays open
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('send-dialog')).toBeVisible();
    await expect(page.getByTestId('bank-trigger-name')).toHaveText('GCash'); // nothing chosen

    await page.keyboard.press('Enter');
    await page.keyboard.type('u'); // UnionDigital is the first "u" after GCash
    await expect(trigger).toHaveAttribute('aria-activedescendant', 'bank-option-UNIONDIGITAL');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('bank-trigger-name')).toHaveText('UnionDigital');
    await expect(trigger).toBeFocused();
  });

  test('sends to a digital bank end to end (review shows the bank and InstaPay)', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await openBankTransfer(page);

    await page.getByTestId('bank-trigger').click();
    await page.getByRole('option', { name: 'MariBank InstaPay' }).click();
    await page.getByTestId('bank-account').fill('012345678901');
    await page.getByTestId('bank-account-name').fill('Ana Reyes');
    await page.getByTestId('bank-amount').fill('250');
    await page.getByTestId('bank-submit').click();

    const review = page.locator('#send-review');
    await expect(review).toContainText('MariBank');
    await expect(review).toContainText('InstaPay (instant)');
  });
});
