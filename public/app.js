// PayPulse web wallet: plain JavaScript talking to the PayPulse REST API.
(() => {
  const TOKEN_KEY = 'paypulse.token';
  const REFRESH_MS = 10_000;

  const $ = (selector) => document.querySelector(selector);
  const authView = $('#auth-view');
  const appView = $('#app-view');
  let currency = 'PHP';
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
      logout('Your session has expired. Please log in again.');
    }
    if (!res.ok) {
      throw new Error(data.error?.message || `Request failed (${res.status})`);
    }
    return data;
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

  function describe(tx) {
    if (tx.type === 'DEPOSIT') return { title: 'Added money', icon: '+' };
    if (tx.direction === 'DEBIT') return { title: 'Money sent', icon: '↗' };
    return { title: 'Money received', icon: '↙' };
  }

  // ---------- UI helpers ----------

  let toastTimer = null;
  function toast(message, kind = '') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function setFormError(form, message = '') {
    form.querySelector('.form-error').textContent = message;
  }

  function formData(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

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
  }

  async function loadWallet() {
    const [account, history] = await Promise.all([
      api('/api/accounts/me'),
      api('/api/accounts/me/transactions'),
    ]);
    currency = account.currency;
    $('#user-name').textContent = account.accountHolder;
    $('#balance').textContent = money(account.balance);
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

      const iconEl = document.createElement('span');
      iconEl.className = 'tx-icon';
      iconEl.textContent = icon;

      const info = document.createElement('div');
      const titleEl = document.createElement('div');
      titleEl.className = 'tx-title';
      titleEl.textContent = title;
      const meta = document.createElement('div');
      meta.className = 'tx-date';
      meta.textContent = `${tx.description} · ${formatDate(tx.createdAt)}`;
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
    const { fullName, email, password } = formData(form);
    setFormError(form);
    try {
      await api('/api/auth/register', { method: 'POST', body: { fullName, email, password } });
      await login(email, password);
      form.reset();
      toast('Welcome to PayPulse! Your wallet is ready.', 'success');
    } catch (err) {
      setFormError(form, err.message);
    }
  });

  $('#logout-btn').addEventListener('click', () => logout());

  // ---------- Wallet actions ----------

  document.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
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

  $('#copy-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#account-number').textContent);
      toast('Account number copied');
    } catch {
      toast('Could not copy. Select the number and copy it manually.', 'error');
    }
  });

  document.querySelectorAll('[data-amount]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#topup-form').elements.amount.value = chip.dataset.amount;
    });
  });

  $('#send-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { toAccountNumber, amount, description } = formData(form);
    setFormError(form);
    // The submit button stays enabled on purpose (QA exercise): double-clicks send duplicates.
    try {
      const result = await api('/api/transfers', {
        method: 'POST',
        body: { toAccountNumber: toAccountNumber.trim(), amount: amount.trim(), description: description.trim() || undefined },
      });
      form.closest('dialog').close();
      toast(`Sent ${money(result.amount)} to ${result.to}`, 'success');
      await loadWallet();
    } catch (err) {
      setFormError(form, err.message);
    }
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

  // ---------- Start ----------

  if (getToken()) {
    showWallet().catch(() => logout());
  } else {
    showAuth();
  }
})();
