/**
 * An error that is safe to show to API clients.
 * `code` is a stable, machine-readable value that tests can assert on.
 */
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (code, message) => new AppError(400, code, message);
const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);
const notFound = (code, message) => new AppError(404, code, message);
const conflict = (code, message) => new AppError(409, code, message);
const unprocessable = (code, message) => new AppError(422, code, message);

module.exports = { AppError, badRequest, unauthorized, notFound, conflict, unprocessable };
