'use strict';
class SchedulerError extends Error {
  constructor(message, status) { super(message); this.name = this.constructor.name; this.status = status; }
}
class ValidationError extends SchedulerError { constructor(m) { super(m, 400); } }
class DuplicateError extends SchedulerError { constructor(m) { super(m, 409); } }
class QueueFullError extends SchedulerError { constructor(m) { super(m, 503); } }
// Throw this from a task ONLY when nothing was committed yet, so running it again is safe.
class RetryableError extends Error { constructor(m, cause) { super(m); this.name = 'RetryableError'; this.cause = cause; } }
module.exports = { SchedulerError, ValidationError, DuplicateError, QueueFullError, RetryableError };
