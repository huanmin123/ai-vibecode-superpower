'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const express = require('express');
const config = require('../config');

const router = express.Router();

const PREVIEW_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.pdf', 'application/pdf'],
]);

router.get('/', (req, res, next) => {
  const file = String(req.query.name || '');
  if (!file) {
    return res.status(400).json({ error: 'name is required' });
  }

  const filePath = path.join(config.UPLOAD_DIR, file);
  fs.access(filePath, fs.constants.R_OK, (err) => {
    if (err) {
      return res.status(404).json({ error: 'file not found' });
    }
    return res.sendFile(filePath);
  });
});

router.get('/preview', (req, res, next) => {
  const requested = String(req.query.name || '');
  const safeName = path.basename(requested);
  const extension = path.extname(safeName).toLowerCase();
  if (!PREVIEW_TYPES.has(extension)) {
    return res.status(415).json({ error: 'unsupported preview type' });
  }

  const previewPath = path.join(config.PREVIEW_DIR, safeName);
  fs.readFile(previewPath, (err, data) => {
    if (err) {
      return res.status(404).json({ error: 'preview not found' });
    }
    res.type(PREVIEW_TYPES.get(extension));
    return res.send(data);
  });
});

router.get('/metadata', (req, res) => {
  const name = String(req.query.name || '');
  const candidate = path.basename(name);
  if (!candidate) {
    return res.status(400).json({ error: 'name is required' });
  }

  const previewPath = path.join(config.PREVIEW_DIR, candidate);
  execFile('file', ['-b', previewPath], { timeout: 5000 }, (err, stdout) => {
    if (err) {
      return res.status(404).json({ error: 'metadata unavailable' });
    }
    return res.json({ name: candidate, description: stdout.trim() });
  });
});

module.exports = router;
