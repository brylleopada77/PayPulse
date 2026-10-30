/**
 * Bank Transfer picker in a real browser: a summary button that opens a 2-column grid of bank cards
 * (native radios, grouped by category), each with its logo, name and network tags. The grid opens in
 * place of the rest of the form, so there is no dropdown and no inner scrollbar. PESONet is offered
 * only where the destination accepts it.
 */
import { test, expect, type Page } from '@playwright/test';
import { createFundedUser } from '../helpers/api';
import { login } from '../helpers/ui';

async function openBankTransfer(page: Page) {
  await page.getByTestId('open-send').click();
  await page.getByTestId('method-bank').click();
  await expect(page.getByTestId('bank-trigger-name')).toHaveText('GCash');
}

/** Open the grid and click a bank card ("BDO InstaPay PESONet": its name and network tags). */
async function pickBank(page: Page, name: string) {
  await page.getByTestId('bank-trigger').click();
  await page.getByTestId('bank-grid').getByRole('radio', { name }).click();
  await expect(page.getByTestId('bank-grid')).toBeHidden();
}

test.describe('Bank Transfer: bank picker', () => {
  test('2-column grid by category with logos (badge where there is none) and network tags', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await openBankTransfer(page);

    const trigger = page.getByTestId('bank-trigger');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const grid = page.getByTestId('bank-grid');
    const ewallets = grid.getByRole('group', { name: 'E-wallets & digital banks' });
    await expect(ewallets.getByRole('radio')).toHaveCount(8);
    await expect(grid.getByRole('group', { name: 'Universal & commercial banks' }).getByRole('radio')).toHaveCount(11);
    const bdo = grid.getByTestId('bank-card').filter({ hasText: 'BDO' });
    await expect(bdo.locator('.bank-avatar.has-logo img')).toHaveAttribute('src', '/img/banks/bdo.png');
    await expect(bdo.locator('.rail-tag')).toHaveText(['InstaPay', 'PESONet']);
    await expect(grid.getByRole('radio', { name: 'GCash InstaPay' })).toBeChecked();

    // two columns: GCash and Maya side by side, GoTyme on the next row
    const box = async (name: string) => (await grid.getByTestId('bank-card').filter({ hasText: name }).boundingBox())!;
    const [gcash, maya, gotyme] = [await box('GCash'), await box('Maya'), await box('GoTyme')];
    expect(Math.round(maya.y)).toBe(Math.round(gcash.y));
    expect(maya.x).toBeGreaterThan(gcash.x + gcash.width - 1);
    expect(gotyme.y).toBeGreaterThan(gcash.y + gcash.height - 1);

    // every logo is served and decodes (no broken images)
    const broken = await grid.locator('img').evaluateAll((imgs) =>
      Promise.all(imgs.map((img) => (img as HTMLImageElement).decode().then(() => null, () => (img as HTMLImageElement).src))));
    expect(broken.filter(Boolean)).toEqual([]);
    // no logo for PNB: its initials badge
    await expect(grid.getByTestId('bank-card').filter({ hasText: 'PNB' }).locator('.bank-avatar')).toHaveText('PNB');

    // choosing closes the grid; the summary shows the logo and name (no channel tags: that is the channel picker)
    await grid.getByRole('radio', { name: 'Landbank InstaPay PESONet' }).click();
    await expect(grid).toBeHidden();
    await expect(page.getByTestId('bank-trigger-name')).toHaveText('Landbank');
    await expect(trigger.locator('.bank-avatar img')).toHaveAttribute('src', '/img/banks/landbank.png');
    await expect(trigger.locator('.rail-tag')).toHaveCount(0);
    await expect(page.locator('#bank-form input[name="bankCode"]:checked')).toHaveValue('LANDBANK');
  });

  test('no inner scrollbar: the grid replaces the form while open; a pick folds it away and focuses the account number', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await openBankTransfer(page);

    await page.getByTestId('bank-trigger').click();
    const grid = page.getByTestId('bank-grid');
    await expect(grid).toBeVisible();
    // steps 2 to 5 step aside while choosing
    await expect(page.getByTestId('bank-channel')).toBeHidden();
    await expect(page.getByTestId('bank-account')).toBeHidden();
    await expect(page.getByTestId('bank-submit')).toBeHidden();
    // nothing inside the dialog scrolls on its own (the old dropdown did)
    const innerScrollers = await page.getByTestId('send-dialog').evaluate((dialog) =>
      [...dialog.querySelectorAll('*')].filter((el) => {
        const { overflowY } = getComputedStyle(el);
        return /auto|scroll/.test(overflowY) && el.scrollHeight > el.clientHeight + 1;
      }).map((el) => el.id || el.className));
    expect(innerScrollers).toEqual([]);

    await grid.getByRole('radio', { name: 'BPI InstaPay PESONet' }).click();
    await expect(grid).toBeHidden();
    await expect(page.getByTestId('bank-trigger-name')).toHaveText('BPI');
    await expect(page.getByTestId('bank-account')).toBeFocused();
    await expect(page.getByTestId('bank-channel')).toBeVisible();

    // reopening Bank Transfer starts with the grid folded away
    await page.getByTestId('bank-trigger').click();
    await expect(grid).toBeVisible();
    await page.keyboard.press('Escape'); // the grid only
    await expect(grid).toBeHidden();
    await expect(page.getByTestId('send-dialog')).toBeVisible();
    await page.keyboard.press('Escape'); // then the dialog
    await expect(page.getByTestId('send-dialog')).toBeHidden();
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
    await pickBank(page, 'AUB InstaPay PESONet');
    await expect(pesonet).toBeEnabled();
    await expect(page.getByTestId('bank-rail-hint')).toBeHidden();
    await expect(page.getByTestId('pesonet-not-supported')).toBeHidden();
    await expect(page.getByTestId('bank-account')).toHaveAttribute('placeholder', '10 to 16 digits for AUB');
    await page.getByTestId('channel-pesonet').click();
    await expect(pesonet).toBeChecked();

    // Back to a digital bank: the unsupported PESONet choice falls back to InstaPay
    await pickBank(page, 'Tonik InstaPay');
    await expect(instapay).toBeChecked();
    await expect(pesonet).toBeDisabled();
    await expect(page.getByTestId('bank-account')).toHaveAttribute('placeholder', '10 to 16 digits for Tonik');
  });

  test('InstaPay above ₱50,000: inline warning, one-tap switch to PESONet, and Review is blocked until then', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 100_000, 'Alice Tan'));
    await openBankTransfer(page);
    const warning = page.locator('#bank-limit-text');

    await pickBank(page, 'BDO InstaPay PESONet');
    await page.getByTestId('bank-account').fill('001234567890');
    await page.getByTestId('bank-account-name').fill('Ana Reyes');
    await page.getByTestId('bank-amount').fill('50000');
    await expect(warning).toHaveText(''); // exactly the cap is fine
    await page.getByTestId('bank-amount').fill('60000');
    await expect(warning).toContainText('InstaPay limit is ₱50,000. Switch to PESONet for higher amounts.');

    await page.getByTestId('bank-submit').click();
    await expect(page.locator('#bank-form .form-error')).toHaveText('InstaPay limit is ₱50,000. Switch to PESONet for higher amounts.');

    await page.getByTestId('bank-use-pesonet').click();
    await expect(page.getByTestId('bank-channel').getByRole('radio', { name: /PESONet/ })).toBeChecked();
    await expect(warning).toHaveText('');
    await page.getByTestId('bank-submit').click();
    await expect(page.locator('#send-review')).toContainText('PESONet (batch)');

    // an InstaPay-only e-wallet can't switch: the warning says to send it in parts
    await page.locator('#review-back').click();
    await pickBank(page, 'GCash InstaPay');
    await expect(warning).toContainText('GCash receives InstaPay only. Send it in parts.');
    await expect(page.getByTestId('bank-use-pesonet')).toBeHidden();
  });

  test('keyboard: Enter opens the grid, arrows move, Escape closes only the grid, Space picks', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await openBankTransfer(page);

    const trigger = page.getByTestId('bank-trigger');
    const grid = page.getByTestId('bank-grid');
    await expect(trigger).toBeFocused(); // the picker is the first field

    await page.keyboard.press('Enter'); // opens on the chosen bank
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(grid.getByRole('radio', { name: 'GCash InstaPay' })).toBeFocused();
    await page.keyboard.press('ArrowRight'); // next card: Maya (selects, the grid stays open)
    await expect(grid.getByRole('radio', { name: 'Maya InstaPay' })).toBeFocused();
    await expect(grid).toBeVisible();
    await expect(page.getByTestId('bank-trigger-name')).toHaveText('Maya');

    await page.keyboard.press('Escape'); // closes the grid; the dialog stays open
    await expect(grid).toBeHidden();
    await expect(page.getByTestId('send-dialog')).toBeVisible();
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(grid.getByRole('radio', { name: 'Maya InstaPay' })).toBeFocused();
    await page.keyboard.press('ArrowDown'); // GoTyme
    await page.keyboard.press(' '); // picks it
    await expect(grid).toBeHidden();
    await expect(page.getByTestId('bank-trigger-name')).toHaveText('GoTyme');
    await expect(page.getByTestId('bank-account')).toBeFocused();
  });

  test('sends to a digital bank end to end (review shows the bank and InstaPay)', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 1000, 'Alice Tan'));
    await openBankTransfer(page);

    await pickBank(page, 'MariBank InstaPay');
    await page.getByTestId('bank-account').fill('012345678901');
    await page.getByTestId('bank-account-name').fill('Ana Reyes');
    await page.getByTestId('bank-amount').fill('250');
    await page.getByTestId('bank-submit').click();

    const review = page.locator('#send-review');
    await expect(review).toContainText('MariBank');
    await expect(review).toContainText('InstaPay (instant)');
  });
});
