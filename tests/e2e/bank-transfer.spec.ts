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
  test('grouped list with logos (badge where there is none) and network tags', async ({ page, request }) => {
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
    await expect(bdo.locator('.bank-avatar.has-logo img')).toHaveAttribute('src', '/img/banks/bdo.png');
    await expect(bdo.locator('.rail-tag')).toHaveText(['InstaPay', 'PESONet']);
    await expect(listbox.getByRole('option', { name: 'GCash InstaPay' })).toHaveAttribute('aria-selected', 'true');

    // every logo is served and decodes (no broken images)
    const broken = await listbox.locator('img').evaluateAll((imgs) =>
      Promise.all(imgs.map((img) => (img as HTMLImageElement).decode().then(() => null, () => (img as HTMLImageElement).src))));
    expect(broken.filter(Boolean)).toEqual([]);
    // no logo for PNB: its initials badge
    await expect(listbox.getByRole('option', { name: 'PNB InstaPay PESONet' }).locator('.bank-avatar')).toHaveText('PNB');

    // choosing closes the list; the trigger shows the logo and name (no channel tags: that is the channel picker)
    await listbox.getByRole('option', { name: 'Landbank InstaPay PESONet' }).click();
    await expect(listbox).toBeHidden();
    await expect(page.getByTestId('bank-trigger-name')).toHaveText('Landbank');
    await expect(trigger.locator('.bank-avatar img')).toHaveAttribute('src', '/img/banks/landbank.png');
    await expect(trigger.locator('.rail-tag')).toHaveCount(0);
    await expect(page.getByTestId('bank-code')).toHaveValue('LANDBANK');
  });

  test('the list floats over the form: no extra scrollbar, nothing pushed down, closes on pick and with the dialog', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await openBankTransfer(page);

    const dialog = page.getByTestId('send-dialog');
    const scrollHeight = () => dialog.evaluate((d) => d.scrollHeight);
    const channelTop = async () => (await page.getByTestId('bank-channel').boundingBox())!.y;
    const [heightBefore, channelBefore] = [await scrollHeight(), await channelTop()];

    await page.getByTestId('bank-trigger').click();
    const listbox = page.getByTestId('bank-listbox');
    await expect(listbox).toBeVisible();
    expect(await scrollHeight()).toBe(heightBefore); // the dialog does not grow a scrollbar
    expect(await channelTop()).toBe(channelBefore); // the channel cards stay where they were
    // directly under the trigger, as wide as it, at most 208px tall (it scrolls inside)
    const trigger = (await page.getByTestId('bank-trigger').boundingBox())!;
    const list = (await listbox.boundingBox())!;
    expect(Math.round(list.x)).toBe(Math.round(trigger.x));
    expect(Math.round(list.width)).toBe(Math.round(trigger.width));
    expect(list.y).toBeGreaterThan(trigger.y + trigger.height);
    expect(list.height).toBeLessThanOrEqual(208);
    expect(await listbox.evaluate((l) => l.scrollHeight > l.clientHeight)).toBe(true);

    await page.getByRole('option', { name: 'BPI InstaPay PESONet' }).click();
    await expect(listbox).toBeHidden();
    await expect(page.getByTestId('bank-trigger-name')).toHaveText('BPI');

    // the list must not outlive the dialog (it lives in the top layer)
    await page.getByTestId('bank-trigger').click();
    await expect(listbox).toBeVisible();
    await page.getByTestId('bank-trigger').press('Escape'); // closes the list only
    await page.keyboard.press('Escape'); // then the dialog
    await expect(dialog).toBeHidden();
    await expect(listbox).toBeHidden();
  });

  test('the five steps are numbered in order and the button reads "Continue to Transfer"', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await openBankTransfer(page);
    // top to bottom: bank, channel, account number, account name, amount
    const steps = page.locator('#bank-form .step-label');
    await expect(steps).toHaveText(['Bank or e-wallet', /^Transfer channel/, 'GCash mobile number', 'Account name', 'Amount (₱)']);
    const tops = await steps.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    await expect(page.getByTestId('bank-submit')).toHaveText('Continue to Transfer');
    await expect(page.getByTestId('bank-fee-preview')).toContainText('Transaction fee ₱15.00');
  });

  test('a logo that fails to load falls back to the initials badge', async ({ page, request }) => {
    await page.route('**/img/banks/gcash.png', (route) => route.fulfill({ status: 404, body: '' }));
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await openBankTransfer(page);
    const avatar = page.getByTestId('bank-trigger').locator('.bank-avatar');
    await expect(avatar).toHaveText('GC');
    await expect(avatar).not.toHaveClass(/has-logo/);
  });

  test('transfer channel: e-wallets locked to InstaPay; banks pick InstaPay or PESONet; account placeholder per bank', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await openBankTransfer(page);

    const channel = page.getByRole('group', { name: /Transfer channel/ });
    const instapay = channel.getByRole('radio', { name: /InstaPay/ });
    const pesonet = channel.getByRole('radio', { name: /PESONet/ });

    // GCash: InstaPay checked, PESONet disabled, an informative tag; mobile-number placeholder
    await expect(instapay).toBeChecked();
    await expect(pesonet).toBeDisabled();
    await expect(page.getByTestId('bank-rail-hint')).toHaveText('GCash: InstaPay only');
    await expect(page.getByTestId('pesonet-not-supported')).toHaveText('Not supported');
    await expect(page.getByTestId('bank-account')).toHaveAttribute('placeholder', '09XXXXXXXXX (registered with GCash)');

    // AUB: both channels; PESONet can be picked; account-number placeholder names the bank
    await page.getByTestId('bank-trigger').click();
    await page.getByRole('option', { name: 'AUB InstaPay PESONet' }).click();
    await expect(pesonet).toBeEnabled();
    await expect(page.getByTestId('bank-rail-hint')).toBeHidden();
    await expect(page.getByTestId('pesonet-not-supported')).toBeHidden();
    await expect(page.getByTestId('bank-account')).toHaveAttribute('placeholder', '10 to 16 digits for AUB');
    await page.getByTestId('channel-pesonet').click();
    await expect(pesonet).toBeChecked();

    // Back to a digital bank: the unsupported PESONet choice falls back to InstaPay
    await page.getByTestId('bank-trigger').click();
    await page.getByRole('option', { name: 'Tonik InstaPay' }).click();
    await expect(instapay).toBeChecked();
    await expect(pesonet).toBeDisabled();
    await expect(page.getByTestId('bank-account')).toHaveAttribute('placeholder', '10 to 16 digits for Tonik');
  });

  test('InstaPay above ₱50,000: inline warning, one-tap switch to PESONet, and Review is blocked until then', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 100_000, 'Alice Tan'));
    await openBankTransfer(page);
    const warning = page.locator('#bank-limit-text');

    await page.getByTestId('bank-trigger').click();
    await page.getByRole('option', { name: 'BDO InstaPay PESONet' }).click();
    await page.getByTestId('bank-account').fill('001234567890');
    await page.getByTestId('bank-account-name').fill('Ana Reyes');
    await page.getByTestId('bank-amount').fill('50000');
    await expect(warning).toHaveText(''); // exactly the cap is fine
    await page.getByTestId('bank-amount').fill('60000');
    await expect(warning).toContainText('InstaPay limit is ₱50,000. Switch to PESONet for higher amounts.');

    await page.getByTestId('bank-submit').click();
    await expect(page.locator('#bank-form .form-error')).toHaveText('InstaPay limit is ₱50,000. Switch to PESONet for higher amounts.');

    await page.getByTestId('bank-use-pesonet').click();
    await expect(page.getByRole('radio', { name: /PESONet/ })).toBeChecked();
    await expect(warning).toHaveText('');
    await page.getByTestId('bank-submit').click();
    await expect(page.locator('#send-review')).toContainText('PESONet (batch)');

    // an InstaPay-only e-wallet can't switch: the warning says to send it in parts
    await page.locator('#review-back').click();
    await page.getByTestId('bank-trigger').click();
    await page.getByRole('option', { name: 'GCash InstaPay' }).click();
    await expect(warning).toContainText('GCash receives InstaPay only. Send it in parts.');
    await expect(page.getByTestId('bank-use-pesonet')).toBeHidden();
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
