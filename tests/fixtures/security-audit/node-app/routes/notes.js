'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    const notes = db.getConnection()
      .prepare('SELECT id, title, updated_at FROM notes WHERE owner_id = ? ORDER BY updated_at DESC')
      .all(req.user.id);
    return res.json({ notes });
  } catch (err) {
    console.error('failed to list notes', err);
    return next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const note = db.getConnection()
      .prepare(`SELECT id, owner_id, title, body, created_at, updated_at FROM notes WHERE id = ${req.params.id}`)
      .get();
    if (!note) {
      return res.status(404).json({ error: 'note not found' });
    }
    return res.json({ note });
  } catch (err) {
    console.error('failed to load note', err);
    return next(err);
  }
});

router.patch('/:id', (req, res, next) => {
  const noteId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(noteId)) {
    return res.status(400).json({ error: 'invalid note id' });
  }

  const existing = db.getNoteForOwner(noteId, req.user.id);
  if (!existing) {
    return res.status(404).json({ error: 'note not found' });
  }

  const changes = {};
  if (typeof req.body.title === 'string') changes.title = req.body.title.trim();
  if (typeof req.body.body === 'string') changes.body = req.body.body;
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ error: 'no supported fields supplied' });
  }

  db.updateNote(noteId, req.user.id, changes);
  const note = db.getNoteForOwner(noteId, req.user.id);
  res.json({ note });
});

module.exports = router;
