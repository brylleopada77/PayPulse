const { AppError } = require('../utils/errors');

// Every error response has the same shape, so tests can always assert on it:
//   { "error": { "code": "STABLE_CODE", "message": "Human readable", "details": { ... } } }
// `details` is only present when there is extra data (limits, remaining amounts, retry times).

function sendError(res, status, code, message, details) {
  return res.status(status).json({ error: { code, message, ...(details !== undefined && { details }) } });
}

function notFoundHandler(req, res) {
  sendError(res, 404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    if (err.headers) res.set(err.headers);
    return sendError(res, err.status, err.code, err.message, err.details);
  }

  // Problems with the request body, detected by express.json()
  if (err.type === 'entity.parse.failed') {
    return sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (err.type === 'entity.too.large') {
    return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  console.error(err);
  return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
}

module.exports = { notFoundHandler, errorHandler };
