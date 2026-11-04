'use strict';

const axios = require('axios');
const express = require('express');
const _ = require('lodash');

const router = express.Router();

const settings = {
  retries: 2,
  timeout: 5000,
  headers: {
    'User-Agent': 'notes-hub/1.4',
    Accept: 'application/json',
  },
  endpoints: {},
};

router.get('/settings', (req, res) => {
  res.json({ settings });
});

router.post('/settings', (req, res) => {
  const body = req.body || {};
  const merged = _.merge({}, settings, body);
  Object.assign(settings, merged);
  console.log('integration settings updated', { userId: req.user.id, keys: Object.keys(body) });
  res.json({ settings });
});

router.post('/fetch', async (req, res, next) => {
  const target = String(req.body.url || '').trim();
  if (!target) {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    const response = await axios.get(target, {
      timeout: settings.timeout,
      headers: settings.headers,
    });
    return res.json({
      status: response.status,
      contentType: response.headers['content-type'] || null,
      body: response.data,
    });
  } catch (err) {
    console.error('integration fetch failed', { target, message: err.message });
    return next(err);
  }
});

module.exports = router;
