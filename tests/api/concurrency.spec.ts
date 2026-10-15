import { test, expect } from '@playwright/test';
import { createFundedUser, createUser, getBalanceCents, transfer } from '../helpers/api';
import { checkLedgerIntegrity } from '../helpers/db';

// PayPulse ships with a KNOWN race-condition bug in POST /api/transfers (see QA_NOTES.md).
// While RACE_BUG_EXPECTED is not "false", this test is marked as an expected failure:
//   - it stays green while the bug exists,
//   - it turns RED if the bug is fixed, reminding you to set RACE_BUG_EXPECTED=false.
const RACE_BUG_EXPECTED = process.env.RACE_BUG_EXPECTED !== 'false';

const STARTING_BALANCE = 100; // PHP
const TRANSFER_AMOUNT = 30; // PHP
const PARALLEL_REQUESTS = 10;

test.describe('Concurrency', () => {
  test('10 simultaneous transfers cannot spend more than the balance', async ({ request }) => {
    test.fail(RACE_BUG_EXPECTED, 'Known bug: concurrent transfers can create money (QA_NOTES.md)');

    const sender = await createFundedUser(request, STARTING_BALANCE, 'Double Clicker');
    const receiver = await createUser(request, 'Lucky Receiver');

    // Fire all requests at the same moment, like a user hammering the "Send" button.
    const responses = await Promise.all(
      Array.from({ length: PARALLEL_REQUESTS }, () =>
        transfer(request, sender, { toAccountNumber: receiver.accountNumber, amount: TRANSFER_AMOUNT }),
      ),
    );

    const statuses = responses.map((r) => r.status());
    const succeeded = statuses.filter((s) => s === 201).length;
    // 422 = insufficient funds, 429 = anti-spam rule (more than 3 transfers in 10 seconds)
    const rejected = statuses.filter((s) => s === 422 || s === 429).length;
    console.log(`Statuses: ${statuses.join(', ')}  ->  ${succeeded} succeeded, ${rejected} rejected`);

    const senderBalance = await getBalanceCents(request, sender);
    const receiverBalance = await getBalanceCents(request, receiver);
    const report = await checkLedgerIntegrity([sender.accountNumber, receiver.accountNumber]);
    console.log(
      `Sender: ${senderBalance / 100}, Receiver: ${receiverBalance / 100}, ` +
        `Total: ${(senderBalance + receiverBalance) / 100} (should be ${STARTING_BALANCE})`,
    );

    const maxPossible = Math.floor(STARTING_BALANCE / TRANSFER_AMOUNT);
    expect.soft(succeeded, 'more transfers succeeded than the balance allows').toBeLessThanOrEqual(maxPossible);
    expect.soft(succeeded + rejected, 'every request should be a 201, 422 or 429').toBe(PARALLEL_REQUESTS);
    expect.soft(senderBalance + receiverBalance, 'money was created or destroyed').toBe(STARTING_BALANCE * 100);
    expect.soft(senderBalance).toBe(STARTING_BALANCE * 100 - succeeded * TRANSFER_AMOUNT * 100);
    expect.soft(report.mismatchedAccounts, 'cached balances disagree with the ledger').toEqual([]);
  });
});
