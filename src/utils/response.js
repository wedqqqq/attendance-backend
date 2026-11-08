'use strict';

function success(res, data, statusCode = 200, meta = {}) {
  return res.status(statusCode).json({
    success: true,
    data,
    ...meta,
  });
}

function created(res, data, meta = {}) {
  return success(res, data, 201, meta);
}

function error(res, message, statusCode = 400, errors = null) {
  const body = { success: false, message };
  if (errors) body.errors = errors;
  return res.status(statusCode).json(body);
}

function unauthorized(res, message = 'Unauthorized') {
  return error(res, message, 401);
}

function forbidden(res, message = 'Forbidden') {
  return error(res, message, 403);
}

function notFound(res, message = 'Not found') {
  return error(res, message, 404);
}

function conflict(res, message) {
  return error(res, message, 409);
}

function serverError(res, message = 'Internal server error') {
  return error(res, message, 500);
}

function paginated(res, rows, total, page, limit) {
  return success(res, rows, 200, {
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
}

module.exports = {
  success, created, error, unauthorized, forbidden,
  notFound, conflict, serverError, paginated,
};
