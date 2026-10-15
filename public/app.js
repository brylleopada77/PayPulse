// PayPulse web wallet: plain JavaScript talking to the PayPulse REST API.
(() => {
  const TOKEN_KEY = 'paypulse.token';
  const REFRESH_MS = 10_000;

  const $ = (selector) => document.querySelector(selector);
  const authView = $('#auth-view');
  const appView = $('#app-view');
  let currency = 'PHP';
  let hasMpin = true; // false for accounts created before random MPINs
  let mpinDeadline = 0; // Date.now() value when the current MPIN expires
  let refreshTimer = null;

  // ---------- API helper ----------

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401 && token) {
      logout(data.error?.message || 'Your session has expired. Please log in again.');
    }
    if (!res.ok) {
      const err = new Error(data.error?.message || `Request failed (${res.status})`);
      err.code = data.error?.code;
      err.status = res.status;
      throw err;
    }
    return { ...data, httpStatus: res.status };
  }

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  function setToken(token) {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch { /* storage unavailable: session lasts until reload */ }
  }

  // ---------- Formatting ----------

  function money(amount) {
    return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(Number(amount));
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  }

  /** 287 -> "4:47" */
  function formatCountdown(seconds) {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function setMpinExpiry(secondsLeft) {
    mpinDeadline = Date.now() + secondsLeft * 1000;
  }

  function mpinSecondsLeft() {
    return Math.max(0, Math.ceil((mpinDeadline - Date.now()) / 1000));
  }

  function describe(tx) {
    if (tx.type === 'DEPOSIT') return { title: 'Added money', icon: '+' };
    if (tx.type === 'BANK_TRANSFER') return { title: tx.description, icon: '🏦' };
    if (tx.direction === 'DEBIT') return { title: 'Money sent', icon: '↗' };
    return { title: 'Money received', icon: '↙' };
  }

  // ---------- UI helpers ----------

  // Toast and SMS banner are popovers so they show above open dialogs (top layer).
  function showPopover(el) {
    if (el.matches(':popover-open')) el.hidePopover(); // re-show to move it on top
    el.showPopover();
  }
  function hidePopover(el) {
    if (el.matches(':popover-open')) el.hidePopover();
  }

  let toastTimer = null;
  function toast(message, kind = '') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    showPopover(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hidePopover(el), 3500);
  }

  /** Phone-style notification standing in for a real SMS or email (mock delivery). */
  let mockMessageTimer = null;
  function showMockMessage(app, text, durationMs = 12_000) {
    const el = $('#sms');
    $('#sms-app').textContent = app;
    $('#sms-text').textContent = text;
    showPopover(el);
    clearTimeout(mockMessageTimer);
    mockMessageTimer = setTimeout(() => hidePopover(el), durationMs);
  }

  function showMockSms(code) {
    showMockMessage(
      '💬 Messages',
      `PayPulse: Your OTP is ${code}. It expires in 30 seconds. Never share this code with anyone.`,
    );
  }

  function setFormError(form, message = '') {
    form.querySelector('.form-error').textContent = message;
  }

  function formData(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  /** Row of single-digit boxes (MPIN / OTP) with auto-advance, backspace and paste. */
  function createCodeInput(container) {
    const length = Number(container.dataset.length);
    const secret = container.hasAttribute('data-secret');
    const boxes = Array.from({ length }, (_, i) => {
      const input = document.createElement('input');
      input.type = secret ? 'password' : 'text';
      input.inputMode = 'numeric';
      input.autocomplete = secret ? 'off' : 'one-time-code';
      input.setAttribute('aria-label', `Digit ${i + 1}`);
      input.dataset.testid = `${container.id}-digit`;
      container.append(input);
      return input;
    });

    function fillFrom(index, text) {
      const digits = text.replace(/\D/g, '').split('');
      let i = index;
      for (const digit of digits) {
        if (i >= length) break;
        boxes[i].value = digit;
        i += 1;
      }
      boxes[Math.min(i, length - 1)].focus();
    }

    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        const text = box.value;
        box.value = '';
        fillFrom(i, text); // handles typing, autofill and multi-digit input
      });
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Backspace' && !box.value && i > 0) {
          boxes[i - 1].value = '';
          boxes[i - 1].focus();
          event.preventDefault();
        } else if (event.key === 'ArrowLeft' && i > 0) {
          boxes[i - 1].focus();
        } else if (event.key === 'ArrowRight' && i < length - 1) {
          boxes[i + 1].focus();
        }
      });
      box.addEventListener('paste', (event) => {
        event.preventDefault();
        fillFrom(i, event.clipboardData.getData('text'));
      });
    });

    return {
      value: () => boxes.map((b) => b.value).join(''),
      clear: () => { boxes.forEach((b) => { b.value = ''; }); boxes[0].focus(); },
      focus: () => boxes[0].focus(),
      setDisabled: (disabled) => boxes.forEach((b) => { b.disabled = disabled; }),
    };
  }

  // ---------- Show / hide password ----------

  const EYE_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.8M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/></svg>';

  /** Add an eye button to every password field (not the MPIN/OTP digit boxes). */
  function addPasswordToggles() {
    document.querySelectorAll('.form label > input[type="password"]').forEach((input) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'password-field';
      input.replaceWith(wrapper);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'password-toggle';
      if (input.dataset.testid) button.dataset.testid = `${input.dataset.testid}-toggle`;
      wrapper.append(input, button);

      const setVisible = (visible) => {
        input.type = visible ? 'text' : 'password';
        button.innerHTML = visible ? EYE_OFF_ICON : EYE_ICON;
        button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
        button.setAttribute('aria-pressed', String(visible));
        button.title = visible ? 'Hide password' : 'Show password';
      };
      setVisible(false);

      button.addEventListener('click', (event) => {
        event.preventDefault(); // don't let the surrounding <label> refocus/submit anything
        setVisible(input.type === 'password');
        input.focus();
      });
      // Hide again whenever the form is cleared (after login, sign-up, reopening a dialog).
      input.form?.addEventListener('reset', () => setVisible(false));
    });
  }
  addPasswordToggles();

  // ---------- Hide / show balance ----------

  const HIDE_BALANCE_KEY = 'paypulse.hideBalance';
  let currentBalance = null;
  let balanceHidden = false;
  try { balanceHidden = localStorage.getItem(HIDE_BALANCE_KEY) === '1'; } catch { /* storage unavailable */ }

  function renderBalance() {
    const el = $('#balance');
    if (currentBalance === null) {
      el.textContent = '—';
    } else {
      el.textContent = balanceHidden ? '₱ ••••••' : money(currentBalance);
    }
    el.classList.toggle('masked', balanceHidden);

    const button = $('#balance-toggle');
    button.innerHTML = balanceHidden ? EYE_ICON : EYE_OFF_ICON;
    const label = balanceHidden ? 'Show balance' : 'Hide balance';
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(balanceHidden));
    button.title = label;
  }

  $('#balance-toggle').addEventListener('click', () => {
    balanceHidden = !balanceHidden;
    try { localStorage.setItem(HIDE_BALANCE_KEY, balanceHidden ? '1' : '0'); } catch { /* not remembered */ }
    renderBalance();
  });
  renderBalance();

  // ---------- Views ----------

  function showAuth() {
    stopAutoRefresh();
    appView.hidden = true;
    authView.hidden = false;
  }

  async function showWallet() {
    authView.hidden = true;
    appView.hidden = false;
    await loadWallet();
    startAutoRefresh();
    if (!hasMpin) openMpinReset('setup');
  }

  async function loadWallet() {
    const [account, history] = await Promise.all([
      api('/api/accounts/me'),
      api('/api/accounts/me/transactions'),
    ]);
    currency = account.currency;
    hasMpin = account.hasMpin;
    setMpinExpiry(account.mpinExpiresInSeconds);
    $('#user-name').textContent = account.accountHolder;
    currentBalance = account.balance;
    renderBalance();
    $('#account-number').textContent = account.accountNumber;
    renderTransactions(history.transactions);
  }

  function renderTransactions(transactions) {
    const list = $('#tx-list');
    list.replaceChildren();
    $('#tx-empty').hidden = transactions.length > 0;

    for (const tx of transactions) {
      const { title, icon } = describe(tx);
      const incoming = tx.direction === 'CREDIT';

      const li = document.createElement('li');
      li.className = `tx ${incoming ? 'in' : 'out'}`;
      li.dataset.testid = 'tx-item';
      // Each row opens its receipt (click, Enter or Space).
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-label', `${title}, ${money(tx.amount)}. View receipt`);
      li.addEventListener('click', () => openReceipt(tx.transactionId));
      li.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openReceipt(tx.transactionId);
        }
      });

      const iconEl = document.createElement('span');
      iconEl.className = 'tx-icon';
      iconEl.textContent = icon;

      const info = document.createElement('div');
      const titleEl = document.createElement('div');
      titleEl.className = 'tx-title';
      titleEl.textContent = title;
      const meta = document.createElement('div');
      meta.className = 'tx-date';
      const bt = tx.bankTransfer;
      meta.textContent = bt
        ? `${bt.accountName} ${bt.accountNumber} · ${money(bt.amount)} + ${money(bt.fee)} fee · ${formatDate(tx.createdAt)}`
        : `${tx.description} · ${formatDate(tx.createdAt)}`;
      info.append(titleEl, meta);

      const amountEl = document.createElement('span');
      amountEl.className = 'tx-amount';
      amountEl.textContent = `${incoming ? '+' : '−'}${money(tx.amount)}`;

      li.append(iconEl, info, amountEl);
      list.append(li);
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    // Picks up money received from other users without a manual refresh.
    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') loadWallet().catch(() => {});
    }, REFRESH_MS);
  }

  function stopAutoRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function logout(message) {
    setToken(null);
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    hidePopover($('#sms'));
    showAuth();
    if (message) toast(message, 'error');
  }

  // ---------- Auth ----------

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const isLogin = tab.dataset.tab === 'login';
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('#login-form').hidden = !isLogin;
      $('#register-form').hidden = isLogin;
    });
  });

  async function login(email, password) {
    const { token } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    setToken(token);
    await showWallet();
  }

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { email, password } = formData(form);
    setFormError(form);
    try {
      await login(email, password);
      form.reset();
    } catch (err) {
      setFormError(form, err.message);
    }
  });

  $('#register-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { fullName, email, password, mobileNumber } = formData(form);
    setFormError(form);
    try {
      const { mpin, mpinExpiresInSeconds } = await api('/api/auth/register', {
        method: 'POST',
        body: { fullName, email, password, mobileNumber: mobileNumber.trim() || undefined },
      });
      await login(email, password);
      form.reset();
      showMpinReveal(mpin, mpinExpiresInSeconds);
      toast('Welcome to PayPulse! Your wallet is ready.', 'success');
    } catch (err) {
      setFormError(form, err.message);
    }
  });

  $('#logout-btn').addEventListener('click', () => logout());

  // ---------- Wallet actions ----------

  document.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.open === 'send-dialog') return openSendDialog();
      const dialog = document.getElementById(btn.dataset.open);
      const form = dialog.querySelector('form');
      form.reset();
      setFormError(form);
      dialog.showModal();
    });
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  });

  $('#refresh-btn').addEventListener('click', () => {
    loadWallet().then(() => toast('Balance updated')).catch((err) => toast(err.message, 'error'));
  });

  /** Copy text to the clipboard; falls back to the older method where the Clipboard API is blocked. */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
      area.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      // Inside an open <dialog> the textarea must live in the dialog to be focusable.
      (document.querySelector('dialog[open]') || document.body).append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  }

  $('#copy-btn').addEventListener('click', async () => {
    if (await copyText($('#account-number').textContent)) toast('Account number copied');
    else toast('Could not copy. Select the number and copy it manually.', 'error');
  });

  document.querySelectorAll('[data-amount]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#topup-form').elements.amount.value = chip.dataset.amount;
    });
  });

  $('#topup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { amount, outcome } = formData(form);
    setFormError(form);
    try {
      const result = await api('/api/payments/mock-checkout', {
        method: 'POST',
        body: { amount: amount.trim(), outcome },
      });
      if (!result.credited) {
        setFormError(form, 'Payment was declined by the card issuer. No money was added.');
        return;
      }
      form.closest('dialog').close();
      toast(`${money(result.amount)} added to your wallet`, 'success');
      await loadWallet();
    } catch (err) {
      setFormError(form, err.message);
    }
  });

  // ---------- Send money: details -> MPIN -> (OTP above ₱1,000) ----------

  const sendDialog = $('#send-dialog');
  const sendForm = $('#send-form');
  const mpinDialog = $('#mpin-dialog');
  const mpinForm = $('#mpin-form');
  const otpDialog = $('#otp-dialog');
  const otpForm = $('#otp-form');
  const mpinInput = createCodeInput($('#mpin-input'));
  const otpInput = createCodeInput($('#otp-input'));

  const bankForm = $('#bank-form');

  /**
   * The transfer being confirmed:
   * { method: 'express' | 'bank', endpoint, body, summary, mpin?, challengeId? }
   * `body` is what the API needs (without mpin / OTP), `summary` is shown on the MPIN pad.
   */
  let pending = null;
  let otpTimer = null;

  const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
  const validAmount = (value) => AMOUNT_PATTERN.test(value) && Number(value) > 0;

  // ----- Step navigation inside the Send dialog -----

  function showSendStep(step) {
    sendDialog.querySelectorAll('[data-step]').forEach((el) => { el.hidden = el.dataset.step !== step; });
  }

  function openSendDialog() {
    pending = null;
    for (const form of [sendForm, bankForm]) {
      form.reset();
      setFormError(form);
    }
    showSendStep('choose');
    sendDialog.showModal();
  }

  sendDialog.querySelectorAll('[data-method]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.method === 'bank') {
        await loadBanks();
        updateBankForm();
      }
      showSendStep(btn.dataset.method);
      sendDialog.querySelector(`[data-step="${btn.dataset.method}"] input, [data-step="${btn.dataset.method}"] select`)?.focus();
    });
  });
  sendDialog.querySelectorAll('[data-back]').forEach((btn) => btn.addEventListener('click', () => showSendStep('choose')));
  $('#review-back').addEventListener('click', () => showSendStep(pending?.method || 'choose'));

  // ----- Bank list + fee (from GET /api/transfers/banks) -----

  let bankInfo = null; // { feeCents, banks: [{ code, name, accountType }] }

  async function loadBanks() {
    if (bankInfo) return;
    try {
      bankInfo = await api('/api/transfers/banks');
    } catch {
      bankInfo = { feeCents: 1500, banks: [] };
    }
    $('#bank-form').elements.bankCode.replaceChildren(
      ...bankInfo.banks.map((b) => Object.assign(document.createElement('option'), { value: b.code, textContent: b.name })),
    );
  }

  const selectedBank = () => bankInfo?.banks.find((b) => b.code === bankForm.elements.bankCode.value);

  function updateBankForm() {
    const bank = selectedBank();
    const input = bankForm.elements.accountNumber;
    if (bank?.accountType === 'MOBILE') {
      $('#bank-account-label').textContent = `${bank.name} mobile number`;
      input.placeholder = '09171234567';
      input.inputMode = 'tel';
    } else {
      $('#bank-account-label').textContent = `${bank?.name ?? 'Bank'} account number`;
      input.placeholder = '10 to 16 digits';
      input.inputMode = 'numeric';
    }
    const fee = (bankInfo?.feeCents ?? 1500) / 100;
    const amount = bankForm.elements.amount.value.trim();
    $('#bank-fee').textContent = money(fee);
    $('#bank-total').textContent = validAmount(amount) ? money(Number(amount) + fee) : money(fee);
  }
  bankForm.elements.bankCode.addEventListener('change', updateBankForm);
  bankForm.elements.amount.addEventListener('input', updateBankForm);

  // ----- Step 2 -> Review -----

  /** "PP1000000002" -> account; "0917 123 4567" / "+639171234567" -> mobile; else null. */
  function parseRecipient(text) {
    const value = text.trim().toUpperCase();
    if (/^PP\d+$/.test(value)) return { toAccountNumber: value, label: value };
    let digits = value.replace(/[\s-]/g, '');
    if (digits.startsWith('+63')) digits = `0${digits.slice(3)}`;
    else if (/^63\d{10}$/.test(digits)) digits = `0${digits.slice(2)}`;
    if (/^09\d{9}$/.test(digits)) return { toMobileNumber: digits, label: digits };
    return null;
  }

  sendForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const { recipient, amount, description } = formData(sendForm);
    setFormError(sendForm);

    const to = parseRecipient(recipient);
    if (!to) return setFormError(sendForm, 'Enter a PayPulse account number (PP...) or a mobile number (09...).');
    if (!validAmount(amount.trim())) return setFormError(sendForm, 'Enter a valid amount, e.g. 250 or 99.50.');

    const { label, ...recipientFields } = to;
    const note = description.trim() || undefined;
    showReview({
      method: 'express',
      endpoint: '/api/transfers',
      body: { ...recipientFields, amount: amount.trim(), description: note },
      summary: label,
      rows: [
        ['Send via', 'Express Send (PayPulse)'],
        [to.toMobileNumber ? 'Mobile number' : 'Account no.', label],
        ...(note ? [['Note', note]] : []),
        ['Amount', money(amount)],
        ['Transfer fee', `${money(0)} (free)`],
      ],
      totalCents: Math.round(Number(amount) * 100),
    });
  });

  bankForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const { accountNumber, accountName, amount } = formData(bankForm);
    const bank = selectedBank();
    setFormError(bankForm);

    if (!bank) return setFormError(bankForm, 'Choose a bank or e-wallet.');
    if (!accountNumber.trim()) return setFormError(bankForm, `Enter the ${$('#bank-account-label').textContent.toLowerCase()}.`);
    if (accountName.trim().length < 2) return setFormError(bankForm, "Enter the account holder's name.");
    if (!validAmount(amount.trim())) return setFormError(bankForm, 'Enter a valid amount, e.g. 250 or 99.50.');

    const feeCents = bankInfo.feeCents;
    const amountCents = Math.round(Number(amount) * 100);
    const account = accountNumber.replace(/[\s-]/g, '');
    showReview({
      method: 'bank',
      endpoint: '/api/transfers/bank',
      body: { bankCode: bank.code, accountNumber: account, accountName: accountName.trim(), amount: amount.trim() },
      summary: `${bank.name} ••••${account.slice(-4)}`,
      rows: [
        ['Send via', 'Bank Transfer'],
        ['Bank', bank.name],
        [bank.accountType === 'MOBILE' ? 'Mobile number' : 'Account no.', account],
        ['Account name', accountName.trim()],
        ['Amount', money(amount)],
        ['Transfer fee', money(feeCents / 100)],
      ],
      totalCents: amountCents + feeCents,
    });
  });

  function showReview(transfer) {
    pending = transfer;
    $('#review-list').replaceChildren(
      ...transfer.rows.flatMap(([term, value]) => [
        Object.assign(document.createElement('dt'), { textContent: term }),
        Object.assign(document.createElement('dd'), { textContent: value }),
      ]),
    );
    $('#review-total').textContent = money(transfer.totalCents / 100);
    showSendStep('review');
  }

  // ----- Review -> MPIN -----

  $('#review-confirm').addEventListener('click', () => {
    if (!pending) return;
    sendDialog.close();
    // No MPIN yet, or it expired: get one first, then continue to the PIN pad (see #mpin-saved).
    if (!hasMpin) return openMpinReset('setup');
    if (mpinSecondsLeft() === 0) return openMpinReset('expired');
    openMpinPad();
  });

  function openMpinPad() {
    const strong = (text) => Object.assign(document.createElement('strong'), { textContent: text });
    $('#mpin-summary').replaceChildren(
      'You are sending ',
      strong(money(pending.body.amount)),
      ' to ',
      strong(pending.summary),
      ...(pending.method === 'bank' ? [` (total ${money(pending.totalCents / 100)} incl. fee)`] : []),
    );
    setFormError(mpinForm);
    mpinDialog.showModal();
    mpinInput.clear();
    updateMpinTimers();
  }

  function transferBody(extra = {}) {
    return { ...pending.body, mpin: pending.mpin, ...extra };
  }

  async function completeTransfer(result) {
    stopOtpTimer();
    mpinDialog.close();
    otpDialog.close();
    hidePopover($('#sms'));
    pending = null;
    await loadWallet();
    await openReceipt(result.transactionId);
  }

  /** Errors about the transfer itself (receiver, funds, amount) go back to its form. */
  function backToSendForm(message) {
    stopOtpTimer();
    mpinDialog.close();
    otpDialog.close();
    const method = pending?.method || 'express';
    sendDialog.showModal();
    showSendStep(method);
    setFormError(method === 'bank' ? bankForm : sendForm, message);
  }

  mpinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pending) return;
    const mpin = mpinInput.value();
    setFormError(mpinForm);
    if (!/^\d{6}$/.test(mpin)) return setFormError(mpinForm, 'Enter all 6 digits of your MPIN.');

    // The Confirm button is intentionally left enabled while this request runs (QA exercise).
    try {
      const result = await api(pending.endpoint, { method: 'POST', body: transferBody({ mpin }) });
      if (result.otpRequired) {
        pending.mpin = mpin;
        mpinDialog.close();
        startOtp(result);
        return;
      }
      await completeTransfer(result);
    } catch (err) {
      if (err.code === 'INVALID_MPIN') {
        toast('Invalid MPIN', 'error');
        mpinInput.clear();
      } else if (err.code === 'MPIN_NOT_SET') {
        hasMpin = false;
        mpinDialog.close();
        openMpinReset('setup');
      } else if (err.code === 'MPIN_EXPIRED') {
        setMpinExpiry(0);
        mpinDialog.close();
        openMpinReset('expired');
      } else if (err.code === 'MPIN_LOCKED') {
        mpinDialog.close();
        toast(err.message, 'error');
      } else if (err.status === 400 || err.status === 404 || err.status === 422) {
        backToSendForm(err.message);
      } else {
        setFormError(mpinForm, err.message);
      }
    }
  });

  function startOtp(challenge) {
    pending.challengeId = challenge.challengeId;
    setFormError(otpForm);
    otpInput.setDisabled(false);
    $('#otp-submit').disabled = false;
    $('#otp-resend').disabled = true;
    if (!otpDialog.open) otpDialog.showModal();
    otpInput.clear();
    showMockSms(challenge.demoCode);
    startOtpTimer(challenge.expiresInSeconds);
  }

  function startOtpTimer(seconds) {
    stopOtpTimer();
    const timerEl = $('#otp-timer');
    const endsAt = Date.now() + seconds * 1000;

    const tick = () => {
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      if (left > 0) {
        timerEl.textContent = `Code expires in 0:${String(left).padStart(2, '0')}`;
        timerEl.classList.remove('expired');
        return;
      }
      stopOtpTimer();
      timerEl.textContent = 'Code expired. Request a new one.';
      timerEl.classList.add('expired');
      $('#otp-submit').disabled = true;
      $('#otp-resend').disabled = false;
    };
    tick();
    otpTimer = setInterval(tick, 250);
  }

  function stopOtpTimer() {
    clearInterval(otpTimer);
    otpTimer = null;
  }

  otpDialog.addEventListener('close', () => {
    stopOtpTimer();
    hidePopover($('#sms'));
  });

  otpForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pending?.challengeId) return;
    const otp = otpInput.value();
    setFormError(otpForm);
    if (!/^\d{6}$/.test(otp)) return setFormError(otpForm, 'Enter all 6 digits of the code.');

    try {
      const result = await api(pending.endpoint, {
        method: 'POST',
        body: transferBody({ otpChallengeId: pending.challengeId, otp }),
      });
      await completeTransfer(result);
    } catch (err) {
      if (!otpDialog.open) return; // a duplicate click after the transfer already finished

      if (err.code === 'INVALID_OTP') {
        toast(err.message, 'error');
        otpInput.clear();
      } else if (err.code === 'MPIN_EXPIRED') {
        setMpinExpiry(0);
        otpDialog.close();
        openMpinReset('expired');
      } else if (err.code === 'OTP_EXPIRED' || err.code === 'OTP_ATTEMPTS_EXCEEDED') {
        stopOtpTimer();
        toast(err.message, 'error');
        setFormError(otpForm, err.message);
        $('#otp-submit').disabled = true;
        $('#otp-resend').disabled = false;
      } else if (err.status === 400 || err.status === 404 || err.status === 422) {
        backToSendForm(err.message);
      } else {
        otpDialog.close();
        toast(err.message, 'error');
      }
    }
  });

  $('#otp-resend').addEventListener('click', async () => {
    if (!pending) return;
    $('#otp-resend').disabled = true;
    try {
      const result = await api(pending.endpoint, { method: 'POST', body: transferBody() });
      if (result.otpRequired) {
        startOtp(result);
        toast('A new code has been sent');
      } else {
        await completeTransfer(result);
      }
    } catch (err) {
      $('#otp-resend').disabled = false;
      toast(err.message, 'error');
    }
  });

  // ---------- MPIN: show once, forgot MPIN ----------

  const revealDialog = $('#mpin-reveal-dialog');
  const resetDialog = $('#mpin-reset-dialog');
  const resetForm = $('#mpin-reset-form');

  /** Show a freshly generated MPIN. The user must acknowledge it before continuing. */
  function showMpinReveal(mpin, expiresInSeconds) {
    $('#mpin-reveal').textContent = mpin;
    resetMpinCopyButton();
    setMpinExpiry(expiresInSeconds);
    revealDialog.showModal();
    updateMpinTimers();
    // Also "deliver" it like a text message (mock SMS), so it is still visible after this screen.
    showMockMessage(
      '💬 Messages',
      `PayPulse: Your MPIN is ${mpin}. It works for ${Math.round(expiresInSeconds / 60)} minutes. ` +
        'Never share it with anyone.',
      60_000,
    );
  }

  let mpinCopyTimer = null;
  function resetMpinCopyButton() {
    clearTimeout(mpinCopyTimer);
    const button = $('#mpin-copy');
    button.textContent = 'Copy MPIN';
    button.classList.remove('copied');
  }

  // Copy the MPIN, then paste it into the PIN pad (the pad accepts pasted digits).
  $('#mpin-copy').addEventListener('click', async () => {
    const mpin = $('#mpin-reveal').textContent.trim();
    if (!mpin) return;
    if (await copyText(mpin)) {
      const button = $('#mpin-copy');
      button.textContent = 'Copied ✓';
      button.classList.add('copied');
      clearTimeout(mpinCopyTimer);
      mpinCopyTimer = setTimeout(resetMpinCopyButton, 2500);
      toast('MPIN copied. Paste it into the PIN pad (Ctrl+V).', 'success');
    } else {
      toast('Could not copy. Please write the MPIN down instead.', 'error');
    }
  });

  /** Live "expires in m:ss" on the reveal screen and the PIN pad. */
  function updateMpinTimers() {
    const left = mpinSecondsLeft();
    const text = left > 0 ? `Valid for ${formatCountdown(left)}` : 'Expired. Get a new MPIN.';
    for (const el of [$('#mpin-reveal-timer'), $('#mpin-pad-timer')]) {
      el.textContent = el.id === 'mpin-pad-timer' && left > 0 ? `MPIN expires in ${formatCountdown(left)}` : text;
      el.classList.toggle('expired', left === 0);
      el.classList.toggle('warn', left > 0 && left <= 60);
    }
    // Expired while the PIN pad is open: go straight to getting a new MPIN.
    if (left === 0 && mpinDialog.open) {
      mpinDialog.close();
      openMpinReset('expired');
    }
  }
  setInterval(() => {
    if (revealDialog.open || mpinDialog.open) updateMpinTimers();
  }, 250);

  revealDialog.addEventListener('cancel', (event) => event.preventDefault()); // no Esc-to-dismiss
  $('#mpin-saved').addEventListener('click', () => {
    revealDialog.close();
    $('#mpin-reveal').textContent = '';
    if (mpinDialog.open) mpinInput.clear();
    else if (pending && !otpDialog.open) openMpinPad(); // continue the transfer that needed an MPIN
  });

  const RESET_MODES = {
    forgot: {
      title: 'Get a new MPIN',
      text: "Forgot your MPIN or didn't get it? Enter your account password and we'll send you a new random MPIN.",
      button: 'Get a new MPIN',
    },
    setup: {
      title: 'Set up your MPIN',
      text: 'Your account has no MPIN yet. You need one to send money. Enter your account password to get your random 6-digit MPIN.',
      button: 'Get my MPIN',
    },
    expired: {
      title: 'Your MPIN has expired',
      text: 'For your security, an MPIN only works for 5 minutes after you receive it. Enter your account password to get a new one.',
      button: 'Get a new MPIN',
    },
  };

  /** Get a new random MPIN with the account password: "forgot", first-time "setup", or "expired". */
  function openMpinReset(mode = 'forgot') {
    const { title, text, button } = RESET_MODES[mode];
    $('#mpin-reset-title').textContent = title;
    $('#mpin-reset-text').textContent = text;
    resetForm.querySelector('[type="submit"]').textContent = button;
    resetForm.reset();
    setFormError(resetForm);
    if (!resetDialog.open) resetDialog.showModal();
  }

  $('#forgot-mpin').addEventListener('click', () => openMpinReset());

  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const { password } = formData(resetForm);
    setFormError(resetForm);
    try {
      const { mpin, mpinExpiresInSeconds } = await api('/api/accounts/me/mpin/reset', {
        method: 'POST',
        body: { password },
      });
      hasMpin = true;
      resetDialog.close();
      setFormError(mpinForm);
      showMpinReveal(mpin, mpinExpiresInSeconds);
    } catch (err) {
      setFormError(resetForm, err.message);
    }
  });

  // ---------- Forgot password: email -> code + new password ----------

  const pwDialog = $('#password-reset-dialog');
  const pwRequestForm = $('#pw-request-form');
  const pwResetForm = $('#pw-reset-form');
  const pwCodeInput = createCodeInput($('#pw-code-input'));
  let pwReset = null; // { email, resetId, deadline }
  let pwTimer = null;

  function stopPwTimer() {
    clearInterval(pwTimer);
    pwTimer = null;
  }

  function showPwStep(step) {
    pwRequestForm.hidden = step !== 'request';
    pwResetForm.hidden = step !== 'reset';
  }

  $('#forgot-password').addEventListener('click', () => {
    pwReset = null;
    stopPwTimer();
    pwRequestForm.reset();
    setFormError(pwRequestForm);
    pwRequestForm.elements.email.value = $('#login-form').elements.email.value;
    showPwStep('request');
    pwDialog.showModal();
  });

  pwDialog.addEventListener('close', () => {
    stopPwTimer();
    hidePopover($('#sms'));
  });

  async function sendResetCode(email) {
    const result = await api('/api/auth/password/forgot', { method: 'POST', body: { email } });
    pwReset = { email, resetId: result.resetId, deadline: Date.now() + result.expiresInSeconds * 1000 };

    pwResetForm.reset();
    setFormError(pwResetForm);
    $('#pw-reset-sent').textContent = `${result.message} Enter it below with your new password.`;
    showPwStep('reset');
    pwCodeInput.clear();
    $('#pw-reset-submit').disabled = false;
    showMockMessage(
      '✉️ Mail · PayPulse',
      `Your password reset code is ${result.demoCode}. It expires in ${result.expiresInSeconds / 60} minutes. ` +
        "If you didn't ask to reset your password, ignore this email.",
      20_000,
    );
    startPwTimer();
  }

  function startPwTimer() {
    stopPwTimer();
    const timerEl = $('#pw-code-timer');
    const tick = () => {
      const left = Math.max(0, Math.ceil((pwReset.deadline - Date.now()) / 1000));
      timerEl.textContent = left > 0 ? `Code expires in ${formatCountdown(left)}` : 'Code expired. Send a new code.';
      timerEl.classList.toggle('expired', left === 0);
      if (left === 0) {
        stopPwTimer();
        $('#pw-reset-submit').disabled = true;
      }
    };
    tick();
    pwTimer = setInterval(tick, 250);
  }

  pwRequestForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = pwRequestForm.elements.email.value.trim();
    setFormError(pwRequestForm);
    if (!email) return setFormError(pwRequestForm, 'Enter your email.');
    try {
      await sendResetCode(email);
    } catch (err) {
      setFormError(pwRequestForm, err.message);
    }
  });

  $('#pw-resend').addEventListener('click', async () => {
    if (!pwReset) return;
    try {
      await sendResetCode(pwReset.email);
      toast('A new code has been sent');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  pwResetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pwReset) return;
    const code = pwCodeInput.value();
    const { newPassword, confirmPassword } = formData(pwResetForm);
    setFormError(pwResetForm);

    if (!/^\d{6}$/.test(code)) return setFormError(pwResetForm, 'Enter all 6 digits of the code.');
    if (newPassword.length < 8) return setFormError(pwResetForm, 'Password must be at least 8 characters.');
    if (newPassword !== confirmPassword) return setFormError(pwResetForm, 'The passwords do not match.');

    try {
      const result = await api('/api/auth/password/reset', {
        method: 'POST',
        body: { resetId: pwReset.resetId, code, newPassword },
      });
      const { email } = pwReset;
      pwDialog.close();
      pwReset = null;
      // Back on the login form, ready for the new password.
      document.querySelector('.tab[data-tab="login"]').click();
      $('#login-form').elements.email.value = email;
      $('#login-form').elements.password.focus();
      toast(result.message, 'success');
    } catch (err) {
      if (err.code === 'INVALID_RESET_CODE') {
        toast(err.message, 'error');
        pwCodeInput.clear();
      } else if (err.code === 'RESET_CODE_EXPIRED' || err.code === 'RESET_ATTEMPTS_EXCEEDED') {
        stopPwTimer();
        $('#pw-reset-submit').disabled = true;
        setFormError(pwResetForm, err.message);
      } else {
        setFormError(pwResetForm, err.message);
      }
    }
  });

  // ---------- Transaction receipt ----------

  const receiptDialog = $('#receipt-dialog');
  let currentReceipt = null;

  const RECEIPT_TIME = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'long',
    timeStyle: 'medium',
  });

  /** [label, value, isTotal?] rows shared by the modal and the downloaded image. */
  function receiptRows(r) {
    const hasFee = Number(r.fee) > 0;
    if (r.type === 'DEPOSIT') {
      return [
        ['Amount', money(r.amount)],
        ['Fee', `${money(0)} (free)`],
        ['Paid with', 'Card payment (test mode)'],
        ['Payment ID', r.sender.account],
        ['Recipient Name', r.recipient.name],
        ['Recipient Account', r.recipient.account],
        ['Bank Name', r.bankName],
      ];
    }
    return [
      ['Amount', money(r.amount)],
      ['Fee', hasFee ? money(r.fee) : `${money(0)} (free)`],
      ...(hasFee ? [['Total deducted', money(r.total), true]] : []),
      ['Sender Name', r.sender.name],
      ['Sender Account', r.sender.account],
      ['Recipient Name', r.recipient.name],
      ['Recipient Account', r.recipient.account],
      ['Bank Name', r.bankName],
      ...(r.note ? [['Note', r.note]] : []),
      ...(r.bankReference ? [['Bank Reference', r.bankReference]] : []),
    ];
  }

  /** Big number at the top: what left your wallet (incl. fee), or what arrived. */
  const receiptHeadline = (r) => `${r.direction === 'SENT' ? '−' : '+'}${money(r.direction === 'SENT' ? r.total : r.amount)}`;

  async function openReceipt(transactionId) {
    try {
      const r = await api(`/api/accounts/me/transactions/${transactionId}/receipt`);
      currentReceipt = r;
      $('#receipt-title').textContent = r.title;
      $('#receipt-amount').textContent = receiptHeadline(r);
      $('#receipt-date').textContent = RECEIPT_TIME.format(new Date(r.createdAt));
      $('#receipt-ref').textContent = r.reference;
      $('#receipt-rows').replaceChildren(
        ...receiptRows(r).flatMap(([label, value, isTotal]) => [
          Object.assign(document.createElement('dt'), { textContent: label }),
          Object.assign(document.createElement('dd'), { textContent: value, className: isTotal ? 'total' : '' }),
        ]),
      );
      if (!receiptDialog.open) receiptDialog.showModal();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  $('#receipt-done').addEventListener('click', () => receiptDialog.close());

  $('#receipt-download').addEventListener('click', async () => {
    if (!currentReceipt) return;
    try {
      const blob = await drawReceiptImage(currentReceipt);
      const link = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: `PayPulse-receipt-${currentReceipt.reference}.png`,
      });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      toast('Receipt saved to your downloads', 'success');
    } catch {
      toast('Could not create the receipt image.', 'error');
    }
  });

  /** Draw the receipt on a canvas (2x for sharp text) and return it as a PNG blob. */
  function drawReceiptImage(r) {
    const W = 380;
    const PAD = 24;
    const ROW = 30;
    const rows = [['Reference No.', r.reference], ...receiptRows(r)];
    const headH = 190;
    const H = headH + 20 + rows.length * ROW + 70;
    const scale = 2;

    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    const font = (size, weight = 400) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

    // Card background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Purple header
    const gradient = ctx.createLinearGradient(0, 0, W, headH);
    gradient.addColorStop(0, '#5b4cf0');
    gradient.addColorStop(0.55, '#7a4cf0');
    gradient.addColorStop(1, '#3fa9c9');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, headH);

    // Check icon
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(W / 2, 46, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#12996e';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(W / 2 - 10, 47);
    ctx.lineTo(W / 2 - 3, 54);
    ctx.lineTo(W / 2 + 11, 39);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = font(18, 700);
    ctx.fillText(r.title, W / 2, 98);
    ctx.font = font(30, 700);
    ctx.fillText(receiptHeadline(r), W / 2, 138);
    ctx.font = font(13);
    ctx.fillText(RECEIPT_TIME.format(new Date(r.createdAt)), W / 2, 164);

    // Rows: label left, value right (shortened with … if too long)
    const fit = (text, maxWidth) => {
      let value = String(text);
      if (ctx.measureText(value).width <= maxWidth) return value;
      while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) value = value.slice(0, -1);
      return `${value}…`;
    };
    let y = headH + 34;
    for (const [label, value, isTotal] of rows) {
      ctx.textAlign = 'left';
      ctx.font = font(13);
      ctx.fillStyle = '#6b7086';
      ctx.fillText(label, PAD, y);
      ctx.textAlign = 'right';
      ctx.font = font(isTotal ? 15 : 13, 600);
      ctx.fillStyle = isTotal || label === 'Reference No.' ? '#4335d8' : '#1b1d2a';
      ctx.fillText(fit(value, W - PAD * 2 - 130), W - PAD, y);
      y += ROW;
    }

    // Footer
    ctx.strokeStyle = '#e3e5ef';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y - 10);
    ctx.lineTo(W - PAD, y - 10);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'center';
    ctx.font = font(12, 700);
    ctx.fillStyle = '#5b4cf0';
    ctx.fillText('PayPulse', W / 2, y + 16);
    ctx.font = font(11);
    ctx.fillStyle = '#6b7086';
    ctx.fillText('Demo receipt. Amounts are play money.', W / 2, y + 34);

    return new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png'),
    );
  }

  // ---------- Start ----------

  if (getToken()) {
    showWallet().catch(() => logout());
  } else {
    showAuth();
  }
})();
