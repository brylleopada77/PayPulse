const { forbidden } = require('../utils/errors');

/** After requireAuth: only ADMIN accounts may continue (403 ADMIN_ONLY otherwise). */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') {
    throw forbidden('ADMIN_ONLY', 'This feature is only available to PayPulse admins');
  }
  next();
}

module.exports = { requireAdmin };
