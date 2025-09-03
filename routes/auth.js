// routes/auth.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendSms } = require('../utils/sms');   // à adapter à ton util
const crypto = require('crypto');

// Helpers simples (tu peux aussi réutiliser ceux de utils/otp.js si déjà faits)
const OTP_LEN = parseInt(process.env.OTP_LENGTH || '6', 10);
const OTP_TTL_MIN = parseInt(process.env.OTP_TTL_MIN || '5', 10);

const isE164 = (p) => /^\+[1-9]\d{6,14}$/.test(p);
const genCode = (n=OTP_LEN) => Array.from({length:n},()=>Math.floor(Math.random()*10)).join('');
const hash = (code) => crypto.createHmac('sha256', process.env.OTP_SECRET || 'change-me').update(code).digest('hex');

// POST /api/auth/otp/request
router.post('/otp/request', async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    if (!isE164(phone)) return res.status(400).json({ error: 'PHONE_INVALID' });

    const code = genCode();
    const codeHash = hash(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);

    await db.query(
      `INSERT INTO otp_codes (phone, code_hash, expires_at, used)
       VALUES ($1, $2, $3, FALSE)`,
      [phone, codeHash, expiresAt]
    );

    // Envoi SMS (Twilio ou stub)
    try {
      await sendSms(phone, `Votre code Kiese: ${code} (expire dans ${OTP_TTL_MIN} min)`);
    } catch (e) {
      console.error('sendSms failed:', e);
      // on continue quand même côté dev/staging
    }

    return res.json({ ok: true, ttl_min: OTP_TTL_MIN });
  } catch (e) {
    console.error('otp/request error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /api/auth/otp/verify
router.post('/otp/verify', async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const code  = String(req.body?.code  || '').trim();

    if (!isE164(phone) || !/^\d{4,8}$/.test(code)) {
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }

    const codeHash = hash(code);

    // On prend le dernier OTP non utilisé
    const r = await db.query(`
      SELECT id, expires_at, used
      FROM otp_codes
      WHERE phone=$1 AND code_hash=$2
      ORDER BY id DESC
      LIMIT 1
    `, [phone, codeHash]);

    const row = r.rows[0];
    if (!row) return res.status(400).json({ ok:false, error:'CODE_NOT_FOUND' });
    if (row.used) return res.status(400).json({ ok:false, error:'CODE_ALREADY_USED' });
    if (new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ ok:false, error:'CODE_EXPIRED' });
    }

    // Marquer utilisé
    await db.query(`UPDATE otp_codes SET used=TRUE, used_at=NOW() WHERE id=$1`, [row.id]);

    return res.json({ ok:true });
  } catch (e) {
    console.error('otp/verify error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

module.exports = router;
