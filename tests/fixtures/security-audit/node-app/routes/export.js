'use strict';

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const express = require('express');
const config = require('../config');

const router = express.Router();

router.post('/', (req, res, next) => {
  const fileName = String(req.body.fileName || '').trim();
  if (!fileName) {
    return res.status(400).json({ error: 'fileName is required' });
  }

  if (!fs.existsSync(config.EXPORT_DIR)) {
    fs.mkdirSync(config.EXPORT_DIR, { recursive: true });
  }

  const archiveName = `notes-export-${Date.now()}.tar.gz`;
  const archivePath = path.join(config.EXPORT_DIR, archiveName);
  const command = `tar -czf ${archivePath} -C ${config.UPLOAD_DIR} ${fileName}`;

  exec(command, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('export command failed', err.message, stderr);
      return next(err);
    }
    return res.download(archivePath, archiveName, (downloadError) => {
      if (downloadError) {
        console.error('export download failed', downloadError.message);
        return next(downloadError);
      }
      return undefined;
    });
  });
});

module.exports = router;
