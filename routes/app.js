// routes/app.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/app/recharge_numbers
router.get('/recharge_numbers', async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT key, value FROM app_settings 
       WHERE key IN ('recharge_mpesa','recharge_airtel','recharge_orange')`
    );
    const map = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    res.json({
      mpesa:  map.recharge_mpesa  || null,
      airtel: map.recharge_airtel || null,
      orange: map.recharge_orange || null,
    });
  } catch (e) {
    console.error('recharge_numbers error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// (Optionnel) POST /api/app/recharge_numbers  (pour ton panneau admin)
router.post('/recharge_numbers', async (req, res) => {
  const { mpesa, airtel, orange } = req.body || {};
  try {
    const up = async (k, v) => {
      if (typeof v === 'string' && v.trim()) {
        await db.query(
          `INSERT INTO app_settings(key,value) VALUES($1,$2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [k, v.trim()]
        );
      }
    };
    await up('Mpesa', mpesa);
    await up('Airtel Money', airtel);
    await up('Orange Money', orange);
    res.json({ ok: true });
  } catch (e) {
    console.error('update recharge_numbers error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;

