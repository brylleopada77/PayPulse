import { expect, type Page } from '@playwright/test';
import type { TestUser } from './api';

/** Log in through the web wallet and wait until the balance has loaded. */
export async function login(page: Page, user: TestUser) {
  await page.goto('/');
  await page.getByTestId('login-email').fill(user.email);
  await page.getByTestId('login-password').fill(user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('balance')).not.toHaveText('—');
}

/** Type a 6-digit MPIN/OTP into one of the app's code boxes (by its container test id). */
export async function typeCode(page: Page, containerTestId: string, digits: string) {
  await page.getByTestId(containerTestId).locator('input').first().click();
  await page.keyboard.type(digits);
}

/** "₱1,005.00" for 100500 cents, as the app displays money. */
export const peso = (cents: number) =>
  `₱${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
