'use strict';

const path = require('path');

const dataRoot = path.resolve(__dirname, '..', 'var');

const JWT_SECRET = process.env.JWT_SECRET || 'notes-dev-secret';

module.exports = {
  PORT: Number.parseInt(process.env.PORT || '3000', 10),
  JWT_SECRET,
  DATABASE_FILE: process.env.DATABASE_FILE || path.join(dataRoot, 'notes.db'),
  UPLOAD_DIR: path.join(dataRoot, 'uploads'),
  PREVIEW_DIR: path.join(dataRoot, 'previews'),
  EXPORT_DIR: path.join(dataRoot, 'exports'),
  MAX_JSON_BYTES: 1024 * 1024,
};
