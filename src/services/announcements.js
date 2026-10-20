// What PayPulse tells every customer in the Notifications panel: new updates, feature tips and
// upcoming events. Edit this list to publish something; `id` must stay unique and never change
// (read/unread state is stored by id). An item shows once `publishedAt` has passed.
//
// category: UPDATE (what's new) | FEATURE (tips) | EVENT (upcoming, with eventDate)
// action:   optional button in the app: { label, target } where target is one of
//           bills | loan | profile | kyc | savings | card | security

const ANNOUNCEMENTS = [
  {
    id: 'ann-2026-10-pay-bills',
    category: 'UPDATE',
    title: 'Pay Bills is here',
    body: 'Pay Meralco, PLDT, SSS, Pag-IBIG and 19 more billers right in PayPulse. Get ₱5.00 cashback on bills of ₱100 or more, up to 3 a day.',
    publishedAt: '2026-10-16T02:00:00Z',
    action: { label: 'Pay a bill', target: 'bills' },
  },
  {
    id: 'ann-2026-10-kyc-levels',
    category: 'UPDATE',
    title: 'Verify your ID, send up to ₱100,000 a day',
    body: 'Become Level 2 (Fully Verified) in My Profile: choose a government ID, enter its number and take a selfie. Your daily limit doubles from ₱50,000 to ₱100,000.',
    publishedAt: '2026-10-16T01:00:00Z',
    action: { label: 'Verify my ID', target: 'kyc' },
  },
  {
    id: 'ann-2026-10-instant-loan',
    category: 'UPDATE',
    title: 'Instant Loan: up to ₱50,000',
    body: 'Borrow ₱1,000 to ₱50,000 over 3, 6 or 12 months at 1.5% a month. The money arrives in your wallet right away.',
    publishedAt: '2026-10-15T09:00:00Z',
    action: { label: 'See my offer', target: 'loan' },
  },
  {
    id: 'ann-2026-10-new-look',
    category: 'UPDATE',
    title: 'A fresh new look',
    body: 'PayPulse has a cleaner home screen: your balance, savings and total assets at a glance, quick actions and a new navigation bar.',
    publishedAt: '2026-10-15T08:00:00Z',
  },
  {
    id: 'tip-save-6-percent',
    category: 'FEATURE',
    title: 'Earn 6.00% a year with PayPulse Save',
    body: 'Move money to PayPulse Save and earn interest every day. Withdraw to your wallet any time, no fees.',
    publishedAt: '2026-10-14T08:00:00Z',
    action: { label: 'Open PayPulse Save', target: 'savings' },
  },
  {
    id: 'tip-lock-card',
    category: 'FEATURE',
    title: 'Lost your phone? Lock your card in one tap',
    body: 'Use the Freeze / Lock Card switch in the Card tab to decline every payment until you unlock it.',
    publishedAt: '2026-10-14T07:00:00Z',
    action: { label: 'Go to my card', target: 'card' },
  },
  {
    id: 'tip-sms-2fa',
    category: 'FEATURE',
    title: 'Extra protection: SMS 2FA on every transfer',
    body: 'Turn on SMS 2FA in Security & Biometrics to need a one-time code for every Send and Bank Transfer, not just those above ₱1,000.',
    publishedAt: '2026-10-14T06:00:00Z',
    action: { label: 'Security settings', target: 'security' },
  },
  {
    id: 'evt-2026-10-maintenance',
    category: 'EVENT',
    title: 'Scheduled maintenance',
    body: 'PayPulse will be briefly unavailable while we upgrade our systems. Plan your transfers and bill payments before or after this window.',
    publishedAt: '2026-10-15T00:00:00Z',
    eventDate: '2026-10-25T17:00:00Z',
    eventEnd: '2026-10-25T19:00:00Z',
  },
  {
    id: 'evt-2026-11-qr-merchants',
    category: 'EVENT',
    title: 'Coming soon: pay stores with QR Ph',
    body: 'Scan & Pay will work at stores that show a QR Ph code. Watch this space for the launch date.',
    publishedAt: '2026-10-15T00:00:00Z',
    eventDate: '2026-11-15T00:00:00Z',
  },
  {
    id: 'evt-2026-11-bug-bash',
    category: 'EVENT',
    title: 'PayPulse QA Bug Bash',
    body: 'Help us test PayPulse! Try transfers, bills, loans and the QA sandbox, and report what you find through Help Center > Submit a ticket.',
    publishedAt: '2026-10-15T00:00:00Z',
    eventDate: '2026-11-07T01:00:00Z',
    eventEnd: '2026-11-07T09:00:00Z',
    action: { label: 'Submit a ticket', target: 'help' },
  },
];

module.exports = { ANNOUNCEMENTS };
