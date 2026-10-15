import { test, expect, type APIRequestContext } from '@playwright/test';
import { authHeader, bankTransfer, createFundedUser, createUser, transfer, type TestUser } from '../helpers/api';

const REFERENCE = /^REF-\d{8}-\d{4,}$/;

function getReceipt(request: APIRequestContext, user: TestUser, transactionId: unknown) {
  return request.get(`/api/accounts/me/transactions/${transactionId}/receipt`, { headers: authHeader(user.token) });
}

async function latestTransactionId(request: APIRequestContext, user: TestUser): Promise<number> {
  const history = await (await request.get('/api/accounts/me/transactions', { headers: authHeader(user.token) })).json();
  return history.transactions[0].transactionId;
}

test.describe('Transaction receipts', () => {
  test('an Express Send receipt, seen by the sender and by the recipient', async ({ request }) => {
    const alice = await createFundedUser(request, 500, 'Alice Tan');
    const bob = await createUser(request, 'Bob Cruz');
    const sent = await (
      await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 120.5, description: 'Lunch' })
    ).json();
    expect(sent.reference).toMatch(REFERENCE);

    const forAlice = await getReceipt(request, alice, sent.transactionId);
    expect(forAlice.status()).toBe(200);
    expect(await forAlice.json()).toMatchObject({
      reference: sent.reference,
      title: 'Transfer Successful',
      direction: 'SENT',
      status: 'SUCCESSFUL',
      amount: '120.50',
      fee: '0.00',
      total: '120.50',
      sender: { name: 'Alice Tan', account: alice.accountNumber },
      recipient: { name: 'Bob C.', account: bob.accountNumber },
      bankName: 'PayPulse',
      note: 'Lunch',
    });

    const forBob = await (await getReceipt(request, bob, sent.transactionId)).json();
    expect(forBob).toMatchObject({
      reference: sent.reference,
      title: 'Money Received',
      direction: 'RECEIVED',
      sender: { name: 'Alice T.', account: alice.accountNumber },
      recipient: { name: 'Bob Cruz', account: bob.accountNumber },
    });
  });

  test('a Bank Transfer receipt shows the bank, fee and total', async ({ request }) => {
    const alice = await createFundedUser(request, 1000, 'Alice Tan');
    const sent = await (
      await bankTransfer(request, alice, { bankCode: 'BPI', accountNumber: '1234567890', accountName: 'Jose Rizal', amount: 300 })
    ).json();

    const receipt = await (await getReceipt(request, alice, sent.transactionId)).json();

    expect(receipt).toMatchObject({
      reference: sent.reference,
      type: 'BANK_TRANSFER',
      title: 'Transfer Successful',
      amount: '300.00',
      fee: '15.00',
      total: '315.00',
      sender: { name: 'Alice Tan', account: alice.accountNumber },
      recipient: { name: 'Jose Rizal', account: '••••7890' },
      bankName: 'BPI',
      bankReference: sent.bankReference,
    });
  });

  test('a top-up receipt', async ({ request }) => {
    const alice = await createFundedUser(request, 250, 'Alice Tan');
    const receipt = await (await getReceipt(request, alice, await latestTransactionId(request, alice))).json();

    expect(receipt).toMatchObject({
      type: 'DEPOSIT',
      title: 'Top-up Successful',
      direction: 'RECEIVED',
      amount: '250.00',
      recipient: { name: 'Alice Tan', account: alice.accountNumber },
    });
    expect(receipt.reference).toMatch(REFERENCE);
  });

  test('the history and the receipt use the same reference', async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const history = await (await request.get('/api/accounts/me/transactions', { headers: authHeader(alice.token) })).json();
    const [row] = history.transactions;

    const receipt = await (await getReceipt(request, alice, row.transactionId)).json();
    expect(receipt.reference).toBe(row.reference);
  });

  test("you cannot open someone else's receipt", async ({ request }) => {
    const alice = await createFundedUser(request, 100);
    const eve = await createUser(request);

    const response = await getReceipt(request, eve, await latestTransactionId(request, alice));

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('RECEIPT_NOT_FOUND');
  });

  for (const id of ['abc', '0', '-1', '99999999']) {
    test(`an invalid or unknown transaction id is rejected: ${id}`, async ({ request }) => {
      const alice = await createUser(request);
      expect((await getReceipt(request, alice, id)).status()).toBe(404);
    });
  }
});
