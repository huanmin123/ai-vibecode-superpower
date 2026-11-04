'use strict';

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const db = require('../db');

function extractToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) {
    return null;
  }
  return value;
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.getUserById(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'account no longer active' });
    }
    req.user = user;
    return next();
  } catch (err) {
    console.warn('rejected bearer token', err.message);
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'administrator role required' });
  }
  return next();
}

module.exports = { requireAuth, requireAdmin };
