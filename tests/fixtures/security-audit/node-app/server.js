'use strict';

const express = require('express');
const config = require('./config');
const db = require('./db');
const { requireAuth } = require('./middleware/auth');
const notesRouter = require('./routes/notes');
const filesRouter = require('./routes/files');
const exportRouter = require('./routes/export');
const integrationsRouter = require('./routes/integrations');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: config.MAX_JSON_BYTES }));

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${elapsedMs.toFixed(1)}ms`);
  });
  next();
});

// Author card shown next to shared note links.
app.get('/api/profile/:id', (req, res, next) => {
  try {
    const user = db.getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'profile not found' });
    }
    return res.json({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      createdAt: user.created_at,
    });
  } catch (err) {
    console.error('failed to load profile', err);
    return next(err);
  }
});

app.get('/api/admin/audit-log', requireAuth, (req, res, next) => {
  try {
    const entries = db.listAuditEntries(200);
    return res.json({ entries });
  } catch (err) {
    console.error('failed to read audit log', err);
    return next(err);
  }
});

app.use('/api', requireAuth);

app.use('/api/notes', notesRouter);
app.use('/api/files', filesRouter);
app.use('/api/export', exportRouter);
app.use('/api/integrations', integrationsRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

app.use((err, req, res, next) => {
  console.error('request failed', err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({ error: 'internal server error' });
});

app.listen(config.PORT, () => {
  console.log(`notes-hub listening on port ${config.PORT}`);
});

module.exports = app;
