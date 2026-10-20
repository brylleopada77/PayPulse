const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const notificationService = require('../../services/notificationService');

const router = express.Router();

router.use(requireAuth);

// GET /api/v1/notifications -> { unreadCount, unreadByCategory, items: [{ id, category, title, body, date, read, action }] }
router.get('/', async (req, res) => {
  res.json(await notificationService.list(req.user.id));
});

// POST /api/v1/notifications/read  { ids: ["ann-...", "tx-123"] } or { all: true } -> new unread counts
router.post('/read', async (req, res) => {
  res.json(await notificationService.markRead(req.user.id, req.body || {}));
});

module.exports = router;
