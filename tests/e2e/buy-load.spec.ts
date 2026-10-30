/**
 * Buy Load end to end in a real browser (Playwright project "ui").
 * MPINs are random per user ("123456" is rejected as too easy), so the test types the MPIN its
 * user received at registration.
 */
import { test, expect } from '@playwright/test';
import { createFundedUser, getBalanceCents } from '../helpers/api';
import { expireMpin } from '../helpers/db';
import { login, peso, typeCode } from '../helpers/ui';

test.describe('Buy Load', () => {
  test('tap a telco first: its promos open straight away, then the number keeps that brand', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 500, 'Alice Reyes'));
    await page.getByTestId('open-load').click();

    const tm = page.getByTestId('load-network-TM');
    await expect(tm).toHaveAttribute('aria-pressed', 'false');
    await tm.click();
    await expect(tm).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('load-tab-promo')).toBeChecked();
    const promos = page.locator('#load-promos .promo-item');
    await expect(promos).toHaveCount(3);
    await expect(page.getByTestId('load-promo-EASYSURF50')).toBeVisible();
    for (const promo of await promos.all()) await expect(promo.locator('.bank-avatar img')).toHaveAttribute('src', '/img/telcos/tm.png');

    // another telco: its own promos
    await page.getByTestId('load-network-SMART').click();
    await expect(tm).toHaveAttribute('aria-pressed', 'false');
    await expect(promos).toHaveCount(4);
    await expect(page.getByTestId('load-promo-MAGICDATA99')).toBeVisible();

    // back to TM, pick a promo, then a Globe-network number: TM (a Globe brand) stays chosen
    await tm.click();
    await page.getByTestId('load-promo-EASYSURF50').click();
    await page.getByTestId('load-mobile').fill('09171234567');
    await expect(page.getByTestId('load-brand-TM')).toBeChecked();
    await expect(page.getByTestId('load-promo-EASYSURF50')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('load-continue').click();
    await expect(page.getByTestId('load-summary')).toContainText('EasySURF 50');
  });

  test('telco logos: every network before a number is typed, then the brand chips and each promo card', async ({ page, request }) => {
    await login(page, await createFundedUser(request, 500, 'Alice Reyes'));
    await page.getByTestId('open-load').click();

    const networks = page.getByTestId('load-networks');
    await expect(networks.getByRole('listitem')).toHaveText([/Globe$/, /TM$/, /Smart$/, /TNT$/, /DITO$/, /GOMO$/]); // logo (or badge) + name
    await expect(page.getByTestId('load-network-GLOBE').locator('img')).toHaveAttribute('src', '/img/telcos/globe.png');
    await expect(page.getByTestId('load-network-SMART').locator('img')).toHaveAttribute('src', '/img/telcos/smart.png');
    await expect(page.getByTestId('load-network-TM').locator('img')).toHaveAttribute('src', '/img/telcos/tm.png');
    const broken = await networks.locator('img').evaluateAll((imgs) =>
      Promise.all(imgs.map((img) => (img as HTMLImageElement).decode().then(() => null, () => (img as HTMLImageElement).src))));
    expect(broken.filter(Boolean)).toEqual([]);

    await page.getByTestId('load-mobile').fill('09761234567'); // GOMO
    await expect(networks).toBeHidden();
    await expect(page.getByTestId('load-brands').locator('label', { hasText: 'GOMO' }).locator('img')).toHaveAttribute('src', '/img/telcos/gomo.png');
    await page.getByTestId('load-tab-promo').check({ force: true });
    const promos = page.locator('#load-promos .promo-item');
    await expect(promos).toHaveCount(3);
    for (const promo of await promos.all()) await expect(promo.locator('.bank-avatar img')).toHaveAttribute('src', '/img/telcos/gomo.png');
    await expect(page.getByTestId('load-promo-GOMO199')).toContainText('15GB No Expiry');
    await expect(page.getByTestId('load-promo-GOMO199')).toContainText('₱199');
  });

  test('Globe Go+99 promo with MPIN -> receipt, and the net deduction is exactly ₱94.00', async ({ page, request }) => {
    const alice = await createFundedUser(request, 1000, 'Alice Reyes');
    await login(page, alice);
    const before = await getBalanceCents(request, alice);

    await page.getByTestId('open-load').click();
    await page.getByTestId('load-mobile').fill('09171234567');
    await expect(page.getByTestId('load-detect')).toContainText('Globe network detected (0917)');
    await expect(page.getByTestId('load-brand-GLOBE')).toBeChecked(); // Globe preselected (TM also offered)

    await page.getByTestId('load-tab-promo').check({ force: true });
    await page.getByTestId('load-promo-GOPLUS99').click();
    await page.getByTestId('load-continue').click();

    await expect(page.getByTestId('load-summary')).toContainText('09171234567');
    await expect(page.getByTestId('load-summary')).toContainText('Go+99');
    await expect(page.getByTestId('load-total')).toHaveText('₱99.00');
    await expect(page.getByTestId('load-cashback-banner')).toHaveText('🎁 Earn ₱5.00 Cashback on this Load Purchase!');
    await typeCode(page, 'load-mpin-input', alice.mpin);
    await page.getByTestId('load-pay').click();

    await expect(page.getByTestId('receipt-dialog')).toBeVisible();
    await expect(page.getByTestId('receipt-title')).toHaveText('Load Purchase Successful');
    await expect(page.getByTestId('receipt-ref')).toHaveText(/^REF-LOAD-\d{8}-\d{4,}$/);
    await expect(page.getByTestId('receipt-cashback')).toHaveText('🎁 Cashback Earned: ₱5.00');
    await page.getByTestId('receipt-done').click();

    const after = await getBalanceCents(request, alice);
    expect(before - after).toBe(9_400); // ₱99 out, ₱5 back
    await expect(page.getByTestId('balance')).toHaveText(peso(after));
    await expect(page.getByTestId('tx-item').first()).toContainText('Cashback Reward - Buy Load');
    await expect(page.getByTestId('tx-item').nth(1)).toContainText('Buy Load - Globe (09171234567)');
  });

  test('regular load: Smart number, TNT brand, ₱20 shows no cashback banner', async ({ page, request }) => {
    const bob = await createFundedUser(request, 500, 'Bob Cruz');
    await login(page, bob);
    await page.getByTestId('open-load').click();
    await page.getByTestId('load-mobile').fill('09181234567');
    await expect(page.getByTestId('load-detect')).toContainText('Smart network detected');
    await page.getByTestId('load-brand-TNT').check({ force: true });
    await page.getByTestId('load-amount-20').click();
    await page.getByTestId('load-continue').click();
    await expect(page.getByTestId('load-cashback-banner')).toHaveText('Cashback applies to loads of ₱50.00 or more.');
    await typeCode(page, 'load-mpin-input', bob.mpin);
    await page.getByTestId('load-pay').click();
    await expect(page.getByTestId('receipt-title')).toHaveText('Load Purchase Successful');
    expect(await getBalanceCents(request, bob)).toBe(48_000);
  });
});

test.describe('Expired MPIN on Buy Load', () => {
  test('the screen says the MPIN expired, gets a new one without leaving, and the purchase completes', async ({ page, request }) => {
    const carol = await createFundedUser(request, 500, 'Carol Lim');
    await login(page, carol);
    await expireMpin(carol.email); // more than 5 minutes later

    await page.getByTestId('open-load').click();
    await page.getByTestId('load-mobile').fill('09191234567');
    await page.getByTestId('load-amount-100').click();
    await page.getByTestId('load-continue').click();

    await typeCode(page, 'load-mpin-input', carol.mpin);
    await page.getByTestId('load-pay').click();

    // The old MPIN is refused as expired: "get a new MPIN" opens on top of Buy Load
    await expect(page.getByTestId('mpin-reset-dialog')).toBeVisible();
    await expect(page.locator('#mpin-reset-title')).toHaveText('Your MPIN has expired');
    await page.getByTestId('mpin-reset-password').fill(carol.password);
    await page.getByTestId('mpin-reset-submit').click();
    await expect(page.getByTestId('mpin-reveal')).toHaveText(/^\s*\d{6}\s*$/); // wait until it is shown
    const newMpin = (await page.getByTestId('mpin-reveal').textContent())!.trim();
    await page.getByTestId('mpin-saved').click();

    // Back on the Buy Load summary with everything still filled in
    await expect(page.getByTestId('load-dialog')).toBeVisible();
    await expect(page.getByTestId('load-total')).toHaveText('₱100.00');
    await expect(page.getByTestId('load-mpin-input-status')).toContainText('MPIN expires in');
    await typeCode(page, 'load-mpin-input', newMpin);
    await page.getByTestId('load-pay').click();
    await expect(page.getByTestId('receipt-title')).toHaveText('Load Purchase Successful');
    expect(await getBalanceCents(request, carol)).toBe(50_000 - 10_000 + 500);
  });

  test('"Forgot or didn\'t get your MPIN?" is offered on the Buy Load and Pay Bills summaries', async ({ page, request }) => {
    const dan = await createFundedUser(request, 500, 'Dan Cruz');
    await login(page, dan);
    await page.getByTestId('open-load').click();
    await page.getByTestId('load-mobile').fill('09171234567');
    await page.getByTestId('load-amount-50').click();
    await page.getByTestId('load-continue').click();
    await expect(page.getByTestId('load-mpin-input-status')).toContainText('MPIN expires in');
    await page.getByTestId('load-mpin-input-forgot').click();
    await expect(page.getByTestId('mpin-reset-dialog')).toBeVisible();
    await expect(page.locator('#mpin-reset-title')).toHaveText('Get a new MPIN');
  });
});
