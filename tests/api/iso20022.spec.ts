import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  authHeader,
  bankTransfer,
  createAdmin,
  createFundedAdmin,
  createFundedUser,
  createUser,
  getBalanceCents,
  transfer,
  type TestUser,
} from '../helpers/api';
import { checkLedgerIntegrity, ledgerBalanceCents } from '../helpers/db';

// ISO 20022 Message Inspector: GET /api/v1/transactions/:id/iso20022 serialises a transaction's
// double-entry ledger entries as a pacs.008.001.08 credit transfer (bank transfers: the message
// the payment switch sent).

const iso = (request: APIRequestContext, user: TestUser, id: number, format?: 'xml') =>
  request.get(`/api/v1/transactions/${id}/iso20022${format ? '?format=xml' : ''}`, { headers: authHeader(user.token) });

/** The text of the first <name>...</name> element. */
const element = (xml: string, name: string) => xml.match(new RegExp(`<${name}(?: [^>]*)?>([^<]*)</${name}>`))?.[1];

/** Every opening tag has its closing tag, in order (a well-formed tree). */
function expectWellFormed(xml: string) {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
  const stack: string[] = [];
  for (const [, closing, name, selfClosing] of xml.replace(/<\?[^?]*\?>/, '').matchAll(/<(\/?)([\w:.-]+)[^>]*?(\/?)>/g)) {
    if (selfClosing) continue;
    if (closing) expect(stack.pop(), `</${name}>`).toBe(name);
    else stack.push(name);
  }
  expect(stack).toEqual([]);
}

test.describe('ISO 20022 pacs.008 from the ledger', () => {
  test('Express Send: debtor, creditor, amount, EndToEndId; same message every time; both parties can view it', async ({ request }) => {
    const alice = await createFundedUser(request, 500, 'Alice Mae Tan');
    const bob = await createUser(request, 'Bob Cruz');
    const sent = await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 40, description: 'Lunch <&> snacks' });
    expect(sent.status()).toBe(201);
    const { transactionId } = await sent.json();

    const response = await iso(request, alice, transactionId);
    expect(response.status()).toBe(200);
    const m = await response.json();
    expect(m).toMatchObject({ messageType: 'pacs.008.001.08', rail: 'ON_US', status: 'SETTLED', source: 'LEDGER' });
    expect(m.msgId).toMatch(/^PAYP\d{14}TX\d{8}$/);
    expect(m.msgId.length).toBeLessThanOrEqual(35);
    expect(m.uetr).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(m.endToEndId).toMatch(/^REF-\d{8}-\d{4,}$/);

    const tx = m.json.FIToFICstmrCdtTrf.CdtTrfTxInf;
    expect(tx.IntrBkSttlmAmt).toEqual({ '@Ccy': 'PHP', '#text': '40.00' });
    expect(tx.ChrgsInf.Amt).toEqual({ '@Ccy': 'PHP', '#text': '0.00' });
    expect(tx.Dbtr.Nm).toBe('Alice Mae Tan'); // your own name in full
    expect(tx.DbtrAcct.Id.Othr.Id).toBe(alice.accountNumber);
    expect(tx.Cdtr.Nm).toBe('Bob C.'); // the other party shortened, as on the receipt
    expect(tx.CdtrAcct.Id.Othr.Id).toBe(bob.accountNumber);
    expect(tx.PmtId.EndToEndId).toBe(m.endToEndId);
    expect(tx.RmtInf.Ustrd).toBe('Lunch <&> snacks');
    expect(m.json.FIToFICstmrCdtTrf.GrpHdr.SttlmInf).toEqual({ SttlmMtd: 'INDA' });

    // XML: namespace, escaped remittance text, well-formed
    const xml = await (await iso(request, alice, transactionId, 'xml')).text();
    expect(xml).toContain('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">');
    expect(xml).toContain('<IntrBkSttlmAmt Ccy="PHP">40.00</IntrBkSttlmAmt>');
    expect(xml).toContain('<Ustrd>Lunch &lt;&amp;&gt; snacks</Ustrd>');
    expect(element(xml, 'MsgId')).toBe(m.msgId);
    expectWellFormed(xml);

    // Deterministic: a view of the ledger, not a new payment
    expect((await (await iso(request, alice, transactionId)).json()).msgId).toBe(m.msgId);
    // The recipient sees the same message (with their own name in full)
    const bobView = await (await iso(request, bob, transactionId)).json();
    expect(bobView.msgId).toBe(m.msgId);
    expect(bobView.json.FIToFICstmrCdtTrf.CdtTrfTxInf.Cdtr.Nm).toBe('Bob Cruz');
  });

  test('Pay Bills and Buy Load: the biller / telco is the creditor', async ({ request }) => {
    const alice = await createFundedUser(request, 2_000, 'Alice Tan');

    const bill = await request.post('/api/v1/bills/pay', {
      data: { mpin: alice.mpin, billerCode: 'MERALCO', accountNumber: '1234567890', accountName: 'Juan Dela Cruz', amount: 1000 },
      headers: authHeader(alice.token),
    });
    expect(bill.status(), await bill.text()).toBe(201);
    const billMessage = await (await iso(request, alice, (await bill.json()).transactionId)).json();
    const billTx = billMessage.json.FIToFICstmrCdtTrf.CdtTrfTxInf;
    expect(billMessage.endToEndId).toMatch(/^REF-BILL-\d{8}-\d{4,}$/);
    expect(billTx).toMatchObject({
      IntrBkSttlmAmt: { '@Ccy': 'PHP', '#text': '1000.00' },
      PmtTpInf: { LclInstrm: { Prtry: 'BILLPAY' } },
      Cdtr: { Nm: 'Meralco' },
      CdtrAcct: { Id: { Othr: { Id: '1234567890' } } },
      DbtrAcct: { Id: { Othr: { Id: alice.accountNumber } } },
    });

    const load = await request.post('/api/v1/load/purchase', {
      data: { mpin: alice.mpin, mobileNumber: '09171234567', brand: 'GLOBE', productType: 'PROMO', promoCode: 'GOPLUS99' },
      headers: authHeader(alice.token),
    });
    expect(load.status(), await load.text()).toBe(201);
    const loadMessage = await (await iso(request, alice, (await load.json()).transactionId)).json();
    expect(loadMessage.endToEndId).toMatch(/^REF-LOAD-\d{8}-\d{4,}$/);
    expect(loadMessage.json.FIToFICstmrCdtTrf.CdtTrfTxInf).toMatchObject({
      IntrBkSttlmAmt: { '@Ccy': 'PHP', '#text': '99.00' },
      PmtTpInf: { LclInstrm: { Prtry: 'PREPAIDLOAD' } },
      Cdtr: { Nm: 'Globe prepaid' },
      CdtrAcct: { Id: { Othr: { Id: '09171234567' } } },
      RmtInf: { Ustrd: 'Buy Load - Globe (09171234567)' }, // the ledger transaction's description
    });
  });

  test('bank transfer: the stored payment-switch message, and amount + fee = what left the wallet', async ({ request }) => {
    const alice = await createFundedUser(request, 500);
    const before = await getBalanceCents(request, alice);
    const sent = await bankTransfer(request, alice, { bankCode: 'BDO', accountNumber: '001234567890', accountName: 'Juan Dela Cruz', amount: 100 });
    expect(sent.status(), await sent.text()).toBe(201);
    const { transactionId } = await sent.json();

    const m = await (await iso(request, alice, transactionId)).json();
    expect(m).toMatchObject({ source: 'PAYMENT_SWITCH', rail: 'INSTAPAY' });
    const receipt = await (await request.get(`/api/accounts/me/transactions/${transactionId}/receipt`, { headers: authHeader(alice.token) })).json();
    expect(m.msgId).toBe(receipt.iso20022.msgId);

    const tx = m.json.FIToFICstmrCdtTrf.CdtTrfTxInf;
    const cents = (amt: { '#text': string }) => Math.round(Number(amt['#text']) * 100);
    expect(cents(tx.IntrBkSttlmAmt) + cents(tx.ChrgsInf.Amt)).toBe(before - (await getBalanceCents(request, alice)));
    expect(await ledgerBalanceCents(alice.accountNumber)).toBe(await getBalanceCents(request, alice));
  });

  test('not your transaction: 404; not a credit transfer (a top-up): 422', async ({ request }) => {
    const alice = await createFundedUser(request, 300);
    const bob = await createUser(request);
    const stranger = await createUser(request);
    const { transactionId } = await (await transfer(request, alice, { toAccountNumber: bob.accountNumber, amount: 10 })).json();

    const notYours = await iso(request, stranger, transactionId);
    expect(notYours.status()).toBe(404);
    expect((await notYours.json()).error.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await iso(request, alice, 99_999_999)).status()).toBe(404);
    expect((await request.get('/api/v1/transactions/1/iso20022')).status()).toBe(401);

    const history = await (await request.get('/api/accounts/me/transactions', { headers: authHeader(alice.token) })).json();
    const topUp = history.transactions.find((t: { type: string }) => t.type === 'DEPOSIT');
    const notTransfer = await iso(request, alice, topUp.transactionId);
    expect(notTransfer.status()).toBe(422);
    expect((await notTransfer.json()).error.code).toBe('NOT_A_CREDIT_TRANSFER');
  });
});

test.describe('Chaos Engine: latency and HTTP 500 fault injection (QA sandbox, admins only)', () => {
  const chaos = (extra: Record<string, string>) => ({ 'x-chaos-mode': 'true', ...extra });

  test('an injected 500 runs nothing; the retry with the same Idempotency-Key completes exactly once', async ({ request }) => {
    const admin = await createFundedAdmin(request, 500);
    const bob = await createUser(request);
    const key = crypto.randomUUID();
    const send = () =>
      request.post('/api/transfers', {
        data: { mpin: admin.mpin, toAccountNumber: bob.accountNumber, amount: 75 },
        headers: { ...authHeader(admin.token), 'Idempotency-Key': key, ...chaos({ 'x-chaos-fault': 'error-500', 'x-chaos-drop-attempts': '1' }) },
      });

    const first = await send();
    expect(first.status()).toBe(500);
    expect(first.headers()['x-chaos']).toBe('error-500');
    expect((await first.json()).error).toMatchObject({ code: 'CHAOS_FAULT_INJECTED', details: { chaos: true, retryable: true } });
    expect(await getBalanceCents(request, admin)).toBe(50_000); // nothing moved

    const retry = await send();
    expect(retry.status()).toBe(201);
    expect(await getBalanceCents(request, admin)).toBe(42_500);
    expect(await getBalanceCents(request, bob)).toBe(7_500);
    const report = await checkLedgerIntegrity([admin.accountNumber, bob.accountNumber]);
    expect(report.unbalancedTransactions).toEqual([]);
  });

  test('only money-moving POSTs are faulted (rate 1: reads and logins are untouched)', async ({ request }) => {
    const admin = await createFundedAdmin(request, 100);
    const headers = { ...authHeader(admin.token), ...chaos({ 'x-chaos-fault': 'error-500', 'x-chaos-rate': '1' }) };
    expect((await request.get('/api/accounts/me', { headers })).status()).toBe(200);
    expect((await request.post('/api/auth/login', { data: { email: admin.email, password: admin.password }, headers })).status()).toBe(200);
    const bill = await request.post('/api/v1/bills/pay', {
      data: { mpin: admin.mpin, billerCode: 'MERALCO', accountNumber: '1234567890', accountName: 'Juan Dela Cruz', amount: 50 },
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
    });
    expect(bill.status()).toBe(500);
    expect((await bill.json()).error.code).toBe('CHAOS_FAULT_INJECTED');
    expect(await getBalanceCents(request, admin)).toBe(10_000);
  });

  test('latency: x-chaos-latency-ms delays the request; customers cannot use chaos at all', async ({ request }) => {
    const admin = await createAdmin(request);
    const started = Date.now();
    const slow = await request.get('/api/accounts/me', { headers: { ...authHeader(admin.token), ...chaos({ 'x-chaos-latency-ms': '1200' }) } });
    expect(slow.status()).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1150);
    expect(slow.headers()['x-chaos']).toBe('latency-1200ms');

    const customer = await createFundedUser(request, 100);
    const bob = await createUser(request);
    const normal = await request.post('/api/transfers', {
      data: { mpin: customer.mpin, toAccountNumber: bob.accountNumber, amount: 10 },
      headers: { ...authHeader(customer.token), ...chaos({ 'x-chaos-fault': 'error-500', 'x-chaos-rate': '1' }) },
    });
    expect(normal.status()).toBe(201);
    expect(normal.headers()['x-chaos']).toBeUndefined();
  });
});
