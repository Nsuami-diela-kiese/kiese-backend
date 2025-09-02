const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendSMS } = require('../utils/sms');
const { generateNumericCode, hashCode, isE164, expiryDateFromNow, OTP_LENGTH } = require('../utils/otp');

// POST /api/auth/otp/request  { phone: "+243..." }
router.post('/otp/request', async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    if (!isE164(phone)) return res.status(400).json({ error: 'INVALID_PHONE_E164' });

    // code + hash
    const code = generateNumericCode(OTP_LENGTH);
    const codeHash = hashCode(code);
    const expiresAt = expiryDateFromNow();

    await db.query('BEGIN');

    // Upsert client si pas encore présent (name vide pour l’instant)
    await db.query(`
      INSERT INTO clients(phone, name, is_verified)
      VALUES ($1, '', FALSE)
      ON CONFLICT (phone) DO NOTHING
    `, [phone]);

    // Upsert otp_codes pour ce phone
    await db.query(`
      INSERT INTO otp_codes(phone, code_hash, expires_at, attempts)
      VALUES ($1, $2, $3, 0)
      ON CONFLICT (phone) DO UPDATE
        SET code_hash = EXCLUDED.code_hash,
            expires_at = EXCLUDED.expires_at,
            attempts = 0
    `, [phone, codeHash, expiresAt]);

    await db.query('COMMIT');

    // Envoi SMS (message localisable)
    const msg = `Votre code Kiese est: ${code}. Il expire dans ${process.env.OTP_TTL_MIN || 5} min.`;
    await sendSMS(phone, msg);

    return res.json({ ok: true });
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch {}
    console.error('otp/request error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// POST /api/auth/otp/verify  { phone:"+243...", code:"123456" }
router.post('/otp/verify', async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const code = String(req.body?.code || '').trim();

    if (!isE164(phone)) return res.status(400).json({ error: 'INVALID_PHONE_E164' });
    if (!/^\d+$/.test(code)) return res.status(400).json({ error: 'INVALID_CODE' });

    const { rows } = await db.query(`SELECT code_hash, expires_at, attempts FROM otp_codes WHERE phone = $1`, [phone]);
    if (rows.length === 0) return res.status(400).json({ error: 'OTP_NOT_FOUND' });

    const row = rows[0];
    const now = new Date();
    if (new Date(row.expires_at) < now) {
      return res.status(400).json({ error: 'OTP_EXPIRED' });
    }

    const hash = hashCode(code);
    if (hash !== row.code_hash) {
      // incrémenter attempts
      await db.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = $1`, [phone]);
      return res.status(400).json({ error: 'OTP_INVALID' });
    }

    // OK => vérifier le client
    await db.query('BEGIN');
    await db.query(`UPDATE clients SET is_verified = TRUE WHERE phone = $1`, [phone]);
    await db.query(`DELETE FROM otp_codes WHERE phone = $1`, [phone]); // invalidation
    await db.query('COMMIT');

    return res.json({ ok: true, verified: true });
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch {}
    console.error('otp/verify error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

module.exports = router;
