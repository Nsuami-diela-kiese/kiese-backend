const express = require('express');
const router = express.Router();
const db = require('../db');
const { isE164 } = require('../utils/otp');

// POST /api/client/register  { phone:"+243...", name:"John", fcm_token?: "..." }
router.post('/register', async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const name = String(req.body?.name || '').trim();
    const fcmToken = req.body?.fcm_token ? String(req.body.fcm_token) : null;

    if (!isE164(phone)) return res.status(400).json({ error: 'INVALID_PHONE_E164' });
    if (!name || name.length < 2) return res.status(400).json({ error: 'INVALID_NAME' });

    const r = await db.query(`
      INSERT INTO clients(phone, name, fcm_token)
      VALUES ($1, $2, $3)
      ON CONFLICT (phone) DO UPDATE
        SET name = EXCLUDED.name,
            fcm_token = COALESCE(EXCLUDED.fcm_token, clients.fcm_token),
            updated_at = NOW()
      RETURNING phone, name, fcm_token, verified
    `, [phone, name, fcmToken]);

    return res.json({ ok: true, client: r.rows[0] });
  } catch (e) {
    console.error('client/register error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /api/client/fcm  { phone:"+243...", fcm_token:"..." }
router.post('/fcm', async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const token = String(req.body?.fcm_token || '').trim();
    if (!isE164(phone)) return res.status(400).json({ error: 'INVALID_PHONE_E164' });
    if (!token) return res.status(400).json({ error: 'INVALID_TOKEN' });

    const { rowCount } = await db.query(`UPDATE clients SET fcm_token = $2 WHERE phone = $1`, [phone, token]);
    if (rowCount === 0) return res.status(404).json({ error: 'CLIENT_NOT_FOUND' });

    return res.json({ ok: true });
  } catch (e) {
    console.error('client/fcm error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// GET /api/client/:phone
router.get('/:phone', async (req, res) => {
  try {
    const phone = `+${req.params.phone.replace(/^\+/, '')}`;
    if (!isE164(phone)) return res.status(400).json({ error: 'INVALID_PHONE_E164' });

    const { rows } = await db.query(
      `SELECT phone, name, fcm_token, verified, created_at, updated_at FROM clients WHERE phone = $1`,
      [phone]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'CLIENT_NOT_FOUND' });

    return res.json({ ok: true, client: rows[0] });
  } catch (e) {
    console.error('client/get error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

module.exports = router;
