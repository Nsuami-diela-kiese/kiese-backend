// routes/auth.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendSms } = require('../utils/sms'); // Twilio wrapper éventuel
// Si tu n'as pas de SMS pour l’instant, logguer le code suffira.

function randomCode(n = 6) {
  const s = Math.pow(10, n-1);
  return String(Math.floor(s + Math.random() * (9*s)));
}

// POST /api/auth/otp/request
// body: { phone: "+2438xxxxxxx", purpose?: "login" }
router.post('/otp/request', async (req, res) => {
  try {
    const phone   = String(req.body?.phone || '').trim();
    const purpose = String(req.body?.purpose || 'login');

    if (!phone.startsWith('+') || phone.length < 8) {
      return res.status(400).json({ ok:false, error: 'PHONE_INVALID' });
    }

    const code = randomCode(6);

    // Invalider les anciens codes non utilisés
    await db.query(
      `UPDATE otp_codes
         SET used = TRUE, used_at = now()
       WHERE phone = $1 AND used = FALSE`,
      [phone]
    );

    // Insérer un nouveau code valable 5 minutes
    await db.query(
      `INSERT INTO otp_codes (phone, code, purpose, expires_at, used)
       VALUES ($1, $2, $3, now() + interval '5 minutes', FALSE)`,
      [phone, code, purpose]
    );

    // Envoi SMS (ou log)
    try {
      if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_PHONE) {
        await sendSms(phone, `Votre code Kiese: ${code} (5 minutes)`);
      } else {
        console.log('[DEV][OTP] code pour', phone, '=>', code);
      }
    } catch (e) {
      console.error('sendSms error:', e);
      // on continue malgré tout
    }

    return res.json({ ok:true });
  } catch (e) {
    console.error('otp/request error:', e);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

// POST /api/auth/otp/verify
// body: { phone: "+2438...", code: "123456" }
router.post('/otp/verify', async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const code  = String(req.body?.code  || '').trim();

    if (!phone || !code) {
      return res.status(400).json({ ok:false, error:'MISSING_FIELDS' });
    }

    const r = await db.query(
      `SELECT id
         FROM otp_codes
        WHERE phone = $1
          AND code = $2
          AND used = FALSE
          AND expires_at > now()
        ORDER BY id DESC
        LIMIT 1`,
      [phone, code]
    );

    if (r.rows.length === 0) {
      return res.status(400).json({ ok:false, error:'OTP_INVALID_OR_EXPIRED' });
    }

    const otpId = r.rows[0].id;

    // marquer utilisé
    await db.query(
      `UPDATE otp_codes SET used = TRUE, used_at = now() WHERE id = $1`,
      [otpId]
    );

    // Upsert client minimal (phone = PK, name optionnel)
    await db.query(`
      CREATE TABLE IF NOT EXISTS clients (
        phone TEXT PRIMARY KEY,
        name  TEXT,
        fcm_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    );

    // l’enregistrement du nom se fera via un autre endpoint si besoin
    await db.query(`
      INSERT INTO clients (phone)
      VALUES ($1)
      ON CONFLICT (phone) DO NOTHING
    `, [phone]);

    return res.json({ ok:true });
  } catch (e) {
    console.error('otp/verify error:', e);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

module.exports = router;
