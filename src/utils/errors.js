/**
 * An error that is safe to show to API clients, sent as
 *   { "error": { "code": "...", "message": "...", "details": { ... } } }
 * `code` is a stable, machine-readable value that tests can assert on.
 * Optional: `details` (extra numbers for clients/tests) and `headers` (e.g. Retry-After).
 */
class AppError extends Error {
  constructor(status, code, message, { details, headers } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }

  /** Add machine-readable details to the JSON error. Returns the error for chaining. */
  withDetails(details) {
    this.details = details;
    return this;
  }

  /** Add response headers (e.g. Retry-After). Returns the error for chaining. */
  withHeaders(headers) {
    this.headers = headers;
    return this;
  }
}

const badRequest = (code, message) => new AppError(400, code, message);
const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);
const forbidden = (code, message) => new AppError(403, code, message);
const notFound = (code, message) => new AppError(404, code, message);
const conflict = (code, message) => new AppError(409, code, message);
const gone = (code, message) => new AppError(410, code, message);
const unprocessable = (code, message) => new AppError(422, code, message);
const locked = (code, message) => new AppError(423, code, message);
const tooManyRequests = (code, message) => new AppError(429, code, message);

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  gone,
  unprocessable,
  locked,
  tooManyRequests,
};
