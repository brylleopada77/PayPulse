/**
 * Automated accessibility (a11y) checks with axe-core: WCAG 2.0 / 2.1 / 2.2 level A + AA rules on
 * every main screen and dialog, in the light and the dark theme.
 *
 * A scan fails on ANY violation (soft assertion: the test goes on and reports every screen). The full axe result of every scan is attached to the HTML report
 * (axe-<screen>.json), and the failure message lists rule, impact, help URL and the offending
 * elements, so a regression points straight at the markup to fix.
 *
 * axe catches roughly a third to a half of WCAG issues (contrast, names, roles, ARIA, structure);
 * keyboard flow and focus handling are covered by the keyboard tests at the bottom.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createAdmin, createFundedUser, createUser, transfer, type TestUser } from '../helpers/api';
import { login } from '../helpers/ui';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Run axe on the page (or one part of it), attach the result, and fail with a readable list. */
async function expectNoViolations(page: Page, testInfo: TestInfo, screen: string, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  await testInfo.attach(`axe-${screen}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });

  const report = results.violations.map(
    (v) => `• [${v.impact}] ${v.id}: ${v.help} (${v.helpUrl})\n` +
      v.nodes.slice(0, 5).map((n) => `    ${n.target.join(' ')}\n      ${n.failureSummary?.split('\n').join('\n      ')}`).join('\n'),
  );
  // soft: one test scans several screens, and every screen's violations are reported
  expect.soft(report, `${screen}: ${results.violations.length} accessibility violation(s)\n${report.join('\n')}`).toEqual([]);
  expect(results.passes.length, `${screen}: axe ran its rules`).toBeGreaterThan(0);
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => localStorage.setItem('paypulse.theme', t), theme);
}

/** A user with some history (a sent transfer and a top-up) so lists and receipts are not empty. */
async function userWithHistory(request: Parameters<typeof createUser>[0]): Promise<TestUser> {
  const alice = await createFundedUser(request, 1_000, 'Alice Tan');
  const bob = await createUser(request, 'Bob Cruz');
  expect((await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 40, description: 'Lunch' })).status()).toBe(201);
  return alice;
}

test.use({ reducedMotion: 'reduce' }); // scan the settled UI, not mid-animation colours

for (const theme of ['light', 'dark'] as const) {
  test.describe(`Accessibility (axe-core, WCAG 2.2 AA): ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => setTheme(page, theme));

    test('login and register screens', async ({ page }, testInfo) => {
      await page.goto('/');
      await expect(page.getByTestId('login-email')).toBeVisible();
      await expectNoViolations(page, testInfo, `${theme}-login`);
      await page.getByTestId('tab-register').click();
      await expect(page.getByTestId('register-name')).toBeVisible();
      await expectNoViolations(page, testInfo, `${theme}-register`);
    });

    test('home screen with balance, products, quick actions and history', async ({ page, request }, testInfo) => {
      await login(page, await userWithHistory(request));
      await expect(page.getByTestId('tx-item').first()).toBeVisible();
      await expectNoViolations(page, testInfo, `${theme}-home`);
    });

    test('money dialogs: Send, Pay Bills, Buy Load', async ({ page, request }, testInfo) => {
      await login(page, await userWithHistory(request));
      for (const [opener, dialog] of [['open-send', 'send-dialog'], ['open-bills', 'bills-dialog'], ['open-load', 'load-dialog']]) {
        await page.getByTestId(opener).click();
        await expect(page.getByTestId(dialog)).toBeVisible();
        await expectNoViolations(page, testInfo, `${theme}-${dialog}`, `[data-testid="${dialog}"]`);
        await page.keyboard.press('Escape');
        await expect(page.getByTestId(dialog)).toBeHidden();
      }
    });

    test('Bank Transfer: the bank picker, closed and open', async ({ page, request }, testInfo) => {
      await login(page, await userWithHistory(request));
      await page.getByTestId('open-send').click();
      await page.getByTestId('method-bank').click();
      await expect(page.getByTestId('bank-trigger-name')).toHaveText('GCash');
      await expectNoViolations(page, testInfo, `${theme}-bank-picker`, '[data-testid="send-dialog"]');
      await page.getByTestId('bank-trigger').click();
      await expect(page.getByTestId('bank-grid')).toBeVisible();
      await page.keyboard.press('ArrowRight'); // a focused, checked card too
      await expectNoViolations(page, testInfo, `${theme}-bank-picker-open`, '[data-testid="send-dialog"]');

      // a bank with both channels, PESONet chosen, then the InstaPay cap warning
      await page.getByTestId('bank-grid').getByRole('radio', { name: 'AUB InstaPay PESONet' }).click();
      await page.getByTestId('channel-pesonet').click();
      await expectNoViolations(page, testInfo, `${theme}-bank-channel`, '[data-testid="send-dialog"]');
      await page.getByTestId('channel-instapay').click();
      await page.getByTestId('bank-amount').fill('60000');
      await expect(page.getByTestId('bank-use-pesonet')).toBeVisible();
      await expectNoViolations(page, testInfo, `${theme}-bank-limit-warning`, '[data-testid="send-dialog"]');
    });

    test('Cash In over the counter: partners, amount and the payment code', async ({ page, request }, testInfo) => {
      await login(page, await userWithHistory(request));
      await page.getByTestId('open-otc').click();
      await expect(page.getByTestId('otc-partners')).toBeVisible();
      await expectNoViolations(page, testInfo, `${theme}-otc-partners`, '[data-testid="otc-dialog"]');
      await page.getByTestId('otc-partners').getByRole('radio', { name: /7-Eleven/ }).click();
      await page.getByTestId('otc-amount').fill('500');
      await expectNoViolations(page, testInfo, `${theme}-otc-amount`, '[data-testid="otc-dialog"]');
      await page.getByTestId('otc-generate').click();
      await expect(page.getByTestId('otc-ref')).toHaveText(/^\d{4} \d{4} \d{4}$/);
      await expectNoViolations(page, testInfo, `${theme}-otc-code`, '[data-testid="otc-dialog"]');
    });

    test('receipt and the ISO 20022 Message Inspector tab', async ({ page, request }, testInfo) => {
      await login(page, await userWithHistory(request));
      await page.getByTestId('tx-item').first().click();
      await expect(page.getByTestId('receipt-title')).toBeVisible();
      await expectNoViolations(page, testInfo, `${theme}-receipt`, '#receipt-dialog');
      await page.getByTestId('receipt-tab-iso').click();
      await expect(page.getByTestId('iso-xml')).toContainText('Document');
      await expectNoViolations(page, testInfo, `${theme}-iso-inspector`, '#receipt-dialog');
    });

    test('notifications, profile and the logout confirmation', async ({ page, request }, testInfo) => {
      await login(page, await userWithHistory(request));
      await page.getByTestId('notifications').click();
      await expect(page.getByTestId('notif-dialog')).toBeVisible();
      await expectNoViolations(page, testInfo, `${theme}-notifications`, '#notif-dialog');
      await page.keyboard.press('Escape');

      await page.getByTestId('open-profile').click();
      await expect(page.getByTestId('profile-dialog')).toBeVisible();
      await expectNoViolations(page, testInfo, `${theme}-profile`, '#profile-dialog');
      await page.keyboard.press('Escape');

      await page.getByTestId('logout').click();
      await expect(page.getByTestId('logout-dialog')).toBeVisible();
      await expectNoViolations(page, testInfo, `${theme}-logout`, '#logout-dialog');
    });

    test('QA Sandbox panel with the Chaos Engine (admin)', async ({ page, request }, testInfo) => {
      await login(page, await createAdmin(request));
      await page.getByTestId('qa-toggle').click();
      await expect(page.getByTestId('chaos-engine')).toBeVisible();
      await expectNoViolations(page, testInfo, `${theme}-qa-panel`, '#qa-panel');
    });
  });
}

test.describe('Accessibility: keyboard', () => {
  test('the login form can be completed with the keyboard alone', async ({ page, request }) => {
    const alice = await createUser(request);
    await page.goto('/');
    await page.getByTestId('login-email').focus();
    await page.keyboard.type(alice.email);
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('login-password')).toBeFocused();
    await page.keyboard.type(alice.password);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('balance')).not.toHaveText('—');
  });

  test('a dialog traps focus while open and gives it back to its opener when closed', async ({ page, request }) => {
    await login(page, await userWithHistory(request));
    const opener = page.getByTestId('open-send');
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('send-dialog')).toBeVisible();
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      // focus never leaves the modal dialog (the rest of the page is inert)
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#send-dialog')) || document.activeElement === document.body)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('send-dialog')).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('receipt tabs follow the ARIA tabs pattern (arrow keys switch tabs)', async ({ page, request }) => {
    await login(page, await userWithHistory(request));
    await page.getByTestId('tx-item').first().click();
    // wait until the receipt has loaded (opening it resets the tabs to "Receipt")
    await expect(page.getByTestId('receipt-title')).toHaveText('Transfer Successful');
    await expect(page.getByTestId('receipt-tabs')).toBeVisible();
    const receiptTab = page.getByTestId('receipt-tab-receipt');
    await receiptTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('receipt-tab-iso')).toBeFocused();
    await expect(page.getByTestId('receipt-tab-iso')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('iso-inspector')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(receiptTab).toBeFocused();
    await expect(page.getByTestId('receipt-body')).toBeVisible();
  });
});
