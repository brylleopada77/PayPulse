import { spawnSync } from 'node:child_process';
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import {
  createAdmin,
  createFundedAdmin,
  authHeader,
  bankTransfer,
  createFundedUser,
  createUser,
  getBalanceCents,
  transfer,
  type BankTransferData,
  type TestUser,
} from '../helpers/api';
import { ageOutgoingTransactions, checkLedgerIntegrity, glCodeOf, ledgerBalanceCents, tryStatement } from '../helpers/db';

const BDO = { bankCode: 'BDO', accountNumber: '001234567890', accountName: 'Juan Dela Cruz' };
const HELD = 'Transaction Held for Compliance Review';

const get = (request: APIRequestContext, user: TestUser, path: string) =>
  request.get(path, { headers: authHeader(user.token) });
const qaPost = (request: APIRequestContext, user: TestUser, path: string) =>
  request.post(path, { headers: authHeader(user.token) });

/** Complete a bank transfer, answering the OTP step when the amount needs one. */
async function sendToBank(request: APIRequestContext, user: TestUser, data: BankTransferData): Promise<APIResponse> {
  const first = await bankTransfer(request, user, data);
  if (first.status() !== 202) return first;
  const { challengeId, demoCode } = await first.json();
  return bankTransfer(request, user, { ...data, otpChallengeId: challengeId, otp: demoCode });
}

test.describe('General ledger: immutable entries, computed balances', () => {
  test('ledger entries and journals cannot be edited or deleted', async () => {
    expect(await tryStatement('UPDATE ledger_entries SET amount_cents = amount_cents + 1 WHERE id = (SELECT MAX(id) FROM ledger_entries)'))
      .toContain('ledger_entries is immutable');
    expect(await tryStatement('DELETE FROM ledger_entries WHERE id = (SELECT MAX(id) FROM ledger_entries)'))
      .toContain('ledger_entries is immutable');
    expect(await tryStatement('DELETE FROM transactions WHERE id = (SELECT MAX(id) FROM transactions)'))
      .toContain('transactions is immutable');
    expect(await tryStatement("UPDATE transactions SET description = 'edited' WHERE id = (SELECT MAX(id) FROM transactions)"))
      .toContain('transactions is immutable');
  });

  test('there is no stored balance column to edit', async () => {
    expect(await tryStatement('SELECT balance_cents FROM accounts LIMIT 1')).toContain('does not exist');
  });

  test('the API balance is the ledger aggregation', async ({ request }) => {
    const alice = await createFundedUser(request, 300);
    const bob = await createUser(request);
    await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 120.25 });

    expect(await getBalanceCents(request, alice)).toBe(await ledgerBalanceCents(alice.accountNumber));
    expect(await ledgerBalanceCents(alice.accountNumber)).toBe(17975);
    expect(await ledgerBalanceCents(bob.accountNumber)).toBe(12025);
  });

  test('accounts are mapped to GL accounts', async ({ request }) => {
    const alice = await createUser(request);
    expect(await glCodeOf(alice.accountNumber)).toBe('2010'); // Customer Wallet Liabilities
    expect(await glCodeOf('SYS-FEE-INCOME')).toBe('4010'); // Fee Revenue
    expect(await glCodeOf('SYS-BANK-SETTLEMENT')).toBe('1020'); // Bank Clearing - Settled Outbound
    expect(await glCodeOf('SYS-PESONET-CLEARING')).toBe('2020'); // PESONet Clearing - Pending
    expect(await glCodeOf('SYS-EXTERNAL-FUNDING')).toBe('1010'); // Cash at Bank
  });
});

test.describe('Payment switch: ISO 20022 pacs.008', () => {
  test('an InstaPay transfer settles at once and produces a pacs.008 message', async ({ request }) => {
    const alice = await createFundedUser(request, 1000, 'Alice Tan');
    const response = await sendToBank(request, alice, { ...BDO, amount: 500, description: 'Rent October' });

    expect(response.status(), await response.text()).toBe(201);
    const sent = await response.json();
    expect(sent).toMatchObject({ rail: 'INSTAPAY', status: 'SETTLED', iso20022: { messageType: 'pacs.008.001.08' } });

    const message = await (await get(request, alice, `/api/transfers/bank/${sent.transactionId}/iso20022`)).json();
    expect(message).toMatchObject({ messageType: 'pacs.008.001.08', msgId: sent.iso20022.msgId, rail: 'INSTAPAY', status: 'SETTLED' });
    const doc = message.json.FIToFICstmrCdtTrf;
    expect(doc.GrpHdr).toMatchObject({
      MsgId: sent.iso20022.msgId,
      NbOfTxs: '1',
      TtlIntrBkSttlmAmt: { '@Ccy': 'PHP', '#text': '500.00' },
      SttlmInf: { SttlmMtd: 'CLRG', ClrSys: { Prtry: 'INSTAPAY' } },
    });
    expect(doc.CdtTrfTxInf).toMatchObject({
      PmtId: { InstrId: sent.bankReference, EndToEndId: sent.reference, UETR: sent.iso20022.uetr },
      IntrBkSttlmAmt: { '@Ccy': 'PHP', '#text': '500.00' },
      ChrgBr: 'DEBT',
      ChrgsInf: { Amt: { '@Ccy': 'PHP', '#text': '15.00' } },
      Dbtr: { Nm: 'Alice Tan' },
      DbtrAcct: { Id: { Othr: { Id: alice.accountNumber } } },
      CdtrAgt: { FinInstnId: { BICFI: 'BNORPHMMXXX' } },
      Cdtr: { Nm: 'Juan Dela Cruz' },
      CdtrAcct: { Id: { Othr: { Id: '001234567890' } } },
      RmtInf: { Ustrd: 'Rent October' },
    });
  });

  test('the same message is available as ISO 20022 XML', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const sent = await (await sendToBank(request, alice, { ...BDO, amount: 250 })).json();

    const response = await get(request, alice, `/api/transfers/bank/${sent.transactionId}/iso20022?format=xml`);
    const xml = await response.text();

    expect(response.headers()['content-type']).toContain('application/xml');
    expect(xml).toContain('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">');
    expect(xml).toContain(`<MsgId>${sent.iso20022.msgId}</MsgId>`);
    expect(xml).toContain('<IntrBkSttlmAmt Ccy="PHP">250.00</IntrBkSttlmAmt>');
    expect(xml).toContain(`<UETR>${sent.iso20022.uetr}</UETR>`);
  });

  test("you cannot read another customer's payment message", async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const eve = await createUser(request);
    const sent = await (await sendToBank(request, alice, { ...BDO, amount: 100 })).json();

    const response = await get(request, eve, `/api/transfers/bank/${sent.transactionId}/iso20022`);
    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('PAYMENT_MESSAGE_NOT_FOUND');
  });

  test('an unknown rail is rejected', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const response = await bankTransfer(request, alice, { ...BDO, amount: 100, rail: 'SWIFT' });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_RAIL');
  });
});

test.describe('PESONet batch queue', () => {
  test('a PESONet transfer waits in clearing until the cut-off, then settles in a batch', async ({ request }) => {
    const alice = await createFundedAdmin(request, 1000);
    const sent = await (await sendToBank(request, alice, { ...BDO, amount: 400, rail: 'PESONET' })).json();

    // Queued: the money has left the wallet (amount + fee) but not PayPulse yet.
    expect(sent).toMatchObject({ rail: 'PESONET', status: 'QUEUED' });
    expect(await getBalanceCents(request, alice)).toBe(100000 - 41500);
    const queue = await (await get(request, alice, '/api/transfers/pesonet')).json();
    expect(queue.transfers[0]).toMatchObject({ bankReference: sent.bankReference, status: 'QUEUED', batchId: null });
    expect(new Date(queue.nextCutoffAt).getTime()).toBeGreaterThan(Date.now());
    const receipt = await (await get(request, alice, `/api/accounts/me/transactions/${sent.transactionId}/receipt`)).json();
    expect(receipt).toMatchObject({ title: 'Transfer Submitted', status: 'PENDING_SETTLEMENT', rail: 'PESONET' });

    // Cut-off (forced now through the QA sandbox instead of waiting for the clock).
    const { batch } = await (await qaPost(request, alice, '/api/qa/pesonet/run-cutoff')).json();
    expect(batch).toMatchObject({ itemCount: 1, total: '400.00' });
    expect(batch.batchId).toMatch(/^PSN-\d{12}-[0-9A-F]{6}$/);

    const after = await (await get(request, alice, '/api/transfers/pesonet')).json();
    expect(after.transfers[0]).toMatchObject({ status: 'SETTLED', batchId: batch.batchId });
    const message = await (await get(request, alice, `/api/transfers/bank/${sent.transactionId}/iso20022`)).json();
    expect(message.status).toBe('SETTLED');
    const settled = await (await get(request, alice, `/api/accounts/me/transactions/${sent.transactionId}/receipt`)).json();
    expect(settled).toMatchObject({ title: 'Transfer Successful', settlement: { status: 'SETTLED', batchId: batch.batchId } });

    expect(await getBalanceCents(request, alice)).toBe(58500); // settling doesn't touch the wallet again
    expect((await checkLedgerIntegrity([alice.accountNumber])).unbalancedTransactions).toEqual([]);
  });

  test('a cut-off with nothing queued creates no batch', async ({ request }) => {
    const alice = await createAdmin(request);
    expect(await (await qaPost(request, alice, '/api/qa/pesonet/run-cutoff')).json()).toEqual({ batch: null });
  });
});

test.describe('AML: Transaction Held for Compliance Review', () => {
  test('a single transfer above ₱500,000 is held (403) and the account goes under review', async ({ request }) => {
    const alice = await createFundedUser(request, 600_000);
    const bob = await createUser(request);

    const held = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 500_000.01 });

    expect(held.status()).toBe(403);
    const { error } = await held.json();
    expect(error).toMatchObject({
      code: 'TRANSACTION_HELD_FOR_REVIEW',
      message: HELD,
      details: { rule: 'LARGE_TRANSFER', threshold: '500000.00', amount: '500000.01', alertId: expect.any(Number) },
    });
    expect(await getBalanceCents(request, alice)).toBe(60_000_000);

    const compliance = await (await get(request, alice, '/api/accounts/me/compliance')).json();
    expect(compliance.amlStatus).toBe('UNDER_REVIEW');
    expect(compliance.alerts[0]).toMatchObject({ alertId: error.details.alertId, rule: 'LARGE_TRANSFER', status: 'OPEN' });
  });

  test('while under review every outgoing transfer is held; clearing releases the account', async ({ request }) => {
    const alice = await createFundedAdmin(request, 600_000);
    const bob = await createUser(request);
    await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 600_000 });

    const small = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 });
    expect(small.status()).toBe(403);
    expect((await small.json()).error.details.rule).toBe('ACCOUNT_UNDER_REVIEW');
    const bank = await bankTransfer(request, alice, { ...BDO, amount: 10 });
    expect(bank.status()).toBe(403);

    const cleared = await (await qaPost(request, alice, '/api/qa/compliance/clear')).json();
    expect(cleared.amlStatus).toBe('CLEAR');
    expect(cleared.alerts[0].status).toBe('CLEARED');
    expect((await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 })).status()).toBe(201);
  });

  test('exactly ₱500,000 is not an AML case (the daily limit rejects it instead)', async ({ request }) => {
    const alice = await createFundedUser(request, 600_000);
    const bob = await createUser(request);

    const response = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 500_000 });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect((await (await get(request, alice, '/api/accounts/me/compliance')).json()).amlStatus).toBe('CLEAR');
  });

  test('velocity: the 6th transfer within one minute is held', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const bob = await createUser(request);
    const send = () => transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1 });

    // 3 transfers, then move them 11 s back (past the 3-per-10-seconds anti-spam rule), then 2 more.
    for (let i = 0; i < 3; i++) expect((await send()).status()).toBe(201);
    await ageOutgoingTransactions(alice.accountNumber, '11 seconds');
    expect((await send()).status()).toBe(201);
    expect((await send()).status()).toBe(201);

    const sixth = await send();
    expect(sixth.status()).toBe(403);
    expect((await sixth.json()).error).toMatchObject({
      message: HELD,
      details: { rule: 'VELOCITY', transfersInWindow: 6, maxTransfers: 5, windowSeconds: 60 },
    });
    expect(await getBalanceCents(request, alice)).toBe(99500);
  });

  test('velocity counts Express Send and Bank Transfer together', async ({ request }) => {
    const alice = await createFundedUser(request, 1000);
    const bob = await createUser(request);
    for (let i = 0; i < 3; i++) await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 1 });
    await ageOutgoingTransactions(alice.accountNumber, '11 seconds');
    await bankTransfer(request, alice, { ...BDO, amount: 1 });
    await bankTransfer(request, alice, { ...BDO, amount: 1 });

    const sixth = await bankTransfer(request, alice, { ...BDO, amount: 1 });
    expect(sixth.status()).toBe(403);
    expect((await sixth.json()).error.details.rule).toBe('VELOCITY');
  });
});

test.describe('End-of-day reconciliation script', () => {
  test('produces a trial balance and reconciles the GL control accounts', async ({ request }) => {
    // Make sure there's at least one of each movement today.
    const alice = await createFundedUser(request, 1000);
    await sendToBank(request, alice, { ...BDO, amount: 100 });
    await sendToBank(request, alice, { ...BDO, amount: 100, rail: 'PESONET' });

    const run = spawnSync(process.execPath, ['scripts/reconcile-eod.js', '--json'], { encoding: 'utf8', env: process.env });
    expect(run.status, run.stderr).not.toBe(2); // 0 = balanced, 1 = exceptions (e.g. race-bug overdrafts)
    const report = JSON.parse(run.stdout);

    expect(report.trialBalance.map((r: { code: string }) => r.code)).toEqual(['1010', '1020', '2010', '2020', '2030', '3900', '4010', '5010']);
    const status = Object.fromEntries(report.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
    // These must reconcile even while other tests run (the script reads one consistent snapshot).
    for (const id of ['TB-1', 'TB-2', 'LIAB-1', 'LIAB-2', 'EQ-1', 'CASH-1', 'OUT-1', 'PSN-1', 'FEE-1', 'SAV-1', 'SAV-2', 'INT-1', 'MSG-2']) {
      expect(status[id], id).toBe('MATCHED');
    }
    expect(report.auditLog).toMatch(/reports[\\/]eod[\\/]eod-\d{4}-\d{2}-\d{2}-.*\.log$/);
  });
});
