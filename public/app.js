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
    const { fullName, email, password } = formData(form);
    setFormError(form);
    try {
      const { mpin, mpinExpiresInSeconds } = await api('/api/auth/register', {
        method: 'POST',
        body: { fullName, email, password },
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

  // The transfer being confirmed: { toAccountNumber, amount, description, mpin, challengeId }
  let pending = null;
  let otpTimer = null;

  const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

  sendForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const { toAccountNumber, amount, description } = formData(sendForm);
    setFormError(sendForm);

    if (!toAccountNumber.trim()) return setFormError(sendForm, 'Enter the recipient account number.');
    if (!AMOUNT_PATTERN.test(amount.trim()) || Number(amount) <= 0) {
      return setFormError(sendForm, 'Enter a valid amount, e.g. 250 or 99.50.');
    }

    pending = {
      toAccountNumber: toAccountNumber.trim(),
      amount: amount.trim(),
      description: description.trim() || undefined,
    };
    sendDialog.close();
    // No MPIN yet, or it expired: get one first, then continue to the PIN pad (see #mpin-saved).
    if (!hasMpin) return openMpinReset('setup');
    if (mpinSecondsLeft() === 0) return openMpinReset('expired');
    openMpinPad();
  });

  function openMpinPad() {
    $('#mpin-summary').replaceChildren(
      'You are sending ',
      Object.assign(document.createElement('strong'), { textContent: money(pending.amount) }),
      ' to ',
      Object.assign(document.createElement('strong'), { textContent: pending.toAccountNumber }),
    );
    setFormError(mpinForm);
    mpinDialog.showModal();
    mpinInput.clear();
    updateMpinTimers();
  }

  function transferBody(extra = {}) {
    const { toAccountNumber, amount, description, mpin } = pending;
    return { toAccountNumber, amount, description, mpin, ...extra };
  }

  async function completeTransfer(result) {
    stopOtpTimer();
    mpinDialog.close();
    otpDialog.close();
    hidePopover($('#sms'));
    pending = null;
    toast(`Sent ${money(result.amount)} to ${result.to}`, 'success');
    await loadWallet();
  }

  /** Errors about the transfer itself (receiver, funds, amount) belong on the Send form. */
  function backToSendForm(message) {
    stopOtpTimer();
    mpinDialog.close();
    otpDialog.close();
    sendDialog.showModal();
    setFormError(sendForm, message);
  }

  mpinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pending) return;
    const mpin = mpinInput.value();
    setFormError(mpinForm);
    if (!/^\d{6}$/.test(mpin)) return setFormError(mpinForm, 'Enter all 6 digits of your MPIN.');

    // The Confirm button is intentionally left enabled while this request runs (QA exercise).
    try {
      const result = await api('/api/transfers', { method: 'POST', body: transferBody({ mpin }) });
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
      const result = await api('/api/transfers', {
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
      const result = await api('/api/transfers', { method: 'POST', body: transferBody() });
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
    setMpinExpiry(expiresInSeconds);
    revealDialog.showModal();
    updateMpinTimers();
  }

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
      title: 'Forgot MPIN',
      text: "Enter your account password and we'll give you a new random MPIN.",
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

  // ---------- Start ----------

  if (getToken()) {
    showWallet().catch(() => logout());
  } else {
    showAuth();
  }
})();
