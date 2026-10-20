// Helpers for showing other people's details without exposing them in full.

/** "Maria Santos" -> "Maria S." (enough to confirm the person, without the full name). */
function shortName(fullName) {
  const [first, ...rest] = fullName.trim().split(/\s+/);
  const last = rest.pop();
  return last ? `${first} ${last[0]}.` : first;
}

/** "001234567890" -> "••••7890" */
function maskAccount(account) {
  return `••••${account.slice(-4)}`;
}

module.exports = { shortName, maskAccount };
