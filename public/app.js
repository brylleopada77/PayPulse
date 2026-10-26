// PayPulse web wallet: plain JavaScript talking to the PayPulse REST API.
(() => {
  const TOKEN_KEY = 'paypulse.token';
  const REFRESH_MS = 10_000;

  const $ = (selector) => document.querySelector(selector);
  const authView = $('#auth-view');
  const appView = $('#app-view');
  let currency = 'PHP';
  let hasMpin = true; // false for accounts created before random MPINs
  let lastAccount = null; // latest GET /api/accounts/me (used by the profile screen)
  let qaEnabled = false; // true when the server runs with QA_SANDBOX=true (GET /api/qa/state works)
  let mpinDeadline = 0; // Date.now() value when the current MPIN expires
  let refreshTimer = null;

  // ---------- API helper ----------

  const CHAOS_KEY = 'paypulse.chaos';
  const CHAOS_FAULT_KEY = 'paypulse.chaos.fault'; // Chaos Engine fault injection: 'on' | 'off'
  const CHAOS_FAULT_RATE = '0.2';
  const MAX_RETRIES = 3;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A unique Idempotency-Key for one user action (reused by that action's automatic retries). */
  function newIdempotencyKey() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const faultInjectionOn = () => {
    try { return localStorage.getItem(CHAOS_FAULT_KEY) === 'on'; } catch { return false; }
  };

  /**
   * QA Sandbox chaos: extra x-chaos-* headers for API calls (dev servers only). Chaos Engine fault
   * injection asks for a random HTTP 500 on 20% of POSTs (the server applies it only to transfers
   * and payments); otherwise the "Chaos mode" picker applies to every call.
   */
  function chaosHeaders(method) {
    if (method === 'POST' && faultInjectionOn()) {
      return { 'x-chaos-mode': 'true', 'x-chaos-fault': 'error-500', 'x-chaos-rate': CHAOS_FAULT_RATE };
    }
    let mode = 'off';
    try { mode = localStorage.getItem(CHAOS_KEY) || 'off'; } catch { /* storage unavailable */ }
    switch (mode) {
      case 'db-lock': return { 'x-chaos-mode': 'true', 'x-chaos-fault': 'db-lock' };
      case 'drop': return { 'x-chaos-mode': 'true', 'x-chaos-fault': 'drop', 'x-chaos-rate': '0.5' };
      case 'drop-after':
        return { 'x-chaos-mode': 'true', 'x-chaos-fault': 'drop', 'x-chaos-rate': '0.5', 'x-chaos-drop-when': 'after' };
      default: return {};
    }
  }

  /** One HTTP call. Throws an Error with .status/.code/.details (status 0 + .network on no connection). */
  async function apiOnce(path, { method, body, idempotencyKey }) {
    const headers = { 'Content-Type': 'application/json', ...chaosHeaders(method) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    networkStarted();
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      const err = new Error('Network error');
      err.status = 0;
      err.network = true;
      throw err;
    } finally {
      networkFinished();
    }
    const data = await res.json().catch(() => ({}));

    if (res.status === 401 && token) {
      logout(data.error?.message || 'Your session has expired. Please log in again.');
    }
    if (!res.ok) {
      const err = new Error(data.error?.message || `Request failed (${res.status})`);
      err.code = data.error?.code;
      err.details = data.error?.details;
      err.status = res.status;
      throw err;
    }
    return { ...data, httpStatus: res.status, replayed: res.headers.get('Idempotent-Replayed') === 'true' };
  }

  // Chaos Engine 500s are injected BEFORE the request runs (no money moved), so they are safe to retry.
  const isChaosFault = (err) => err.code === 'CHAOS_FAULT_INJECTED';
  const isTransient = (err) =>
    err.network || err.status === 502 || err.status === 503 || err.status === 504 || isChaosFault(err);

  /**
   * API call with automatic retries for temporary failures (503 / no connection): up to 3 retries
   * with back-off and a "Retrying..." toast. GETs are always retried; POSTs only when they carry an
   * Idempotency-Key, so a retry can never repeat a transfer (the server replays the first answer).
   */
  async function api(path, { method = 'GET', body, idempotencyKey } = {}) {
    const canRetry = method === 'GET' || Boolean(idempotencyKey);
    let lastFaultWasChaos = false;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await apiOnce(path, { method, body, idempotencyKey });
        if (attempt > 1 && method !== 'GET') {
          toast(lastFaultWasChaos ? '✅ Chaos Engine: recovered. Transaction completed once.' : 'Connection restored. Done.', 'success');
        }
        return result;
      } catch (err) {
        lastFaultWasChaos = isChaosFault(err);
        if (!isTransient(err) || !canRetry || attempt > MAX_RETRIES) {
          if (isChaosFault(err)) {
            err.message = 'Chaos Engine: the server kept failing, so nothing was sent. No money moved. Please try again.';
          } else if (isTransient(err)) {
            err.code = err.code || 'SERVICE_UNAVAILABLE';
            err.unconfirmed = method !== 'GET'; // a POST may or may not have gone through
          }
          throw err;
        }
        if (isChaosFault(err)) {
          toast(`⚠️ Chaos Engine: Server Fault Injected. Retrying transaction… (${attempt}/${MAX_RETRIES})`, 'chaos');
        } else {
          toast(`Connection problem. Retrying (${attempt}/${MAX_RETRIES})…`, 'warn');
        }
        await sleep(600 * 2 ** (attempt - 1));
      }
    }
  }

  // "⏳ Waiting for server…" when a request takes longer than 400 ms (e.g. QA slow network).
  let pendingRequests = 0;
  let networkTimer = null;
  function networkStarted() {
    pendingRequests += 1;
    if (pendingRequests === 1) {
      networkTimer = setTimeout(() => showPopover(document.getElementById('net-indicator')), 400);
    }
  }
  function networkFinished() {
    pendingRequests = Math.max(0, pendingRequests - 1);
    if (pendingRequests === 0) {
      clearTimeout(networkTimer);
      hidePopover(document.getElementById('net-indicator'));
    }
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
    if (tx.type === 'LOAN_DISBURSEMENT') return { title: 'Loan Disbursement', icon: '💰' };
    if (tx.type === 'BILL_PAYMENT') return { title: tx.description, icon: '🧾' };
    if (tx.type === 'CASHBACK') return { title: tx.description || 'Cashback Reward', icon: '🎁' };
    if (tx.type === 'LOAD_PURCHASE') return { title: tx.description, icon: '📱' };
    if (tx.type === 'CARD_PAYMENT') return { title: tx.description, icon: '💳' };
    if (tx.type === 'INTEREST') return { title: 'Savings interest earned', icon: '🌱' };
    if (tx.type === 'LOAN_REPAYMENT') return { title: 'Loan Repayment', icon: '↩' };
    if (tx.type === 'SAVINGS_TRANSFER') {
      return { title: tx.direction === 'DEBIT' ? 'Moved to PayPulse Save' : 'From PayPulse Save', icon: '🐷' };
    }
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
      // Select the digit on focus, so typing into a filled box replaces it instead of appending.
      box.addEventListener('focus', () => box.select());
      box.addEventListener('input', (event) => {
        // A single typed digit replaces the box; longer input (paste/autofill) fills the next boxes.
        const text = event.inputType === 'insertText' && event.data ? event.data : box.value;
        box.value = '';
        fillFrom(i, text);
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

  /** A theme token from styles.css (e.g. "--accent"), so canvas drawings follow the palette. */
  function cssToken(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  // ---------- Appearance: System / Light / Dark (iOS dark glass) ----------

  const THEME_KEY = 'paypulse.theme';
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const themeColor = document.querySelector('meta[name="theme-color"]');

  function themePref() {
    // Default: Light (Royal Blue). Users can pick Dark or Auto (follow the device).
    try { return localStorage.getItem(THEME_KEY) || 'light'; } catch { return 'light'; }
  }

  /** Apply a preference: "system" follows the device, "light" / "dark" are fixed. */
  function applyTheme(pref) {
    const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themePref = pref;
    themeColor?.setAttribute('content', dark ? '#0a0f1a' : '#f4f7ff');
    document.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === pref; });
    const sub = document.getElementById('appearance-sub');
    if (sub) sub.textContent = pref === 'system' ? 'Follows your device (' + (dark ? 'dark' : 'light') + ' now)' : dark ? 'Dark glass' : 'Light';
  }

  document.querySelectorAll('input[name="theme"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      try { localStorage.setItem(THEME_KEY, radio.value); } catch { /* not remembered */ }
      applyTheme(radio.value);
    });
  });
  // When following the device, switch live if the device changes (e.g. sunset on iOS / Android).
  darkQuery.addEventListener('change', () => { if (themePref() === 'system') applyTheme('system'); });
  applyTheme(themePref());

  // ---------- Hide / show balance ----------

  const HIDE_BALANCE_KEY = 'paypulse.hideBalance';
  let currentBalance = null;
  let savings = null; // GET /api/v1/savings
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

    // The eye hides every amount on the balance card, like a banking app.
    const savingsBalance = savings?.balance ?? '0.00';
    const total = (Number(currentBalance ?? 0) + Number(savingsBalance)).toFixed(2);
    $('#savings-balance').textContent = balanceHidden ? '₱ ••••' : money(savingsBalance);
    $('#total-assets').textContent = balanceHidden ? '₱ ••••' : money(total);

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
    hideQaControls();
  }

  async function showWallet() {
    authView.hidden = true;
    appView.hidden = false;
    await loadWallet();
    loadLoans().catch(() => {});
    startNotificationPolling();
    connectRealtime();
    startAutoRefresh();
    initQaControls(); // shows the QA panel only when the server runs in QA sandbox mode
    loadFeatures(); // shows "Add money" only when the mock payment provider is on
    if (!hasMpin) openMpinReset('setup');
  }

  async function loadWallet() {
    const [account, history] = await Promise.all([
      api('/api/accounts/me'),
      api(`/api/accounts/me/transactions?limit=${HOME_TX_LIMIT}`),
    ]);
    currency = account.currency;
    hasMpin = account.hasMpin;
    setMpinExpiry(account.mpinExpiresInSeconds);
    lastAccount = account;
    $('#user-name').textContent = account.accountHolder;
    $('#avatar').textContent = initials(account.accountHolder);
    $('#profile-btn').setAttribute('aria-label', `${initials(account.accountHolder)}: open my profile`); // name includes the visible initials
    $('#role-chip').hidden = account.role !== 'ADMIN';
    currentBalance = account.balance;
    renderBalance();
    $('#account-number').textContent = account.accountNumber;
    $('#frozen-badge').hidden = !account.frozen;
    $('#aml-badge').hidden = account.amlStatus !== 'UNDER_REVIEW';
    renderTransactions(history.transactions);
    $('#tx-see-all').hidden = !history.hasMore;
    loadSavingsAndCards().catch(() => {});
    if (qaEnabled) refreshQaState().catch(() => {});
  }

  const HOME_TX_LIMIT = 5; // Home shows the latest few; "See all transactions" opens the full history

  /** One history row (Home and the full history use the same row). Opens the receipt on click. */
  function buildTxItem(tx) {
    const { title, icon } = describe(tx);
    const incoming = tx.direction === 'CREDIT';

    // A list item holding a real button that opens the receipt (click, Enter or Space); its
    // accessible name is its visible text, plus "View receipt" for screen readers.
    const li = document.createElement('li');
    li.className = 'tx-row';
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tx ' + (incoming ? 'in' : 'out') + (tx.account === 'SAVINGS' ? ' savings' : '');
    row.dataset.testid = 'tx-item';
    row.addEventListener('click', () => openReceipt(tx.transactionId));

    const iconEl = document.createElement('span');
    iconEl.className = 'tx-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = icon;

    const info = document.createElement('span');
    info.className = 'tx-info';
    const titleEl = document.createElement('span');
    titleEl.className = 'tx-title';
    titleEl.textContent = title;
    const meta = document.createElement('span');
    meta.className = 'tx-date';
    const bt = tx.bankTransfer;
    const pending = bt?.status === 'QUEUED' ? ' · PESONet: pending cut-off' : '';
    // Top-ups carry a long payment id in their description: the receipt shows it, the list doesn't.
    const note =
      tx.type === 'DEPOSIT' ? 'Card top-up'
        : tx.type === 'INTEREST' ? (tx.description || '').replace('Savings interest for', 'For') + ' · added to PayPulse Save'
          : tx.description;
    meta.textContent = bt
      ? bt.accountName + ' ' + bt.accountNumber + ' · ' + money(bt.amount) + ' + ' + money(bt.fee) + ' fee' + pending + ' · ' + formatDate(tx.createdAt)
      : note && note !== title
        ? note + ' · ' + formatDate(tx.createdAt)
        : formatDate(tx.createdAt);
    info.append(titleEl, meta);

    const amountEl = document.createElement('span');
    amountEl.className = 'tx-amount';
    amountEl.textContent = (incoming ? '+' : '−') + money(tx.amount);

    const hint = Object.assign(document.createElement('span'), { className: 'visually-hidden', textContent: '. View receipt' });
    row.append(iconEl, info, amountEl, hint);
    li.append(row);
    return li;
  }

  function renderTransactions(transactions) {
    $('#tx-list').replaceChildren(...transactions.map(buildTxItem));
    $('#tx-empty').hidden = transactions.length > 0;
  }

  // ---------- Full transaction history: filters, grouped by day, "Load more" ----------

  const historyDialog = $('#history-dialog');
  const HISTORY_PAGE = 30;
  const DAY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
  const DAY_LABEL = new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' });
  let historyDirection = '';
  let historyCursor = null;
  let historyLastDay = null;
  let historyLoading = false;

  function dayLabel(iso) {
    const key = DAY_KEY.format(new Date(iso));
    const today = DAY_KEY.format(new Date());
    const yesterday = DAY_KEY.format(new Date(Date.now() - 86_400_000));
    if (key === today) return 'Today';
    if (key === yesterday) return 'Yesterday';
    return DAY_LABEL.format(new Date(iso));
  }

  async function loadHistoryPage({ reset = false } = {}) {
    if (historyLoading) return;
    historyLoading = true;
    if (reset) {
      historyCursor = null;
      historyLastDay = null;
      $('#history-list').replaceChildren();
      $('#history-empty').hidden = true;
    }
    $('#history-more').hidden = true;
    $('#history-status').textContent = 'Loading…';
    try {
      const params = new URLSearchParams({ limit: String(HISTORY_PAGE) });
      if (historyCursor) params.set('before', String(historyCursor));
      if (historyDirection) params.set('direction', historyDirection);
      const page = await api('/api/accounts/me/transactions?' + params);
      const rows = [];
      for (const tx of page.transactions) {
        const day = DAY_KEY.format(new Date(tx.createdAt));
        if (day !== historyLastDay) {
          historyLastDay = day;
          rows.push(Object.assign(document.createElement('li'), { className: 'day-head', textContent: dayLabel(tx.createdAt) }));
        }
        rows.push(buildTxItem(tx));
      }
      $('#history-list').append(...rows);
      historyCursor = page.nextBefore;
      $('#history-more').hidden = !page.hasMore;
      $('#history-empty').hidden = $('#history-list').children.length > 0;
      const shown = $('#history-list').querySelectorAll('[data-testid="tx-item"]').length;
      $('#history-status').textContent = page.hasMore ? 'Showing ' + shown + ' transactions' : shown ? 'All ' + shown + ' transactions shown' : '';
    } catch (err) {
      $('#history-status').textContent = describeError(err);
      $('#history-more').hidden = false; // let the user try again
    } finally {
      historyLoading = false;
    }
  }

  function openHistory() {
    historyDirection = '';
    historyDialog.querySelectorAll('[data-direction]').forEach((chip) => chip.setAttribute('aria-selected', String(chip.dataset.direction === '')));
    historyDialog.showModal();
    loadHistoryPage({ reset: true });
  }

  $('#tx-see-all').addEventListener('click', openHistory);
  $('#tx-open-all').addEventListener('click', openHistory);
  $('#history-more').addEventListener('click', () => loadHistoryPage());
  historyDialog.querySelectorAll('[data-direction]').forEach((chip) => {
    chip.addEventListener('click', () => {
      historyDirection = chip.dataset.direction;
      historyDialog.querySelectorAll('[data-direction]').forEach((c) => c.setAttribute('aria-selected', String(c === chip)));
      loadHistoryPage({ reset: true });
    });
  });

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
    hideCardDetails(); // never leave a revealed card number on screen for the next person
    renderCard(null);
    $('#topup-btn').hidden = true;
    $('#role-chip').hidden = true;
    $('#bell-dot').hidden = true;
    clearInterval(notifTimer);
    disconnectRealtime();
    savings = null;
    showTab('home');
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

  // Log out asks first; Cancel (or Esc) keeps you logged in.
  $('#logout-btn').addEventListener('click', () => $('#logout-dialog').showModal());
  $('#logout-confirm').addEventListener('click', () => {
    $('#logout-dialog').close();
    logout();
    toast('You have been logged out');
  });

  // ---------- Wallet actions ----------

  document.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.open === 'send-dialog') return openSendDialog();
      const dialog = document.getElementById(btn.dataset.open);
      const form = dialog.querySelector('form');
      form.reset();
      setFormError(form);
      dialog.showModal();
      if (btn.dataset.open === 'topup-dialog') loadTopupLimits();
    });
  });

  /** "You can add up to ₱X today · ₱Y more can be held": from GET /api/payments/limits. */
  async function loadTopupLimits() {
    const el = $('#topup-limits');
    el.textContent = '';
    try {
      const l = await api('/api/payments/limits');
      const canAdd = Math.min(Number(l.remainingToday), Number(l.roomLeft));
      el.replaceChildren(
        Object.assign(document.createElement('span'), { textContent: `You can add up to ${money(canAdd)} now` }),
        Object.assign(document.createElement('span'), {
          textContent: `Limits: ${money(l.dailyLimit)} a day, ${money(l.walletLimit)} held`,
        }),
      );
    } catch {
      /* the server still enforces the limits */
    }
  }

  /** "Add money" is for ADMIN accounts only, and only when the mock payment provider is enabled. */
  async function loadFeatures() {
    try {
      const { features } = await api('/api/config');
      $('#topup-btn').hidden = !(features.mockPayments && lastAccount?.role === 'ADMIN');
    } catch {
      $('#topup-btn').hidden = true;
    }
  }

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

  // ---------- Bottom navigation (Home / Card tabs; the other items open dialogs) ----------

  function showTab(name) {
    $('#home-view').hidden = name !== 'home';
    $('#card-tab').hidden = name !== 'card';
    document.querySelectorAll('[data-tab-target]').forEach((item) => {
      const active = item.dataset.tabTarget === name;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    window.scrollTo({ top: 0 });
  }

  document.querySelectorAll('[data-tab-target]').forEach((item) => {
    item.addEventListener('click', () => showTab(item.dataset.tabTarget));
  });
  $('#nav-transfer').addEventListener('click', () => openSendDialog());
  $('#nav-me').addEventListener('click', () => $('#profile-btn').click());

  $('#bank-transfer-btn').addEventListener('click', () => {
    openSendDialog();
    sendDialog.querySelector('[data-method="bank"]').click();
  });

  $('#refer-btn').addEventListener('click', async () => {
    const text =
      `Join me on PayPulse! Sign up at ${location.origin} and send money to my account ` +
      `${lastAccount?.accountNumber ?? ''} in seconds.`;
    if (await copyText(text)) toast('Invite message copied. Paste it to a friend!', 'success');
    else toast('Could not copy the invite message.', 'error');
  });

  // ---------- Real-time: Socket.IO events for this user's wallet ----------

  const liveToasts = $('#live-toasts');
  const LIVE_TOAST_MS = 6000;
  const LIVE_TOAST_MAX = 3;
  const LIVE_ICONS = { 'money-in': '↙', 'money-out': '↗', cashback: '🎉' };
  let socket = null;
  let liveRefreshTimer = null;

  function connectRealtime() {
    if (typeof window.io !== 'function') return; // the client script couldn't load: polling still works
    disconnectRealtime();
    socket = window.io({ auth: { token: getToken() } });
    socket.on('transaction', onLiveTransaction);
  }

  function disconnectRealtime() {
    socket?.disconnect();
    socket = null;
    liveToasts.replaceChildren();
    hidePopover(liveToasts);
  }

  function onLiveTransaction(event) {
    renderBellCount(event.unreadCount);
    const bell = $('#bell-btn');
    bell.classList.remove('ring');
    void bell.offsetWidth; // restart the animation
    bell.classList.add('ring');
    if (notifications && notifDialog.open) loadNotifications().catch(() => {});

    // Toasts and a balance refresh for money coming in. Money going out was started by the user,
    // who already sees a receipt, so it only updates the bell (and never adds extra API calls).
    if (event.direction !== 'CREDIT') return;
    showLiveToast(event);
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = setTimeout(() => loadWallet().catch(() => {}), 400);
  }

  function showLiveToast(event) {
    const item = Object.assign(document.createElement('div'), { className: 'live-toast ' + event.kind });
    item.dataset.testid = 'live-toast';
    item.setAttribute('role', 'status');
    const open = Object.assign(document.createElement('button'), { type: 'button', className: 'live-toast-main' });
    open.append(
      Object.assign(document.createElement('span'), { className: 'live-toast-icon', textContent: LIVE_ICONS[event.kind] ?? '•' }),
      Object.assign(document.createElement('span'), { className: 'live-toast-text' }),
    );
    open.lastChild.append(
      Object.assign(document.createElement('strong'), { textContent: event.title }),
      Object.assign(document.createElement('span'), { textContent: event.message }),
    );
    open.addEventListener('click', () => {
      item.remove();
      openReceipt(event.transactionId);
    });
    const close = Object.assign(document.createElement('button'), { type: 'button', className: 'live-toast-close', textContent: '×' });
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => removeToast(item));
    item.append(open, close);

    liveToasts.prepend(item);
    while (liveToasts.children.length > LIVE_TOAST_MAX) liveToasts.lastChild.remove();
    showPopover(liveToasts);
    setTimeout(() => removeToast(item), LIVE_TOAST_MS);
  }

  function removeToast(item) {
    item.classList.add('leaving');
    setTimeout(() => {
      item.remove();
      if (!liveToasts.children.length) hidePopover(liveToasts);
    }, 200);
  }

  // ---------- Notifications: updates, features, upcoming events and your activity ----------

  const notifDialog = $('#notif-dialog');
  const NOTIF_POLL_MS = 60_000; // its own slow timer: the 10-second balance refresh stays lean
  const NOTIF_FILTERS = [
    ['ALL', 'All'],
    ['UPDATE', 'Updates'],
    ['FEATURE', 'Features'],
    ['EVENT', 'Events'],
    ['ACTIVITY', 'Activity'],
  ];
  const NOTIF_ICONS = {
    UPDATE: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3"/>',
    FEATURE: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    EVENT: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    ACTIVITY: '<path d="M12 2v20M17 6.5c-.8-1.5-2.6-2.5-5-2.5-3 0-5 1.5-5 3.7 0 4.8 10 2.6 10 7.6 0 2.2-2.2 3.7-5 3.7-2.6 0-4.5-1-5.3-2.6"/>',
  };
  const NOTIF_LABELS = { UPDATE: 'New update', FEATURE: 'Feature', EVENT: 'Upcoming event', ACTIVITY: 'Activity' };
  const EVENT_DAY = new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
  const EVENT_TIME = new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
  let notifications = null; // GET /api/v1/notifications
  let notifFilter = 'ALL';
  const notifExpanded = new Set(); // ids opened in this panel (kept across re-renders)
  let notifTimer = null;

  function timeAgo(iso) {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return minutes + ' min ago';
    if (minutes < 24 * 60) return Math.round(minutes / 60) + ' h ago';
    if (minutes < 7 * 24 * 60) return Math.round(minutes / (24 * 60)) + ' d ago';
    return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function eventWhen(n) {
    const startAt = new Date(n.eventDate);
    let text = EVENT_DAY.format(startAt) + ' · ' + EVENT_TIME.format(startAt);
    if (n.eventEnd) text += ' – ' + EVENT_TIME.format(new Date(n.eventEnd));
    return text + ' (PH time)';
  }

  function renderBellCount(count) {
    const badge = $('#bell-dot');
    badge.hidden = !count;
    badge.textContent = count > 9 ? '9+' : String(count || '');
    // the name includes the badge text exactly as shown ("9+"), so voice control users can say it
    $('#bell-btn').setAttribute('aria-label', count ? 'Notifications, ' + badge.textContent + ' unread' : 'Notifications');
  }

  async function loadNotifications() {
    notifications = await api('/api/v1/notifications');
    renderBellCount(notifications.unreadCount);
    if (notifDialog.open) renderNotifications();
  }

  function startNotificationPolling() {
    clearInterval(notifTimer);
    loadNotifications().catch(() => {});
    notifTimer = setInterval(() => {
      if (document.visibilityState === 'visible') loadNotifications().catch(() => {});
    }, NOTIF_POLL_MS);
  }

  function renderNotifications() {
    const items = notifications?.items ?? [];
    const unread = notifications?.unreadByCategory ?? {};
    $('#notif-read-all').disabled = !notifications?.unreadCount;
    $('#notif-filters').replaceChildren(
      ...NOTIF_FILTERS.map(([code, label]) => {
        const count = code === 'ALL' ? notifications?.unreadCount ?? 0 : unread[code] ?? 0;
        const chip = Object.assign(document.createElement('button'), { type: 'button', className: 'notif-chip' });
        chip.setAttribute('role', 'tab');
        chip.setAttribute('aria-selected', String(code === notifFilter));
        chip.dataset.testid = 'notif-filter-' + code;
        chip.textContent = label;
        if (count) chip.append(Object.assign(document.createElement('span'), { className: 'chip-count', textContent: String(count) }));
        chip.addEventListener('click', () => {
          notifFilter = code;
          renderNotifications();
        });
        return chip;
      }),
    );

    const shown = items.filter((n) => notifFilter === 'ALL' || n.category === notifFilter);
    $('#notif-empty').hidden = shown.length > 0;
    $('#notif-empty').textContent = notifFilter === 'EVENT' ? 'No upcoming events right now.' : "You're all caught up.";
    $('#notif-list').replaceChildren(
      ...shown.map((n) => {
        const li = document.createElement('li');
        li.className = 'notif cat-' + n.category.toLowerCase() + (n.read ? '' : ' unread') + (notifExpanded.has(n.id) ? ' expanded' : '');
        li.dataset.testid = 'notif-item';
        li.dataset.id = n.id;

        const head = Object.assign(document.createElement('button'), { type: 'button', className: 'notif-head' });
        head.setAttribute('aria-expanded', String(notifExpanded.has(n.id)));
        const iconEl = Object.assign(document.createElement('span'), { className: 'notif-icon' });
        iconEl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + NOTIF_ICONS[n.category] + '</svg>';
        const text = Object.assign(document.createElement('span'), { className: 'notif-text' });
        text.append(
          Object.assign(document.createElement('small'), {
            className: 'notif-meta',
            textContent: NOTIF_LABELS[n.category] + ' · ' + timeAgo(n.date),
          }),
          Object.assign(document.createElement('strong'), { textContent: n.title }),
        );
        if (n.eventDate) text.append(Object.assign(document.createElement('span'), { className: 'event-when', textContent: '📅 ' + eventWhen(n) }));
        text.append(Object.assign(document.createElement('span'), { className: 'notif-body', textContent: n.body }));
        head.append(iconEl, text);
        if (!n.read) head.append(Object.assign(document.createElement('span'), { className: 'unread-dot', title: 'Unread' }));
        head.addEventListener('click', () => {
          const open = li.classList.toggle('expanded');
          if (open) notifExpanded.add(n.id);
          else notifExpanded.delete(n.id);
          head.setAttribute('aria-expanded', String(open));
          if (!n.read) markNotificationsRead([n.id]);
        });
        li.append(head);

        if (n.action) {
          const action = Object.assign(document.createElement('button'), {
            type: 'button',
            className: 'btn secondary notif-action',
            textContent: n.action.label + ' ›',
          });
          action.dataset.testid = 'notif-action';
          action.addEventListener('click', () => {
            if (!n.read) markNotificationsRead([n.id]);
            runNotificationAction(n.action);
          });
          li.append(action);
        }
        return li;
      }),
    );
  }

  async function markNotificationsRead(ids) {
    // Optimistic: the dot disappears right away, the server keeps it for every device.
    const unreadBefore = notifications.items.filter((n) => ids.includes(n.id) && !n.read).length;
    notifications.items.forEach((n) => { if (ids.includes(n.id)) n.read = true; });
    try {
      const counts = await api('/api/v1/notifications/read', { method: 'POST', body: { ids } });
      Object.assign(notifications, counts);
    } catch {
      notifications.unreadCount = Math.max(0, notifications.unreadCount - unreadBefore);
    }
    renderBellCount(notifications.unreadCount);
    renderNotifications();
  }

  async function runNotificationAction(action) {
    notifDialog.close();
    if (action.target === 'receipt') return openReceipt(action.transactionId);
    if (action.target === 'bills') return openBills();
    if (action.target === 'loan') return openLoan();
    if (action.target === 'savings') return openSavings('DEPOSIT');
    if (action.target === 'card') return showTab('card');
    await openProfile();
    if (action.target === 'kyc') {
      if (profile?.kyc.verified) toast("You're already Level 2 (Fully Verified)");
      else $('#kyc-start').click();
    } else if (action.target === 'security' || action.target === 'help') {
      showProfilePanel(action.target);
    }
  }

  $('#bell-btn').addEventListener('click', async () => {
    notifFilter = 'ALL';
    notifExpanded.clear();
    try {
      await loadNotifications();
    } catch (err) {
      return toast(err.message, 'error');
    }
    renderNotifications();
    notifDialog.showModal();
  });

  $('#notif-read-all').addEventListener('click', async () => {
    try {
      const counts = await api('/api/v1/notifications/read', { method: 'POST', body: { all: true } });
      notifications.items.forEach((n) => { n.read = true; });
      Object.assign(notifications, counts);
      renderBellCount(0);
      renderNotifications();
    } catch (err) {
      toast(err.message, 'error');
    }
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
        idempotencyKey: newIdempotencyKey(),
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
      // e.g. TOPUP_DAILY_LIMIT_EXCEEDED, WALLET_LIMIT_EXCEEDED or a compliance hold
      setFormError(form, describeError(err));
      loadTopupLimits();
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

  const CUTOFF_TIME = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });

  /** Bank list, fee and the next PESONet cut-off (fetched each time Bank Transfer opens). */
  async function loadBanks() {
    const firstLoad = !bankInfo;
    try {
      bankInfo = await api('/api/transfers/banks');
    } catch {
      bankInfo ??= { feeCents: 1500, banks: [], pesonetNextCutoffAt: null };
    }
    if (firstLoad) {
      bankForm.elements.bankCode.replaceChildren(
        ...bankInfo.banks.map((b) => Object.assign(document.createElement('option'), { value: b.code, textContent: b.name })),
      );
    }
    if (bankInfo.pesonetNextCutoffAt) {
      bankForm.elements.rail.querySelector('option[value="PESONET"]').textContent =
        `PESONet: batch, next cut-off ${CUTOFF_TIME.format(new Date(bankInfo.pesonetNextCutoffAt))}`;
    }
  }

  const RAIL_NAMES = { INSTAPAY: 'InstaPay (instant)', PESONET: 'PESONet (batch)' };

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
    const { accountNumber, accountName, amount, rail } = formData(bankForm);
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
      body: { bankCode: bank.code, accountNumber: account, accountName: accountName.trim(), amount: amount.trim(), rail },
      summary: `${bank.name} ••••${account.slice(-4)}`,
      rows: [
        ['Send via', 'Bank Transfer'],
        ['Transfer speed', RAIL_NAMES[rail]],
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
      const result = await api(pending.endpoint, {
        method: 'POST',
        body: transferBody({ mpin }),
        idempotencyKey: newIdempotencyKey(), // one key per click: retries reuse it, a double-click doesn't
      });
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
        // e.g. 403 compliance hold, 423 frozen, 429 too many transfers, 500/503 server errors:
        // start the retry with an empty pad.
        mpinInput.clear();
        setFormError(mpinForm, describeError(err));
        if (err.unconfirmed) loadWallet().catch(() => {});
      }
    }
  });

  /** A user-facing message for a failed transfer, with the compliance reason when it was held. */
  function describeError(err) {
    if (err.unconfirmed) {
      // Still failing after the automatic retries: the answer may have been lost after the
      // transfer went through, so don't claim either way. Retries never send twice.
      return "We couldn't reach PayPulse after 3 retries, so this transfer isn't confirmed. " +
        'Your balance has been refreshed: check Recent activity before trying again.';
    }
    if (err.status >= 500) return 'Something went wrong on our side. No money was sent. Please try again.';
    if (err.code === 'TRANSACTION_HELD_FOR_REVIEW' && err.details?.reason) {
      return `${err.message}: ${err.details.reason} No money was sent.`;
    }
    return err.message;
  }

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
        idempotencyKey: newIdempotencyKey(),
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
        toast(describeError(err), 'error');
      }
    }
  });

  $('#otp-resend').addEventListener('click', async () => {
    if (!pending) return;
    $('#otp-resend').disabled = true;
    try {
      const result = await api(pending.endpoint, { method: 'POST', body: transferBody(), idempotencyKey: newIdempotencyKey() });
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
    const waiting = [...document.querySelectorAll('dialog[open]')].find((d) => d !== revealDialog);
    if (mpinDialog.open) mpinInput.clear();
    else if (waiting) {
      // Another MPIN screen (Buy Load, Pay Bills, card, loan…) is still open underneath: back to it.
      waiting.querySelector('.code-input input')?.focus();
      updateMpinStatuses();
    } else if (pending && !otpDialog.open) openMpinPad(); // continue the transfer that needed an MPIN
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

  // Every other screen that asks for the MPIN (Buy Load, Pay Bills, Instant Loan, virtual card,
  // linked accounts, security, Change MPIN) shows the same live status and "get a new MPIN" link.
  document.querySelectorAll('[data-mpin-forgot]').forEach((btn) => {
    btn.addEventListener('click', () => openMpinReset(!hasMpin ? 'setup' : mpinSecondsLeft() === 0 ? 'expired' : 'forgot'));
  });

  function updateMpinStatuses() {
    const left = mpinSecondsLeft();
    document.querySelectorAll('[data-mpin-status]').forEach((el) => {
      if (!el.closest('dialog[open]') || el.closest('[hidden]')) return;
      el.textContent = !hasMpin
        ? "You don't have an MPIN yet. Tap below to get one."
        : left > 0
          ? `MPIN expires in ${formatCountdown(left)}`
          : 'Your MPIN has expired. Tap below to get a new one.';
      el.classList.toggle('expired', !hasMpin || left === 0);
      el.classList.toggle('warn', hasMpin && left > 0 && left <= 60);
    });
  }
  setInterval(updateMpinStatuses, 500);
  // Fill it in as soon as an MPIN screen opens (they open from a click, a submit or a switch).
  for (const type of ['click', 'submit', 'change']) {
    document.addEventListener(type, () => requestAnimationFrame(updateMpinStatuses), true);
  }

  /**
   * For any MPIN-protected action: an expired or missing MPIN opens "get a new MPIN" right away
   * (the screen underneath stays open, so the user continues where they were). Returns true if handled.
   */
  function handleMpinError(err) {
    if (err.code === 'MPIN_EXPIRED') {
      setMpinExpiry(0);
      openMpinReset('expired');
      return true;
    }
    if (err.code === 'MPIN_NOT_SET') {
      hasMpin = false;
      openMpinReset('setup');
      return true;
    }
    return false;
  }

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

  // ---------- My profile: KYC, settings menu, help center, QA & sandbox rules ----------

  const profileDialog = $('#profile-dialog');
  let profileTimer = null;
  let profile = null; // GET /api/v1/profile

  /** "Juan Dela Cruz" -> "JC" */
  function initials(name) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  const MEMBER_SINCE = new Intl.DateTimeFormat('en-PH', { dateStyle: 'long', timeZone: 'Asia/Manila' });
  const RESET_TIME = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
  const TICKET_TIME = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' });

  function fillRows(listEl, rows) {
    listEl.replaceChildren(
      ...rows.flatMap(([term, value]) => [
        Object.assign(document.createElement('dt'), { textContent: term }),
        Object.assign(document.createElement('dd'), { textContent: value }),
      ]),
    );
  }

  function showProfilePanel(name) {
    profileDialog.querySelectorAll('.profile-panel').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== name;
    });
    profileDialog.scrollTop = 0;
    if (name === 'mpin') resetMpinChangeForm();
    if (name === 'help') renderChatIntro();
  }

  profileDialog.querySelectorAll('[data-profile-panel]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.profilePanel;
      showProfilePanel(target === 'main' ? 'main' : target);
    });
  });

  function renderProfileStatic() {
    const a = lastAccount;
    $('#profile-avatar').textContent = initials(a.accountHolder);
    $('#profile-name').textContent = a.accountHolder;
    $('#profile-email').textContent = a.email;
    fillRows($('#profile-account'), [
      ['Account no.', a.accountNumber],
      ...(a.mobileNumber ? [['Mobile no.', a.mobileNumber]] : []),
      ['Currency', a.currency],
      ['Role', a.role === 'ADMIN' ? 'Admin' : 'Customer'],
      ['Member since', MEMBER_SINCE.format(new Date(a.memberSince))],
    ]);
  }

  /** KYC badge, tier card, menu subtitles, linked accounts, security toggles, tickets. */
  function renderProfile() {
    if (!profile) return;
    const { kyc } = profile;
    const badge = $('#kyc-badge');
    badge.textContent = kyc.verified ? '✓ Verified ' + kyc.label : kyc.label + ' · Not yet verified';
    badge.classList.toggle('verified', kyc.verified);
    $('#kyc-current').textContent = 'Level ' + kyc.level;
    $('#kyc-tiers').replaceChildren(
      ...kyc.tiers.map((t) => {
        const li = document.createElement('li');
        li.className = t.level === kyc.level ? 'current' : t.level < kyc.level ? 'done' : '';
        li.append(
          Object.assign(document.createElement('span'), { className: 'tier-dot', textContent: t.level <= kyc.level ? '✓' : String(t.level) }),
          Object.assign(document.createElement('span'), { className: 'tier-text', innerHTML: '' }),
        );
        const text = li.lastChild;
        text.append(
          Object.assign(document.createElement('strong'), { textContent: t.label }),
          Object.assign(document.createElement('small'), { textContent: t.requirements }),
        );
        li.append(Object.assign(document.createElement('span'), { className: 'tier-limit', textContent: money(t.dailyLimit) + '/day' }));
        return li;
      }),
    );
    $('#kyc-start').hidden = kyc.verified;
    const next = kyc.tiers.find((t) => t.level === kyc.level + 1);
    if (next) {
      $('#kyc-start').textContent = 'Verify your ID to raise your limit to ' + money(next.dailyLimit);
      $('#kyc-target-limit').textContent = money(next.dailyLimit);
    }

    const linked = profile.linkedAccounts;
    $('#menu-linked-sub').textContent = linked.length
      ? linked.map((l) => l.name + ' ' + l.maskedNumber).join(', ')
      : 'None linked yet';
    $('#linked-empty').hidden = linked.length > 0;
    $('#linked-list').replaceChildren(
      ...linked.map((l) => {
        const li = document.createElement('li');
        li.className = 'linked-item';
        const logo = Object.assign(document.createElement('span'), {
          className: 'linked-logo ' + (l.kind === 'CARD' ? 'card' : 'bank'),
          textContent: l.kind === 'CARD' ? (l.institution === 'Visa' ? 'VISA' : 'MC') : l.institution.slice(0, 3),
        });
        const text = document.createElement('span');
        text.className = 'menu-text';
        text.append(
          Object.assign(document.createElement('strong'), { textContent: l.name + ' ' + l.maskedNumber }),
          Object.assign(document.createElement('small'), {
            textContent: l.holderName + (l.expiry ? ' · Expires ' + l.expiry : ' · Bank account'),
          }),
        );
        const remove = Object.assign(document.createElement('button'), {
          type: 'button',
          className: 'btn link unlink',
          textContent: 'Remove',
        });
        remove.dataset.testid = 'linked-remove';
        remove.addEventListener('click', () => unlinkAccount(l));
        li.append(logo, text, remove);
        return li;
      }),
    );

    $('#sec-bio').checked = profile.security.biometricLogin;
    $('#sec-sms').checked = profile.security.smsTwoFactor;
    $('#menu-security-sub').textContent =
      'Face ID / Touch ID ' + (profile.security.biometricLogin ? 'on' : 'off') +
      ' · SMS 2FA ' + (profile.security.smsTwoFactor ? 'on every transfer' : 'above ₱1,000');
    renderTickets();
  }

  async function loadProfile() {
    profile = await api('/api/v1/profile');
    renderProfile();
  }

  function renderSecurity() {
    const left = mpinSecondsLeft();
    const mpinStatus = !hasMpin ? 'Not set up' : left > 0 ? 'Valid for ' + formatCountdown(left) : 'Expired';
    fillRows($('#profile-security'), [
      ['MPIN status', mpinStatus],
      ['MPIN lifetime', '5 minutes after you get or change it'],
      ['Wrong MPIN', '5 in a row locks transfers for 5 min'],
      ['One-time code (OTP)', profile?.security.smsTwoFactor ? 'On every transfer (SMS 2FA on)' : 'For transfers above ₱1,000'],
      ['AML review threshold', 'One transfer above ₱500,000, or more than 5 transfers / bill payments a minute'],
      ['Compliance status', lastAccount?.amlStatus === 'UNDER_REVIEW' ? 'Under review: sending is on hold' : 'Clear'],
      ['Bank transfer fee', money(15) + ' per transfer'],
      ['Role', lastAccount?.role === 'ADMIN' ? 'Admin (can Add money and use QA tools)' : 'Customer'],
    ]);
  }

  /** Daily limit meter + anti-spam slots, from GET /api/transfers/limits. */
  async function refreshLimits() {
    const { daily, rateLimit } = await api('/api/transfers/limits');
    const limit = Number(daily.limit);
    const sent = Number(daily.sentToday);
    const percent = Math.min(100, (sent / limit) * 100);

    $('#daily-left').textContent = money(daily.remaining) + ' left';
    $('#daily-bar').style.width = percent + '%';
    const meter = $('#daily-meter');
    meter.setAttribute('aria-valuemax', String(limit));
    meter.setAttribute('aria-valuenow', String(sent));
    meter.setAttribute('aria-valuetext', money(sent) + ' of ' + money(limit) + ' sent today');
    const resets = RESET_TIME.format(new Date(daily.resetsAt));
    const dailyText = $('#daily-text');
    dailyText.textContent = Number(daily.remaining) > 0
      ? money(sent) + ' of ' + money(limit) + ' sent today · Resets at ' + resets + ' (PH time)'
      : 'Limit reached: ' + money(limit) + ' sent today. Resets at ' + resets + ' (PH time).';
    dailyText.classList.toggle('blocked', Number(daily.remaining) <= 0);
    $('#kyc-usage').textContent = 'Today: ' + money(sent) + ' of your ' + money(limit) + ' daily limit used.';

    const used = Math.min(rateLimit.transfersInWindow, rateLimit.maxTransfers);
    $('#spam-count').textContent = used + ' of ' + rateLimit.maxTransfers + ' used';
    $('#spam-slots').replaceChildren(
      ...Array.from({ length: rateLimit.maxTransfers }, (_, i) =>
        Object.assign(document.createElement('span'), { className: 'slot' + (i < used ? ' used' : '') }),
      ),
    );
    const spamText = $('#spam-text');
    const blocked = used >= rateLimit.maxTransfers;
    spamText.textContent = blocked
      ? 'Blocked: the next transfer is refused until the oldest one is more than ' + rateLimit.windowSeconds + ' seconds old.'
      : 'At most ' + rateLimit.maxTransfers + ' transfers in any ' + rateLimit.windowSeconds + ' seconds. ' +
        'Transfers in the last ' + rateLimit.windowSeconds + ' seconds: ' + rateLimit.transfersInWindow + '.';
    spamText.classList.toggle('blocked', blocked);
  }

  async function openProfile() {
    if (!lastAccount) await loadWallet();
    renderProfileStatic();
    showProfilePanel('main');
    try {
      await Promise.all([loadProfile(), refreshLimits()]);
    } catch (err) {
      toast(err.message, 'error');
    }
    renderSecurity();
    profileDialog.showModal();
    clearInterval(profileTimer);
    // Live while open, so you can watch the anti-spam window empty again.
    profileTimer = setInterval(() => {
      renderSecurity();
      refreshLimits().catch(() => {});
    }, 2000);
  }

  profileDialog.addEventListener('close', () => clearInterval(profileTimer));
  $('#profile-btn').addEventListener('click', openProfile);
  $('#profile-new-mpin').addEventListener('click', () => openMpinReset());

  // --- KYC: verify ID (mock, approved instantly) ---
  const kycForm = $('#kyc-form');
  let selfieTaken = false;

  function setSelfie(taken) {
    selfieTaken = taken;
    $('#kyc-selfie').setAttribute('aria-pressed', String(taken));
    $('#kyc-selfie').classList.toggle('done', taken);
    $('#kyc-selfie-title').textContent = taken ? 'Selfie captured' : 'Take a selfie with your ID';
    $('#kyc-selfie-text').textContent = taken ? 'Tap to retake' : 'Simulated camera: tap to capture';
  }

  $('#kyc-start').addEventListener('click', () => {
    kycForm.reset();
    setFormError(kycForm);
    setSelfie(false);
    kycForm.elements.idType.replaceChildren(
      ...profile.kyc.idTypes.map((t) => Object.assign(document.createElement('option'), { value: t.code, textContent: t.name })),
    );
    showProfilePanel('kyc');
  });
  $('#kyc-selfie').addEventListener('click', () => setSelfie(!selfieTaken));

  kycForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError(kycForm);
    const { idType, idNumber, birthDate } = formData(kycForm);
    if (!idNumber.trim()) return setFormError(kycForm, 'Enter your ID number.');
    if (!birthDate) return setFormError(kycForm, 'Enter your date of birth.');
    if (!selfieTaken) return setFormError(kycForm, 'Take a selfie with your ID first.');
    try {
      await api('/api/v1/profile/kyc', { method: 'POST', body: { idType, idNumber, birthDate, selfieConfirmed: true } });
      await Promise.all([loadProfile(), refreshLimits(), loadWallet()]);
      showProfilePanel('main');
      toast("You're now Level 2 (Fully Verified). Daily limit: " + money(profile.kyc.dailyLimit), 'success');
    } catch (err) {
      setFormError(kycForm, err.message);
    }
  });

  // --- Linked bank accounts / cards ---
  const linkedForm = $('#linked-form');
  const linkedMpin = createCodeInput($('#linked-mpin-input'));

  function linkedKind() {
    return linkedForm.elements.kind.value;
  }
  function syncLinkedKind() {
    $('#linked-bank-fields').hidden = linkedKind() !== 'BANK';
    $('#linked-card-fields').hidden = linkedKind() !== 'CARD';
  }
  linkedForm.querySelectorAll('[name="kind"]').forEach((r) => r.addEventListener('change', syncLinkedKind));
  linkedForm.elements.expiry.addEventListener('input', (event) => {
    const digits = event.target.value.replace(/\D/g, '').slice(0, 4);
    event.target.value = digits.length > 2 ? digits.slice(0, 2) + '/' + digits.slice(2) : digits;
  });

  $('#linked-add-open').addEventListener('click', () => {
    linkedForm.reset();
    setFormError(linkedForm);
    linkedMpin.clear();
    linkedForm.elements.bankCode.replaceChildren(
      ...profile.linkableBanks.map((b) => Object.assign(document.createElement('option'), { value: b.code, textContent: b.name })),
    );
    linkedForm.elements.holderName.value = lastAccount?.accountHolder ?? '';
    syncLinkedKind();
    linkedForm.hidden = false;
    $('#linked-add-open').hidden = true;
  });

  linkedForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError(linkedForm);
    const mpin = linkedMpin.value();
    if (!/^\d{6}$/.test(mpin)) return setFormError(linkedForm, 'Enter all 6 digits of your MPIN.');
    const data = formData(linkedForm);
    const body = data.kind === 'BANK'
      ? { kind: 'BANK', bankCode: data.bankCode, accountNumber: data.accountNumber, holderName: data.holderName, mpin }
      : { kind: 'CARD', cardNumber: data.cardNumber, expiry: data.expiry, holderName: data.holderName, mpin };
    try {
      const linked = await api('/api/v1/profile/linked-accounts', { method: 'POST', body });
      linkedForm.hidden = true;
      $('#linked-add-open').hidden = false;
      await loadProfile();
      toast(linked.name + ' ' + linked.maskedNumber + ' linked', 'success');
    } catch (err) {
      if (handleMpinError(err)) return linkedMpin.clear();
      if (err.code === 'INVALID_MPIN') linkedMpin.clear();
      setFormError(linkedForm, err.message);
    }
  });

  async function unlinkAccount(l) {
    if (!window.confirm('Remove ' + l.name + ' ' + l.maskedNumber + ' from PayPulse?')) return;
    try {
      await api('/api/v1/profile/linked-accounts/' + l.id, { method: 'DELETE' });
      await loadProfile();
      toast(l.name + ' ' + l.maskedNumber + ' removed');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // --- Change MPIN: old -> new -> confirm ---
  const mpinChangeForm = $('#mpin-change-form');
  const mpinOld = createCodeInput($('#mpin-old-input'));
  const mpinNew = createCodeInput($('#mpin-new-input'));
  const mpinConfirm = createCodeInput($('#mpin-confirm-input'));

  function resetMpinChangeForm() {
    [mpinOld, mpinNew, mpinConfirm].forEach((input) => input.clear());
    setFormError(mpinChangeForm);
  }

  mpinChangeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError(mpinChangeForm);
    const currentMpin = mpinOld.value();
    const newMpin = mpinNew.value();
    const confirmMpin = mpinConfirm.value();
    if (!/^\d{6}$/.test(currentMpin)) return setFormError(mpinChangeForm, 'Enter all 6 digits of your current MPIN.');
    if (!/^\d{6}$/.test(newMpin)) return setFormError(mpinChangeForm, 'Your new MPIN must be 6 digits.');
    if (newMpin !== confirmMpin) return setFormError(mpinChangeForm, 'The new MPINs do not match.');
    try {
      const result = await api('/api/accounts/me/mpin/change', { method: 'POST', body: { currentMpin, newMpin, confirmMpin } });
      hasMpin = true;
      setMpinExpiry(result.mpinExpiresInSeconds);
      renderSecurity();
      showProfilePanel('main');
      toast('MPIN changed. Use your new MPIN for your next transfer.', 'success');
    } catch (err) {
      if (handleMpinError(err)) return mpinOld.clear();
      if (err.code === 'INVALID_MPIN') mpinOld.clear();
      setFormError(mpinChangeForm, err.message);
    }
  });

  // --- Security & biometrics ---
  const secMpinForm = $('#sec-mpin-form');
  const secMpin = createCodeInput($('#sec-mpin-input'));

  async function saveSecurity(body) {
    profile.security = await api('/api/v1/profile/security', { method: 'PATCH', body });
    renderProfile();
    renderSecurity();
  }

  $('#sec-bio').addEventListener('change', async (event) => {
    const on = event.target.checked;
    try {
      await saveSecurity({ biometricLogin: on });
      toast(on ? 'Face ID / Touch ID login turned on (simulated on the web)' : 'Face ID / Touch ID login turned off');
    } catch (err) {
      event.target.checked = !on;
      toast(err.message, 'error');
    }
  });

  $('#sec-sms').addEventListener('change', async (event) => {
    const on = event.target.checked;
    if (!on) {
      // Weakening security: ask for the MPIN first; the switch stays on until it's confirmed.
      event.target.checked = true;
      setFormError(secMpinForm);
      secMpin.clear();
      secMpinForm.hidden = false;
      return;
    }
    try {
      await saveSecurity({ smsTwoFactor: true });
      toast('SMS 2FA is on: every Send and Bank Transfer needs a code', 'success');
    } catch (err) {
      event.target.checked = false;
      toast(err.message, 'error');
    }
  });
  $('#sec-mpin-cancel').addEventListener('click', () => { secMpinForm.hidden = true; });
  secMpinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError(secMpinForm);
    const mpin = secMpin.value();
    if (!/^\d{6}$/.test(mpin)) return setFormError(secMpinForm, 'Enter all 6 digits of your MPIN.');
    try {
      await saveSecurity({ smsTwoFactor: false, mpin });
      secMpinForm.hidden = true;
      toast('SMS 2FA turned off. A code is still required above ₱1,000.');
    } catch (err) {
      if (handleMpinError(err)) return secMpin.clear();
      if (err.code === 'INVALID_MPIN') secMpin.clear();
      setFormError(secMpinForm, err.message);
    }
  });

  // --- Help center: FAQs, automated live chat, support tickets ---
  const FAQS = [
    ['Why does my MPIN expire?', 'For safety in this demo, an MPIN works for 5 minutes after you get or change it. Get a new one in Change MPIN (Forgot or expired MPIN).'],
    ['How much can I send a day?', 'Level 1 (Basic): ₱50,000 a day. Level 2 (Fully Verified): ₱100,000 a day. Express Send, Bank Transfer and Pay Bills all count. The limit resets at midnight (PH time).'],
    ['When do I need a one-time code (OTP)?', 'For every Send or Bank Transfer above ₱1,000. Turn on SMS 2FA in Security & Biometrics to get a code for every transfer.'],
    ['How does the bills cashback work?', 'You get ₱5.00 back on bills of ₱100 or more, up to 3 cashbacks a day. It is credited instantly.'],
    ['How do I repay my Instant Loan?', 'Open Instant Loan on Home and tap Pay installment or Pay in full. Payments cover interest first, then principal.'],
    ['Why is my transfer on hold?', 'A single transfer above ₱500,000, or more than 5 transfers a minute, is held for compliance review. Our team clears it after checking.'],
  ];
  $('#faq-list').replaceChildren(
    ...FAQS.map(([q, a]) => {
      const d = document.createElement('details');
      d.append(Object.assign(document.createElement('summary'), { textContent: q }), Object.assign(document.createElement('p'), { textContent: a }));
      return d;
    }),
  );

  const CHAT_ANSWERS = [
    [/mpin|pin|passcode/i, 'Your MPIN is valid for 5 minutes. Change it under Change MPIN, or get a new one there if it expired.'],
    [/limit|how much|maximum/i, 'Daily send limit: ₱50,000 for Level 1, ₱100,000 for Level 2 (Fully Verified). Verify your ID in My profile to raise it.'],
    [/verif|kyc|level|id\b/i, 'Tap "Verify your ID" in My profile, choose a government ID, enter its number and your birthday, and take a selfie.'],
    [/cashback|bill|meralco|pldt/i, 'Pay Bills gives ₱5.00 cashback on bills of ₱100 or more, up to 3 a day.'],
    [/loan|borrow|repay/i, 'Instant Loan: up to ₱50,000 at 1.5% a month, 3 to 12 months. Repay from the Instant Loan tile.'],
    [/hold|review|frozen|blocked/i, 'Large or very frequent transfers are held for compliance review. If it takes long, submit a ticket below.'],
    [/card|visa/i, 'Get a virtual Visa in the Card tab. You can lock it any time with the Freeze / Lock Card switch.'],
    [/hi|hello|hey|good (morning|afternoon|evening)/i, 'Hello! How can I help you today?'],
  ];
  let chatStarted = false;

  function chatMessage(text, from) {
    const li = Object.assign(document.createElement('li'), { className: 'chat-msg ' + from, textContent: text });
    $('#chat-log').append(li);
    $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
  }
  function renderChatIntro() {
    if (chatStarted) return;
    chatStarted = true;
    chatMessage("Hi! I'm the PayPulse Assistant (automated). Ask me about MPIN, limits, bills, loans or cards.", 'bot');
  }
  $('#chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = event.currentTarget.elements.message;
    const text = input.value.trim();
    if (!text) return;
    chatMessage(text, 'me');
    input.value = '';
    const answer = CHAT_ANSWERS.find(([pattern]) => pattern.test(text));
    setTimeout(() => {
      chatMessage(answer ? answer[1] : "I'm not sure about that one. Please submit a support ticket below and our team will get back to you.", 'bot');
    }, 500);
  });

  function renderTickets() {
    const list = $('#ticket-list');
    list.replaceChildren(
      ...(profile?.supportTickets ?? []).map((t) => {
        const li = document.createElement('li');
        li.className = 'ticket';
        li.append(
          Object.assign(document.createElement('strong'), { textContent: t.ticketNumber + ' · ' + t.subject }),
          Object.assign(document.createElement('small'), { textContent: TICKET_TIME.format(new Date(t.createdAt)) }),
          Object.assign(document.createElement('span'), { className: 'ticket-status ' + t.status.toLowerCase(), textContent: t.status.replace('_', ' ') }),
        );
        return li;
      }),
    );
  }

  $('#ticket-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    setFormError(form);
    const { category, subject, message } = formData(form);
    try {
      const ticket = await api('/api/v1/profile/support/tickets', { method: 'POST', body: { category, subject, message } });
      form.reset();
      await loadProfile();
      toast('Ticket ' + ticket.ticketNumber + ' submitted. We will reply by email.', 'success');
    } catch (err) {
      setFormError(form, err.message);
    }
  });

  // ---------- PayPulse Save ----------

  const savingsDialog = $('#savings-dialog');
  const savingsForm = $('#savings-form');
  let savingsDirection = 'DEPOSIT';

  async function loadSavingsAndCards() {
    const [vault, cards] = await Promise.all([api('/api/v1/savings'), api('/api/v1/cards')]);
    savings = vault;
    renderBalance(); // savings balance + total assets on the balance card
    $('#savings-rate').textContent = `${vault.annualRate}% p.a.`;
    $('#savings-meta').textContent =
      `Interest earned ${money(vault.interestEarned)} · about ${money(vault.estimatedDailyInterest)} a day` +
      (vault.lastAccrualDate ? ` · last credited for ${vault.lastAccrualDate}` : '');
    renderCard(cards.cards[0] || null);
  }

  $('#savings-open').addEventListener('click', () => openSavings('DEPOSIT'));
  $('#promo-banner').addEventListener('click', () => openSavings('DEPOSIT'));

  // ---------- Total assets ----------

  $('#assets-open').addEventListener('click', () => {
    const wallet = Number(currentBalance ?? 0);
    const saved = Number(savings?.balance ?? 0);
    $('#assets-total').textContent = money((wallet + saved).toFixed(2));
    const rows = [
      ['Wallet', money(wallet.toFixed(2))],
      [`PayPulse Save (${savings?.annualRate ?? '6.00'}% p.a.)`, money(saved.toFixed(2))],
      ['Interest earned so far', money(savings?.interestEarned ?? '0.00')],
    ];
    if (loanOverview?.activeLoan) rows.push(['Instant Loan you owe', `−${money(loanOverview.activeLoan.outstanding)}`]);
    $('#assets-rows').replaceChildren(
      ...rows.flatMap(([label, value]) => [
        Object.assign(document.createElement('dt'), { textContent: label }),
        Object.assign(document.createElement('dd'), { textContent: value }),
      ]),
    );
    $('#assets-dialog').showModal();
  });

  function openSavings(direction) {
    savingsDirection = direction;
    savingsForm.reset();
    setFormError(savingsForm);
    const toSavings = direction === 'DEPOSIT';
    $('#savings-title').textContent = toSavings ? 'Add to Savings' : 'Withdraw to Wallet';
    $('#savings-submit').textContent = toSavings ? 'Move to Savings' : 'Withdraw';
    $('#savings-available').textContent = toSavings
      ? `Available in your wallet: ${money(currentBalance ?? 0)}`
      : `Available in PayPulse Save: ${money(savings?.balance ?? 0)}`;
    savingsDialog.showModal();
  }

  $('#savings-add').addEventListener('click', () => openSavings('DEPOSIT'));
  $('#savings-withdraw').addEventListener('click', () => openSavings('WITHDRAW'));

  savingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const amount = savingsForm.elements.amount.value.trim();
    setFormError(savingsForm);
    if (!validAmount(amount)) return setFormError(savingsForm, 'Enter a valid amount, e.g. 250 or 99.50.');
    try {
      const path = savingsDirection === 'DEPOSIT' ? '/api/v1/savings/deposit' : '/api/v1/savings/withdraw';
      const result = await api(path, { method: 'POST', body: { amount }, idempotencyKey: newIdempotencyKey() });
      savingsDialog.close();
      toast(
        savingsDirection === 'DEPOSIT'
          ? `${money(result.amount)} moved to PayPulse Save`
          : `${money(result.amount)} withdrawn to your wallet`,
        'success',
      );
      await loadWallet();
    } catch (err) {
      setFormError(savingsForm, describeError(err));
      if (err.unconfirmed) loadWallet().catch(() => {});
    }
  });

  // ---------- Buy Load ----------

  const loadDialog = $('#load-dialog');
  const loadForm = $('#load-form');
  const loadReview = $('#load-review');
  const loadMpin = createCodeInput($('#load-mpin-input'));
  let loadCatalog = null; // GET /api/v1/load
  let loadBrand = null; // selected brand code
  let loadDetected = null; // detected network code
  let loadAmount = null; // regular amount (pesos)
  let loadPromo = null; // selected promo code
  let loadPending = null;

  /** Same normalisation as the server: +63 / 63 / spaces -> 09XXXXXXXXX */
  const normalizeLoadMobile = (v) => {
    const d = String(v || '').replace(/[\s()-]/g, '').replace(/^\+?63/, '0');
    return /^09\d{9}$/.test(d) ? d : null;
  };
  const brandName = (code) => loadCatalog?.brands.find((b) => b.code === code)?.name ?? code;
  const loadProductType = () => loadForm.elements.productType.value;

  function brandChip(code, group) {
    const label = document.createElement('label');
    label.className = 'brand-chip brand-' + code.toLowerCase();
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: group, value: code, checked: code === loadBrand });
    input.dataset.testid = (group === 'load-brand' ? 'load-brand-' : 'load-brand-any-') + code;
    input.addEventListener('change', () => selectBrand(code));
    label.append(input, Object.assign(document.createElement('span'), { textContent: brandName(code) }));
    return label;
  }

  function selectBrand(code) {
    loadBrand = code;
    if (loadPromo && loadCatalog.promos.find((p) => p.code === loadPromo)?.brand !== code) loadPromo = null;
    renderLoadBrands();
    renderLoadProducts();
  }

  function renderLoadBrands() {
    const network = loadCatalog.networks.find((n) => n.code === loadDetected);
    $('#load-brands').hidden = !network;
    $('#load-brands').replaceChildren(...(network ? network.brands.map((b) => brandChip(b, 'load-brand')) : []));
    $('#load-override').hidden = !normalizeLoadMobile(loadForm.elements.mobileNumber.value);
    $('#load-all-brands').replaceChildren(...loadCatalog.brands.map((b) => brandChip(b.code, 'load-brand-any')));
  }

  function onLoadMobileInput() {
    const number = normalizeLoadMobile(loadForm.elements.mobileNumber.value);
    const detect = $('#load-detect');
    loadDetected = null;
    if (!number) {
      detect.textContent = loadForm.elements.mobileNumber.value.trim() ? 'Enter all 11 digits, e.g. 09171234567' : '';
      detect.className = 'telco-detect';
      loadBrand = null;
    } else {
      const prefix = number.slice(0, 4);
      const network = loadCatalog.networks.find((n) => n.prefixes?.includes(prefix)) ?? null;
      if (network) {
        loadDetected = network.code;
        if (!network.brands.includes(loadBrand)) loadBrand = network.brands[0];
        detect.textContent = network.brands.length > 1
          ? `${network.name} detected (${prefix}). Choose your brand:`
          : `${network.name} detected (${prefix})`;
        detect.className = 'telco-detect ok';
      } else {
        detect.textContent = `We don't recognise ${prefix}. Choose the network below.`;
        detect.className = 'telco-detect warn';
        $('#load-override').open = true;
      }
    }
    renderLoadBrands();
    renderLoadProducts();
  }

  function renderLoadProducts() {
    const promo = loadProductType() === 'PROMO';
    $('#load-regular').hidden = promo;
    $('#load-promos').hidden = !promo;
    $('#load-amounts').replaceChildren(
      ...loadCatalog.regularAmounts.map((a) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'amount-chip', textContent: money(a).replace('.00', '') });
        b.dataset.testid = 'load-amount-' + a;
        b.setAttribute('aria-pressed', String(loadAmount === a));
        b.addEventListener('click', () => {
          loadAmount = a;
          loadForm.elements.amount.value = '';
          renderLoadProducts();
        });
        return b;
      }),
    );
    const promos = loadCatalog.promos.filter((p) => p.brand === loadBrand);
    $('#load-promos').replaceChildren(
      ...(loadBrand
        ? promos.length
          ? promos.map((p) => {
              const b = Object.assign(document.createElement('button'), { type: 'button', className: 'promo-item' });
              b.dataset.testid = 'load-promo-' + p.code;
              b.setAttribute('aria-pressed', String(loadPromo === p.code));
              const text = document.createElement('span');
              text.append(
                Object.assign(document.createElement('strong'), { textContent: p.name }),
                Object.assign(document.createElement('small'), { textContent: p.description + ' · ' + p.validity }),
              );
              b.append(text, Object.assign(document.createElement('span'), { className: 'promo-price', textContent: money(p.price).replace('.00', '') }));
              b.addEventListener('click', () => {
                loadPromo = p.code;
                renderLoadProducts();
              });
              return b;
            })
          : [Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No promos for ' + brandName(loadBrand) + ' yet. Use Regular Load.' })]
        : [Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Enter the mobile number first to see its promos.' })]),
    );
  }

  function loadCashbackHint() {
    const c = loadCatalog?.cashback;
    if (!c) return '';
    return c.remainingToday > 0
      ? `🎁 Earn ${money(c.amount)} cashback on loads of ${money(c.minAmount)} or more (${c.remainingToday} of ${c.dailyMax} left today)`
      : `You've used today's ${c.dailyMax} load cashbacks. More tomorrow!`;
  }

  async function openLoad() {
    try {
      loadCatalog = await api('/api/v1/load');
    } catch (err) {
      return toast(err.message, 'error');
    }
    loadForm.reset();
    setFormError(loadForm);
    loadBrand = null;
    loadDetected = null;
    loadAmount = null;
    loadPromo = null;
    $('#load-cashback-hint').textContent = loadCashbackHint();
    $('#load-detect').textContent = '';
    $('#load-override').open = false;
    loadForm.hidden = false;
    loadReview.hidden = true;
    renderLoadBrands();
    renderLoadProducts();
    loadDialog.showModal();
    loadForm.elements.mobileNumber.focus();
  }

  $('#load-btn').addEventListener('click', openLoad);
  loadForm.elements.mobileNumber.addEventListener('input', onLoadMobileInput);
  loadForm.querySelectorAll('[name="productType"]').forEach((r) => r.addEventListener('change', renderLoadProducts));
  loadForm.elements.amount.addEventListener('input', () => {
    if (loadForm.elements.amount.value.trim()) { loadAmount = null; renderLoadProducts(); }
  });
  $('#load-back').addEventListener('click', () => { loadReview.hidden = true; loadForm.hidden = false; });

  loadForm.addEventListener('submit', (event) => {
    event.preventDefault();
    setFormError(loadForm);
    const mobileNumber = normalizeLoadMobile(loadForm.elements.mobileNumber.value);
    if (!mobileNumber) return setFormError(loadForm, 'Enter an 11-digit mobile number, e.g. 09171234567.');
    if (!loadBrand) return setFormError(loadForm, 'Choose the network brand.');
    const type = loadProductType();
    let amount;
    let product;
    if (type === 'PROMO') {
      const promo = loadCatalog.promos.find((p) => p.code === loadPromo && p.brand === loadBrand);
      if (!promo) return setFormError(loadForm, 'Choose a promo package.');
      amount = promo.price;
      product = promo.name + ' (' + promo.description + ')';
    } else {
      const custom = loadForm.elements.amount.value.trim();
      amount = custom ? Number(custom) : loadAmount;
      if (!Number.isInteger(amount) || amount < loadCatalog.customMin || amount > loadCatalog.customMax) {
        return setFormError(loadForm, `Choose an amount, or enter a whole amount from ₱${loadCatalog.customMin} to ₱${loadCatalog.customMax.toLocaleString('en-PH')}.`);
      }
      product = 'Regular Load ' + money(amount).replace('.00', '');
    }
    if (currentBalance !== null && amount > Number(currentBalance)) {
      return setFormError(loadForm, `Your Available Balance is ${money(currentBalance)}.`);
    }
    loadPending = type === 'PROMO'
      ? { mobileNumber, brand: loadBrand, productType: 'PROMO', promoCode: loadPromo }
      : { mobileNumber, brand: loadBrand, productType: 'REGULAR', amount };

    setRows($('#load-summary'), [
      ['Mobile Number', mobileNumber],
      ['Network', brandName(loadBrand)],
      [type === 'PROMO' ? 'Promo' : 'Load', product],
      ['Amount', money(amount)],
      ['Convenience Fee', `${money(0)} (free)`],
    ]);
    $('#load-total').textContent = money(amount);
    const c = loadCatalog.cashback;
    const eligible = amount >= Number(c.minAmount) && c.remainingToday > 0;
    const banner = $('#load-cashback-banner');
    banner.classList.toggle('muted', !eligible);
    banner.textContent = eligible
      ? `🎁 Earn ${money(c.amount)} Cashback on this Load Purchase!`
      : c.remainingToday > 0
        ? `Cashback applies to loads of ${money(c.minAmount)} or more.`
        : `No cashback on this one: you've earned today's ${c.dailyMax} load cashbacks.`;
    setFormError(loadReview);
    loadMpin.clear();
    loadForm.hidden = true;
    loadReview.hidden = false;
  });

  loadReview.addEventListener('submit', async (event) => {
    event.preventDefault();
    const mpin = loadMpin.value();
    setFormError(loadReview);
    if (!/^\d{6}$/.test(mpin)) return setFormError(loadReview, 'Enter all 6 digits of your MPIN.');
    const submit = loadReview.querySelector('[type="submit"]');
    submit.disabled = true; // one tap = one purchase
    try {
      const bought = await api('/api/v1/load/purchase', { method: 'POST', body: { ...loadPending, mpin }, idempotencyKey: newIdempotencyKey() });
      loadDialog.close();
      await loadWallet();
      toast(
        bought.cashback.earned
          ? `${bought.brand.name} load sent to ${bought.mobileNumber}. ${money(bought.cashback.amount)} cashback added!`
          : `${bought.brand.name} load sent to ${bought.mobileNumber}.`,
        'success',
      );
      openReceipt(bought.transactionId);
    } catch (err) {
      if (handleMpinError(err)) {
        loadMpin.clear();
      } else if (err.code === 'INVALID_MPIN') {
        toast('Invalid MPIN', 'error');
        loadMpin.clear();
      } else {
        setFormError(loadReview, describeError(err));
        if (err.unconfirmed) loadWallet().catch(() => {});
      }
    } finally {
      submit.disabled = false;
    }
  });

  // ---------- Pay Bills ----------  

  const billsDialog = $('#bills-dialog');
  const billsForm = $('#bills-form');
  const billsReview = $('#bills-review');
  const billsMpin = createCodeInput($('#bills-mpin-input'));
  let billsCatalog = null; // GET /api/v1/bills
  let billsCategory = null; // selected category code, or null for the category grid
  let billsBiller = null;
  let billsPending = null; // { billerCode, accountNumber, accountName, amount }

  const BILL_CATEGORY_ICONS = {
    UTILITIES: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    TELECOMS: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/><path d="M2 9a15 15 0 0 1 20 0"/>',
    GOVERNMENT: '<path d="M3 21h18M5 21V10m4 11V10m6 11V10m4 11V10M2 10l10-6 10 6z"/>',
    LOANS: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
    CABLE: '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="m8 2 4 4 4-4"/>',
  };
  const svgIcon = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const initialsOf = (name) => name.replace(/\(.*?\)/g, '').split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  function showBillsStep(step) {
    $('#bills-browse').hidden = step !== 'browse';
    billsForm.hidden = step !== 'form';
    billsReview.hidden = step !== 'review';
  }

  function cashbackHintText() {
    const c = billsCatalog?.cashback;
    if (!c) return '';
    return c.remainingToday > 0
      ? `🎁 Earn ${money(c.amount)} cashback on bills of ${money(c.minBill)} or more (${c.remainingToday} of ${c.dailyMax} left today)`
      : `You've used today's ${c.dailyMax} bills cashbacks. More tomorrow!`;
  }

  function renderBillsBrowse() {
    const query = $('#bills-search').value.trim().toLowerCase();
    $('#bills-cashback-hint').textContent = cashbackHintText();
    const category = billsCatalog.categories.find((c) => c.code === billsCategory);
    const showList = Boolean(query || category);
    $('#bills-categories').hidden = showList;
    $('#bills-list').hidden = !showList;
    $('#bills-list-title').hidden = !showList;
    $('#bills-browse-back').hidden = !category || Boolean(query);
    $('#bills-title').textContent = category && !query ? category.name : 'Pay Bills';

    if (!showList) {
      $('#bills-empty').hidden = true;
      $('#bills-categories').replaceChildren(
        ...billsCatalog.categories.map((c) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `bill-category cat-${c.code.toLowerCase()}`;
          button.dataset.testid = `bills-category-${c.code}`;
          button.innerHTML = `<span class="bill-category-icon">${svgIcon(BILL_CATEGORY_ICONS[c.code] ?? '')}</span>`;
          button.append(
            Object.assign(document.createElement('strong'), { textContent: c.name }),
            Object.assign(document.createElement('small'), { textContent: c.description }),
          );
          button.addEventListener('click', () => {
            billsCategory = c.code;
            renderBillsBrowse();
          });
          return button;
        }),
      );
      return;
    }

    const billers = billsCatalog.billers.filter((b) =>
      query ? b.name.toLowerCase().includes(query) : b.category === billsCategory,
    );
    $('#bills-list-title').textContent = query ? `Results for "${$('#bills-search').value.trim()}"` : `${billers.length} billers`;
    $('#bills-empty').hidden = billers.length > 0;
    $('#bills-list').replaceChildren(
      ...billers.map((b) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'biller-row';
        button.dataset.testid = `biller-${b.code}`;
        const badge = Object.assign(document.createElement('span'), {
          className: `biller-badge cat-${b.category.toLowerCase()}`,
          textContent: initialsOf(b.name),
        });
        badge.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'biller-text';
        text.append(
          Object.assign(document.createElement('strong'), { textContent: b.name }),
          Object.assign(document.createElement('small'), {
            textContent: billsCatalog.categories.find((c) => c.code === b.category)?.name ?? '',
          }),
        );
        button.append(badge, text, Object.assign(document.createElement('span'), { className: 'chev', textContent: '›' }));
        button.addEventListener('click', () => chooseBiller(b));
        li.append(button);
        return li;
      }),
    );
  }

  function chooseBiller(b) {
    billsBiller = b;
    billsForm.reset();
    setFormError(billsForm);
    $('#bills-chosen').replaceChildren(
      Object.assign(document.createElement('span'), {
        className: `biller-badge cat-${b.category.toLowerCase()}`,
        textContent: initialsOf(b.name),
      }),
      Object.assign(document.createElement('strong'), { textContent: b.name }),
    );
    $('#bills-account-label').textContent = b.accountLabel;
    $('#bills-account-hint').textContent = b.sensitive
      ? `${b.accountHint}. Only the last 4 digits are kept on your receipt.`
      : b.accountHint;
    billsForm.elements.accountNumber.inputMode = b.sensitive || b.accountHint.includes('digit') ? 'numeric' : 'text';
    showBillsStep('form');
    billsForm.elements.accountNumber.focus();
  }

  async function openBills() {
    billsCategory = null;
    billsBiller = null;
    $('#bills-search').value = '';
    try {
      billsCatalog = await api('/api/v1/bills');
    } catch (err) {
      return toast(err.message, 'error');
    }
    renderBillsBrowse();
    showBillsStep('browse');
    billsDialog.showModal();
  }

  $('#bills-btn').addEventListener('click', openBills);
  $('#bills-search').addEventListener('input', renderBillsBrowse);
  $('#bills-browse-back').addEventListener('click', () => {
    billsCategory = null;
    renderBillsBrowse();
  });
  billsDialog.querySelectorAll('[data-bills-back]').forEach((button) => {
    button.addEventListener('click', () => showBillsStep(button.dataset.billsBack));
  });

  billsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    setFormError(billsForm);
    const { accountNumber, accountName, amount } = formData(billsForm);
    if (!accountNumber.trim()) return setFormError(billsForm, `Enter the ${billsBiller.accountLabel}.`);
    if (accountName.trim().length < 2) return setFormError(billsForm, 'Enter the account name as it appears on the bill.');
    if (!validAmount(amount.trim())) return setFormError(billsForm, 'Enter a valid amount, e.g. 1500 or 1499.50.');
    if (Number(amount) > Number(billsCatalog.maxAmount)) {
      return setFormError(billsForm, `A single bill payment can be up to ${money(billsCatalog.maxAmount)}.`);
    }
    if (currentBalance !== null && Number(amount) > Number(currentBalance)) {
      return setFormError(billsForm, `Your Available Balance is ${money(currentBalance)}.`);
    }

    billsPending = {
      billerCode: billsBiller.code,
      accountNumber: accountNumber.trim(),
      accountName: accountName.trim(),
      amount: amount.trim(),
    };
    const shownAccount = billsBiller.sensitive ? `••••${billsPending.accountNumber.replace(/\s+/g, '').slice(-4)}` : billsPending.accountNumber;
    setRows($('#bills-summary'), [
      ['Biller', billsBiller.name],
      [billsBiller.accountLabel, shownAccount],
      ['Account Name', billsPending.accountName],
      ['Amount Due', money(billsPending.amount)],
      ['Convenience Fee', `${money(billsCatalog.convenienceFee)} (free)`],
    ]);
    $('#bills-total').textContent = money(Number(billsPending.amount) + Number(billsCatalog.convenienceFee));

    const c = billsCatalog.cashback;
    const banner = $('#bills-cashback-banner');
    const eligible = Number(billsPending.amount) >= Number(c.minBill) && c.remainingToday > 0;
    banner.classList.toggle('muted', !eligible);
    banner.textContent = eligible
      ? `🎁 PayPulse Bonus: Earn ${money(c.amount)} Cashback on this transaction!`
      : c.remainingToday > 0
        ? `Cashback applies to bills of ${money(c.minBill)} or more.`
        : `No cashback on this one: you've earned today's ${c.dailyMax} bills cashbacks.`;

    setFormError(billsReview);
    billsMpin.clear();
    showBillsStep('review');
  });

  billsReview.addEventListener('submit', async (event) => {
    event.preventDefault();
    const mpin = billsMpin.value();
    setFormError(billsReview);
    if (!/^\d{6}$/.test(mpin)) return setFormError(billsReview, 'Enter all 6 digits of your MPIN.');
    const submit = billsReview.querySelector('[type="submit"]');
    submit.disabled = true; // one tap = one payment
    try {
      const paid = await api('/api/v1/bills/pay', {
        method: 'POST',
        body: { ...billsPending, mpin },
        idempotencyKey: newIdempotencyKey(),
      });
      billsDialog.close();
      await loadWallet();
      toast(
        paid.cashback.earned
          ? `${paid.biller.name} paid. ${money(paid.cashback.amount)} cashback added!`
          : `${paid.biller.name} paid.`,
        'success',
      );
      openReceipt(paid.transactionId);
    } catch (err) {
      if (handleMpinError(err)) {
        billsMpin.clear();
      } else if (err.code === 'INVALID_MPIN') {
        toast('Invalid MPIN', 'error');
        billsMpin.clear();
      } else if (err.code === 'INVALID_BILLER_ACCOUNT' || err.code === 'INVALID_ACCOUNT_NAME') {
        showBillsStep('form');
        setFormError(billsForm, err.message);
      } else {
        setFormError(billsReview, describeError(err));
        if (err.unconfirmed) loadWallet().catch(() => {});
      }
    } finally {
      submit.disabled = false;
    }
  });

  // ---------- Instant Loan ----------

  const loanDialog = $('#loan-dialog');
  const loanForm = $('#loan-form');
  const loanAmount = $('#loan-amount');
  let loanOverview = null; // GET /api/v1/loans
  let loanRequest = null; // { amount, termMonths } waiting for the MPIN

  const shortDate = (iso) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });

  /**
   * Loans change only when you apply, repay or reset, so they are loaded at login and after those
   * actions, not on every balance refresh (keeps the dashboard to as few calls as possible).
   */
  async function loadLoans() {
    renderLoan(await api('/api/v1/loans'));
  }

  function renderLoan(overview) {
    loanOverview = overview;
    const loan = overview.activeLoan;
    $('#loan-tile-text').textContent = loan
      ? `You owe ${money(loan.outstanding)}${loan.nextDue ? ` · next ${money(loan.nextDue.amount)} due ${shortDate(loan.nextDue.dueDate)}` : ''}`
      : `Available: ${money(overview.available)}`;
    if (loanDialog.open) showLoanView();
  }

  /** Same formula as the server (flat add-on interest); the server's numbers are what counts. */
  function loanQuote(amount, termMonths) {
    const principalCents = Math.round(Number(amount) * 100);
    const rateBps = Math.round(Number(loanOverview?.monthlyRate ?? '1.50') * 100);
    const interestCents = Math.round((principalCents * rateBps * termMonths) / 10_000);
    const totalCents = principalCents + interestCents;
    return { interestCents, totalCents, installmentCents: Math.ceil(totalCents / termMonths) };
  }

  function setRows(dl, rows) {
    dl.replaceChildren(
      ...rows.flatMap(([label, value]) => [
        Object.assign(document.createElement('dt'), { textContent: label }),
        Object.assign(document.createElement('dd'), { textContent: value }),
      ]),
    );
  }

  function updateLoanQuote() {
    const amount = Number(loanAmount.value);
    const termMonths = Number(loanForm.elements.term.value);
    const q = loanQuote(amount, termMonths);
    const pct = ((amount - loanAmount.min) / (loanAmount.max - loanAmount.min)) * 100;
    loanAmount.style.setProperty('--fill', `${pct}%`);
    $('#loan-amount-out').textContent = money(amount);
    const firstDue = new Date();
    firstDue.setMonth(firstDue.getMonth() + 1);
    setRows($('#loan-quote'), [
      ['Interest rate', `${loanOverview?.monthlyRate ?? '1.50'}% a month (flat)`],
      ['Interest', money(q.interestCents / 100)],
      ['Total to repay', money(q.totalCents / 100)],
      ['Monthly installment', `${money(q.installmentCents / 100)} × ${termMonths}`],
      ['First payment', firstDue.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })],
    ]);
  }

  function showLoanView() {
    const loan = loanOverview?.activeLoan;
    loanForm.hidden = Boolean(loan);
    $('#loan-active').hidden = !loan;
    if (!loan) return updateLoanQuote();

    $('#loan-outstanding').textContent = money(loan.outstanding);
    const paidPct = Math.round((Number(loan.paid) / Number(loan.totalRepayable)) * 100);
    $('#loan-progress-fill').style.width = `${paidPct}%`;
    $('#loan-progress').setAttribute('aria-valuenow', String(paidPct));
    $('#loan-progress-text').textContent = `${money(loan.paid)} of ${money(loan.totalRepayable)} repaid`;
    setRows($('#loan-details'), [
      ['Borrowed', money(loan.principal)],
      ['Term', `${loan.termMonths} months at ${loan.monthlyRate}% a month`],
      ['Monthly installment', money(loan.monthlyInstallment)],
      ['Next payment', loan.nextDue ? `${money(loan.nextDue.amount)} on ${shortDate(loan.nextDue.dueDate)}` : '—'],
    ]);
    $('#loan-schedule').replaceChildren(
      ...loan.schedule.map((item) => {
        const li = document.createElement('li');
        if (item.status === 'PAID') li.className = 'paid';
        li.append(
          Object.assign(document.createElement('span'), { textContent: `${item.number}. ${shortDate(item.dueDate)}` }),
          Object.assign(document.createElement('span'), {
            textContent: item.status === 'PAID' ? `${money(item.amount)} ✓` : money(item.remaining),
          }),
        );
        return li;
      }),
    );
    $('#loan-pay-next').textContent = loan.nextDue ? `Pay installment (${money(loan.nextDue.amount)})` : 'Pay installment';
    $('#loan-pay-full').textContent = `Pay in full (${money(loan.outstanding)})`;
  }

  async function openLoan() {
    setFormError(loanForm);
    setFormError($('#loan-active'));
    loanAmount.value = '10000';
    loanForm.elements.term.value = '6';
    try {
      renderLoan(await api('/api/v1/loans'));
    } catch {
      /* show what we have */
    }
    showLoanView();
    loanDialog.showModal();
  }

  $('#loan-open').addEventListener('click', openLoan);
  loanAmount.addEventListener('input', updateLoanQuote);
  loanForm.querySelectorAll('[name="term"]').forEach((r) => r.addEventListener('change', updateLoanQuote));

  loanForm.addEventListener('submit', (event) => {
    event.preventDefault();
    setFormError(loanForm);
    loanRequest = { amount: loanAmount.value, termMonths: Number(loanForm.elements.term.value) };
    askCardMpin('loan');
  });

  function repayLoan(amount, full) {
    const loan = loanOverview?.activeLoan;
    setFormError($('#loan-active'));
    if (!loan) return;
    if (full && !window.confirm(`Pay ${money(amount)} from your wallet and close this loan?`)) return;
    mpinRequest = { loanId: loan.loanId, amount, full };
    askCardMpin('repay');
  }

  $('#loan-pay-next').addEventListener('click', () => {
    const next = loanOverview?.activeLoan?.nextDue;
    if (next) repayLoan(next.amount, false);
  });
  $('#loan-pay-full').addEventListener('click', () => {
    const loan = loanOverview?.activeLoan;
    if (loan) repayLoan(loan.outstanding, true);
  });

  // ---------- Virtual card ----------

  const cardMpinDialog = $('#card-mpin-dialog');
  const cardMpinForm = $('#card-mpin-form');
  const cardMpinInput = createCodeInput($('#card-mpin-input'));
  let card = null; // the user's first card (public, masked view)
  let cardMpinAction = null; // 'generate' | 'reveal' | 'loan' | 'repay' | 'card-pay' | 'unlock'
  let mpinRequest = null; // details of the action waiting for the MPIN
  let maskTimer = null;

  const groupPan = (pan) => pan.replace(/(\d{4})(?=\d)/g, '$1 ');

  function renderCard(c) {
    card = c;
    $('#card-empty').hidden = Boolean(c);
    $('#card-view').hidden = !c;
    renderCardSummary(c);
    if (!c) return;
    if (!maskTimer) {
      $('#vcard-number').textContent = c.maskedPan;
      $('#vcard-cvv').textContent = '•••';
    }
    $('#vcard-name').textContent = c.cardholderName;
    $('#vcard-expiry').textContent = c.expiry;
    $('#vcard-status').textContent = c.status === 'FROZEN' ? 'FROZEN' : 'ACTIVE';
    $('#vcard').classList.toggle('frozen', c.status === 'FROZEN');
    $('#card-freeze').checked = c.status === 'FROZEN';
    $('#card-lock-hint').textContent =
      c.status === 'FROZEN' ? 'Card is locked: every payment is declined' : 'Card is active: online payments are allowed';
  }

  /** The "PayPulse Card" tile on the Home tab: masked number and status only. */
  function renderCardSummary(c) {
    $('#card-summary-number').textContent = c ? `•••• ${c.maskedPan.slice(-4)}` : 'No card yet';
    $('#card-summary-status').textContent = c
      ? `Virtual Visa · ${c.status === 'FROZEN' ? 'Frozen' : 'Active'}`
      : 'Virtual Visa for online payments';
    $('#card-summary-label').textContent = c ? `Expires ${c.expiry}` : 'Get yours free';
    $('#card-summary-action').textContent = c ? 'Manage' : 'Get card';
  }

  $('#card-summary-open').addEventListener('click', () => {
    showTab('card');
    if (!card) askCardMpin('generate');
  });

  function hideCardDetails() {
    clearTimeout(maskTimer);
    maskTimer = null;
    if (card) {
      $('#vcard-number').textContent = card.maskedPan;
      $('#vcard-cvv').textContent = '•••';
    }
    $('#card-reveal').textContent = 'Show card details';
    $('#card-hint').textContent = 'Card details are hidden. They are shown for 30 seconds after you enter your MPIN.';
  }

  function askCardMpin(action) {
    cardMpinAction = action;
    $('#card-mpin-purpose').textContent =
      action === 'generate'
        ? 'Confirm with your MPIN to create a virtual Visa card linked to your wallet.'
        : action === 'loan'
          ? `Confirm with your MPIN to borrow ${money(loanRequest.amount)} over ${loanRequest.termMonths} months.`
          : action === 'repay'
            ? `Confirm with your MPIN to pay ${money(mpinRequest.amount)} for your Instant Loan.`
            : action === 'card-pay'
              ? `Confirm with your MPIN to pay ${money(mpinRequest.amount)} to ${mpinRequest.merchant} with your virtual card.`
              : action === 'unlock'
                ? 'Confirm with your MPIN to unlock your card.'
                : 'Confirm with your MPIN to show the full card number and CVV.';
    setFormError(cardMpinForm);
    cardMpinDialog.showModal();
    cardMpinInput.clear();
  }

  $('#card-generate').addEventListener('click', () => askCardMpin('generate'));
  $('#card-reveal').addEventListener('click', () => (maskTimer ? hideCardDetails() : askCardMpin('reveal')));

  $('#card-freeze').addEventListener('change', async (event) => {
    if (!card) return;
    const toggle = event.currentTarget;
    const next = toggle.checked ? 'FROZEN' : 'ACTIVE';
    if (next === 'ACTIVE') {
      toggle.checked = true; // stays locked until the MPIN is confirmed
      mpinRequest = {};
      askCardMpin('unlock');
      return;
    }
    toggle.disabled = true;
    try {
      renderCard(await api(`/api/v1/cards/${card.token}`, { method: 'PATCH', body: { status: next } }));
      if (next === 'FROZEN') hideCardDetails();
      toast(next === 'FROZEN' ? 'Card locked' : 'Card unlocked', 'success');
    } catch (err) {
      toggle.checked = !toggle.checked; // the server didn't change it
      toast(err.message, 'error');
    } finally {
      toggle.disabled = false;
    }
  });

  $('#card-pay-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    setFormError(form);
    if (!card) return;
    const { merchant, amount } = formData(form);
    if (!validAmount(amount.trim())) return setFormError(form, 'Enter a valid amount, e.g. 250 or 99.50.');
    if (card.status === 'FROZEN') {
      return setFormError(form, 'Payment declined: this card is locked. Unlock it in the Card tab to pay.');
    }
    mpinRequest = { amount: amount.trim(), merchant };
    askCardMpin('card-pay');
  });

  cardMpinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const mpin = cardMpinInput.value();
    setFormError(cardMpinForm);
    if (!/^\d{6}$/.test(mpin)) return setFormError(cardMpinForm, 'Enter all 6 digits of your MPIN.');
    try {
      if (cardMpinAction === 'repay') {
        const { loanId, amount, full } = mpinRequest;
        const result = await api(`/api/v1/loans/${loanId}/repay`, {
          method: 'POST',
          body: { amount, mpin },
          idempotencyKey: newIdempotencyKey(),
        });
        cardMpinDialog.close();
        await Promise.all([loadWallet(), loadLoans()]);
        if (result.status === 'PAID') {
          loanDialog.close();
          toast('Loan fully paid. Your ₱50,000 credit line is available again.', 'success');
        } else {
          toast(`Paid ${money(result.payment.amount)}. You owe ${money(result.outstanding)}.`, 'success');
        }
        void full;
      } else if (cardMpinAction === 'card-pay') {
        const { amount, merchant } = mpinRequest;
        const paid = await api('/api/v1/cards/' + card.token + '/payments', {
          method: 'POST',
          body: { amount, merchant, mpin },
          idempotencyKey: newIdempotencyKey(),
        });
        cardMpinDialog.close();
        $('#card-pay-form').reset();
        await loadWallet();
        toast(merchant + ' approved: ' + money(paid.amount) + ' (auth ' + paid.authCode + ')', 'success');
        openReceipt(paid.transactionId);
      } else if (cardMpinAction === 'unlock') {
        renderCard(await api(`/api/v1/cards/${card.token}`, { method: 'PATCH', body: { status: 'ACTIVE', mpin } }));
        cardMpinDialog.close();
        toast('Card unlocked', 'success');
      } else if (cardMpinAction === 'loan') {
        const loan = await api('/api/v1/loans', {
          method: 'POST',
          body: { ...loanRequest, mpin },
          idempotencyKey: newIdempotencyKey(),
        });
        cardMpinDialog.close();
        loanDialog.close();
        await Promise.all([loadWallet(), loadLoans()]);
        toast(`${money(loan.principal)} added to your Available Balance`, 'success');
        openReceipt(loan.transactionId);
      } else if (cardMpinAction === 'generate') {
        const created = await api('/api/v1/cards/generate', {
          method: 'POST',
          body: { mpin },
          idempotencyKey: newIdempotencyKey(),
        });
        cardMpinDialog.close();
        renderCard(created);
        toast('Your virtual Visa card is ready', 'success');
      } else {
        const details = await api(`/api/v1/cards/${card.token}/reveal`, { method: 'POST', body: { mpin } });
        cardMpinDialog.close();
        $('#vcard-number').textContent = groupPan(details.pan);
        $('#vcard-cvv').textContent = details.cvv;
        $('#card-reveal').textContent = 'Hide card details';
        $('#card-hint').textContent = 'Shown for 30 seconds. Never share your card number or CVV.';
        clearTimeout(maskTimer);
        maskTimer = setTimeout(hideCardDetails, 30_000);
      }
    } catch (err) {
      if (handleMpinError(err)) {
        cardMpinInput.clear();
      } else if (err.code === 'INVALID_MPIN') {
        toast('Invalid MPIN', 'error');
        cardMpinInput.clear();
      } else {
        setFormError(cardMpinForm, err.message);
      }
    }
  });

  // ---------- Receive via QR ----------

  const receiveQrDialog = $('#receive-qr-dialog');
  let currentQr = null; // { payload, svg, accountNumber, name, amount }
  let qrAmountTimer = null;

  async function loadMyQr() {
    const amount = $('#qr-amount').value.trim();
    const form = receiveQrDialog.querySelector('.form');
    setFormError(form);
    if (amount && !validAmount(amount)) return setFormError(form, 'Enter a valid amount, e.g. 250 or 99.50.');
    try {
      currentQr = await api(`/api/qr/me${amount ? `?amount=${encodeURIComponent(amount)}` : ''}`);
      $('#qr-image').innerHTML = currentQr.svg; // SVG generated by our own server (qrcode library)
      $('#qr-name').textContent = currentQr.name;
      $('#qr-account').textContent = currentQr.amount
        ? `${currentQr.accountNumber} · requesting ${money(currentQr.amount)}`
        : currentQr.accountNumber;
    } catch (err) {
      setFormError(form, err.message);
    }
  }

  $('#receive-qr-btn').addEventListener('click', async () => {
    $('#qr-amount').value = '';
    await loadMyQr();
    receiveQrDialog.showModal();
  });
  $('#qr-amount').addEventListener('input', () => {
    clearTimeout(qrAmountTimer);
    qrAmountTimer = setTimeout(loadMyQr, 400);
  });
  $('#qr-copy').addEventListener('click', async () => {
    if (currentQr && (await copyText(currentQr.payload))) toast('QR text copied', 'success');
  });

  /** Save the QR as a PNG (white background, with the account number underneath). */
  $('#qr-download').addEventListener('click', async () => {
    if (!currentQr) return;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(currentQr.svg)}`;
    await img.decode();
    const size = 600;
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size + 90 });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, size, size);
    ctx.fillStyle = '#1b1d2a';
    ctx.textAlign = 'center';
    ctx.font = '700 26px system-ui, sans-serif';
    ctx.fillText(`PayPulse · ${currentQr.accountNumber}`, size / 2, size + 40);
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillStyle = '#6b7086';
    ctx.fillText(currentQr.amount ? `QR Ph · ${money(currentQr.amount)}` : 'QR Ph · scan to send money', size / 2, size + 72);
    canvas.toBlob((blob) => {
      const link = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: `PayPulse-QR-${currentQr.accountNumber}.png`,
      });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    }, 'image/png');
  });

  // ---------- Scan QR (mock scanner: upload an image or paste the text) ----------

  const scanDialog = $('#scan-qr-dialog');
  const scanForm = $('#scan-qr-form');
  let scanned = null; // result of POST /api/qr/decode

  $('#scan-qr-btn').addEventListener('click', () => {
    scanForm.reset();
    setFormError(scanForm);
    scanned = null;
    $('#scan-result').hidden = true;
    $('#scan-send').hidden = true;
    scanDialog.showModal();
  });

  /** Load the QR image reader (jsQR) only when it is first needed. */
  let jsQrLoading = null;
  function loadJsQr() {
    jsQrLoading ??= new Promise((resolve, reject) => {
      const script = Object.assign(document.createElement('script'), { src: '/vendor/jsQR.js' });
      script.onload = () => resolve(window.jsQR);
      script.onerror = () => reject(new Error('Could not load the QR reader'));
      document.head.append(script);
    });
    return jsQrLoading;
  }

  $('#scan-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFormError(scanForm);
    try {
      const jsQR = await loadJsQr();
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
      const canvas = Object.assign(document.createElement('canvas'), {
        width: Math.round(bitmap.width * scale),
        height: Math.round(bitmap.height * scale),
      });
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(data, width, height);
      if (!code) return setFormError(scanForm, 'No QR code found in that image. Try a clearer picture.');
      scanForm.elements.payload.value = code.data;
      await decodeScanned();
    } catch (err) {
      setFormError(scanForm, err.message || 'Could not read that image.');
    } finally {
      event.target.value = '';
    }
  });

  async function decodeScanned() {
    setFormError(scanForm);
    $('#scan-result').hidden = true;
    $('#scan-send').hidden = true;
    try {
      scanned = await api('/api/qr/decode', { method: 'POST', body: { payload: scanForm.elements.payload.value } });
      fillRows($('#scan-result-rows'), [
        ['Recipient', scanned.receiverName],
        ['Account no.', scanned.accountNumber],
        ['Amount', scanned.amount ? money(scanned.amount) : 'Sender chooses'],
        ['QR type', scanned.format === 'QR_PH' ? 'QR Ph (checksum OK)' : 'Account number'],
      ]);
      $('#scan-result').hidden = false;
      if (scanned.isOwnAccount) {
        setFormError(scanForm, 'This is your own QR code. Ask the other person to show theirs.');
      } else {
        $('#scan-send').hidden = false;
      }
    } catch (err) {
      scanned = null;
      setFormError(scanForm, err.message);
    }
  }

  scanForm.addEventListener('submit', (event) => {
    event.preventDefault();
    decodeScanned();
  });

  // Continue in the normal Express Send flow with the recipient (and amount) filled in.
  $('#scan-send').addEventListener('click', () => {
    if (!scanned) return;
    scanDialog.close();
    openSendDialog();
    showSendStep('express');
    sendForm.elements.recipient.value = scanned.accountNumber;
    if (scanned.amount) sendForm.elements.amount.value = scanned.amount;
    (scanned.amount ? sendForm.elements.description : sendForm.elements.amount).focus();
  });

  // ---------- QA Sandbox Controls (dev mode only) ----------

  const qaPanel = $('#qa-panel');
  const qaFab = $('#qa-fab');

  async function initQaControls() {
    try {
      await refreshQaState();
      qaEnabled = true;
      qaFab.hidden = false;
    } catch {
      hideQaControls(); // 404: server is not in QA sandbox mode
    }
  }

  function hideQaControls() {
    qaEnabled = false;
    qaFab.hidden = true;
    qaPanel.hidden = true;
  }

  async function refreshQaState() {
    const state = await api('/api/qa/state');
    $('#qa-slow').checked = state.slowNetwork;
    $('#qa-fail').checked = state.failNextTransaction;
    $('#qa-freeze').checked = state.frozen;
    const chaos = $('#qa-chaos').value !== 'off';
    $('#qa-fault').checked = faultInjectionOn();
    $('#chaos-live').hidden = !(state.slowNetwork || faultInjectionOn());
    qaFab.classList.toggle('active', state.slowNetwork || state.failNextTransaction || state.frozen || chaos || faultInjectionOn());
    return state;
  }

  // Chaos Engine fault injection is a browser-side setting too (x-chaos-* headers on POSTs).
  $('#qa-fault').addEventListener('change', (event) => {
    try { localStorage.setItem(CHAOS_FAULT_KEY, event.target.checked ? 'on' : 'off'); } catch { /* not remembered */ }
    qaStatus(event.target.checked
      ? 'Chaos Engine: 20% of transfers and payments will fail with HTTP 500 (and be retried)'
      : 'Chaos Engine: fault injection off');
    refreshQaState().catch(() => {});
  });

  // Chaos mode is a browser-side setting: it adds x-chaos-* headers to every API call.
  try { $('#qa-chaos').value = localStorage.getItem(CHAOS_KEY) || 'off'; } catch { /* storage unavailable */ }
  $('#qa-chaos').addEventListener('change', (event) => {
    try { localStorage.setItem(CHAOS_KEY, event.target.value); } catch { /* not remembered */ }
    qaStatus(`Chaos mode: ${event.target.selectedOptions[0].textContent}`);
    refreshQaState().catch(() => {});
  });

  $('#qa-interest').addEventListener('click', async () => {
    try {
      const result = await api('/api/qa/savings/accrue', { method: 'POST', body: { days: 30 } });
      qaStatus(`30 days of interest: ${money(result.postedCents / 100)} credited to PayPulse Save`);
      await loadWallet();
    } catch (err) {
      qaStatus(err.message);
    }
  });

  function qaStatus(text) {
    $('#qa-status').textContent = text;
  }

  qaFab.addEventListener('click', () => {
    qaPanel.hidden = !qaPanel.hidden;
    qaFab.setAttribute('aria-expanded', String(!qaPanel.hidden));
    if (!qaPanel.hidden) refreshQaState().catch(() => {});
  });
  $('#qa-close').addEventListener('click', () => {
    qaPanel.hidden = true;
    qaFab.setAttribute('aria-expanded', 'false');
  });

  const QA_SWITCHES = [
    ['#qa-slow', 'slowNetwork', 'Slow network'],
    ['#qa-fail', 'failNextTransaction', 'Fail next transaction'],
    ['#qa-freeze', 'frozen', 'Freeze account'],
  ];
  for (const [selector, setting, label] of QA_SWITCHES) {
    $(selector).addEventListener('change', async (event) => {
      const on = event.target.checked;
      try {
        await api('/api/qa/settings', { method: 'PUT', body: { [setting]: on } });
        qaStatus(`${label}: ${on ? 'ON' : 'off'}`);
        refreshQaState().catch(() => {});
        await loadWallet();
      } catch (err) {
        event.target.checked = !on;
        qaStatus(err.message);
      }
    });
  }

  $('#qa-pesonet').addEventListener('click', async () => {
    try {
      const { batch } = await api('/api/qa/pesonet/run-cutoff', { method: 'POST' });
      qaStatus(batch ? `PESONet batch ${batch.batchId}: ${batch.itemCount} settled (${money(batch.total)})` : 'No PESONet transfers waiting');
      await loadWallet();
    } catch (err) {
      qaStatus(err.message);
    }
  });

  $('#qa-clear-aml').addEventListener('click', async () => {
    try {
      const status = await api('/api/qa/compliance/clear', { method: 'POST' });
      qaStatus(`Compliance status: ${status.amlStatus}`);
      await loadWallet();
    } catch (err) {
      qaStatus(err.message);
    }
  });

  $('#qa-reset').addEventListener('click', async () => {
    if (!window.confirm('Reset your account? Wallet becomes ₱100,000.00, PayPulse Save ₱0, an open loan is written off, recent activity is cleared, limits restart and all QA switches turn off.')) return;
    try {
      await api('/api/qa/reset', { method: 'POST' });
      qaStatus('DB state reset: ₱100,000.00, activity cleared');
      await Promise.all([loadWallet(), loadLoans()]);
      toast('Account reset to ₱100,000.00', 'success');
    } catch (err) {
      qaStatus(err.message);
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
    if (r.type === 'LOAD_PURCHASE' && r.load) {
      return [
        ['Network', r.load.brand],
        ['Mobile Number', r.load.mobileNumber],
        ['Product', r.load.product],
        ['Amount', money(r.amount)],
        ['Convenience Fee', `${money(0)} (free)`],
        ['Total Paid', money(r.total), true],
        ['Paid from', `${r.sender.name} · ${r.sender.account}`],
        ...(r.cashback ? [['Cashback Earned', money(r.cashback)]] : []),
      ];
    }
    if (r.type === 'BILL_PAYMENT' && r.biller) {
      return [
        ['Biller', r.biller.name],
        ['Account Number', r.biller.accountNumber],
        ['Account Name', r.biller.accountName],
        ['Amount Due', money(r.amount)],
        ['Convenience Fee', `${money(r.fee)} (free)`],
        ['Total Paid', money(r.total), true],
        ['Paid from', `${r.sender.name} · ${r.sender.account}`],
        ...(r.cashback ? [['Cashback Earned', money(r.cashback)]] : []),
      ];
    }
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
      ...(r.rail ? [['Transfer speed', RAIL_NAMES[r.rail] ?? r.rail]] : []),
      ...(r.settlement ? [['Settlement', settlementText(r.settlement)]] : []),
      ...(r.note ? [['Note', r.note]] : []),
      ...(r.bankReference ? [['Bank Reference', r.bankReference]] : []),
      ...(r.iso20022 ? [['ISO 20022 MsgId', r.iso20022.msgId]] : []),
    ];
  }

  function settlementText(s) {
    if (s.status === 'QUEUED') {
      return `Pending: PESONet batch at ${s.expectedAt ? CUTOFF_TIME.format(new Date(s.expectedAt)) : 'the next cut-off'}`;
    }
    return s.batchId ? `Settled (batch ${s.batchId})` : 'Settled';
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
      // ISO 20022 tab: transfers, bills and load (bank transfers once the switch has sent the message)
      const hasIso = ISO_TYPES.has(r.type) && (r.type !== 'BANK_TRANSFER' || Boolean(r.iso20022));
      $('#receipt-tabs').hidden = !hasIso;
      isoMessage = null;
      showReceiptTab('receipt');
      $('#receipt-cashback').hidden = !r.cashback;
      $('#receipt-cashback').textContent = r.cashback ? `🎁 Cashback Earned: ${money(r.cashback)}` : '';
      if (!receiptDialog.open) receiptDialog.showModal();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  $('#receipt-done').addEventListener('click', () => receiptDialog.close());

  // ---------- ISO 20022 Message Inspector (receipt tab) ----------

  const ISO_TYPES = new Set(['TRANSFER', 'BILL_PAYMENT', 'LOAD_PURCHASE', 'BANK_TRANSFER']);
  let isoMessage = null; // the loaded message of the receipt on screen

  function showReceiptTab(which) {
    const iso = which === 'iso';
    for (const [tab, selected] of [[$('#receipt-tab-receipt'), !iso], [$('#receipt-tab-iso'), iso]]) {
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    $('#receipt-body').hidden = iso;
    $('#iso-inspector').hidden = !iso;
    if (iso && !isoMessage) loadIsoMessage();
  }

  async function loadIsoMessage() {
    const transactionId = currentReceipt?.transactionId;
    $('#iso-error').textContent = '';
    $('#iso-xml').replaceChildren('Loading pacs.008 message…');
    $('#iso-ids').replaceChildren();
    try {
      const m = await api(`/api/v1/transactions/${transactionId}/iso20022`);
      if (currentReceipt?.transactionId !== transactionId) return; // another receipt was opened meanwhile
      isoMessage = m;
      $('#iso-meta').textContent = `${m.messageType} · ${m.source === 'PAYMENT_SWITCH' ? 'sent by the payment switch' : 'built from the ledger'}`;
      $('#iso-ids').replaceChildren(
        ...[['MsgId', m.msgId], ['EndToEndId', m.endToEndId], ['UETR', m.uetr], ['Settlement', `${m.rail} · ${m.status}`]]
          .flatMap(([label, value]) => [
            Object.assign(document.createElement('dt'), { textContent: label }),
            Object.assign(document.createElement('dd'), { textContent: value ?? '—' }),
          ]),
      );
      $('#iso-xml').replaceChildren(...highlightXml(m.xml));
    } catch (err) {
      $('#iso-xml').replaceChildren();
      $('#iso-error').textContent = err.message || 'Could not load the ISO 20022 message.';
    }
  }

  /** XML -> syntax-highlighted nodes (text nodes only, never innerHTML, so payload text can't inject markup). */
  function highlightXml(xml) {
    const span = (cls, text) => Object.assign(document.createElement('span'), { className: `x-${cls}`, textContent: text });
    const nodes = [];
    const token = /(<\?[^?]*\?>)|(<\/?)([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)(\s*\/?>)|([^<]+)/g;
    for (const [, decl, open, name, attrs, close, text] of xml.matchAll(token)) {
      if (decl) nodes.push(span('decl', decl));
      else if (name) {
        nodes.push(span('punct', open), span('tag', name));
        for (const [, space, attr, value] of attrs.matchAll(/(\s+)([\w:.-]+)=("[^"]*")/g)) {
          nodes.push(space, span('attr', attr), span('punct', '='), span('value', value));
        }
        nodes.push(span('punct', close));
      } else if (text) nodes.push(text.trim() ? span('text', text) : text);
    }
    return nodes;
  }

  $('#receipt-tab-receipt').addEventListener('click', () => showReceiptTab('receipt'));
  $('#receipt-tab-iso').addEventListener('click', () => showReceiptTab('iso'));
  $('#receipt-tabs').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const next = $('#receipt-tab-iso').getAttribute('aria-selected') === 'true' ? 'receipt' : 'iso';
    showReceiptTab(next);
    $(next === 'iso' ? '#receipt-tab-iso' : '#receipt-tab-receipt').focus();
  });
  $('#iso-done').addEventListener('click', () => receiptDialog.close());

  $('#iso-copy').addEventListener('click', async () => {
    if (!isoMessage) return;
    try {
      await navigator.clipboard.writeText(isoMessage.xml);
      toast('pacs.008 payload copied to the clipboard', 'success');
    } catch {
      toast('Could not copy. Select the XML and copy it manually.', 'error');
    }
  });

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

    // Light violet header (theme)
    const gradient = ctx.createLinearGradient(0, 0, W, headH);
    // The PNG is always drawn in the LIGHT palette (a receipt is printed / shared, not themed dark).
    const light = (name, fallback) => (document.documentElement.dataset.theme === 'dark' ? fallback : cssToken(name, fallback));
    const ink = light('--accent-ink', '#0040cc');
    gradient.addColorStop(0, light('--accent-tint', '#d6e4ff'));
    gradient.addColorStop(0.5, light('--accent-soft', '#ebf2ff'));
    gradient.addColorStop(1, light('--accent-softer', '#f4f7ff'));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, headH);

    // Check icon
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(W / 2, 46, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0e9f6e';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(W / 2 - 10, 47);
    ctx.lineTo(W / 2 - 3, 54);
    ctx.lineTo(W / 2 + 11, 39);
    ctx.stroke();

    ctx.fillStyle = ink;
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
      ctx.fillStyle = isTotal || label === 'Reference No.' ? ink : '#0f172a';
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
    ctx.fillStyle = light('--accent-ink', '#0040cc');
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
