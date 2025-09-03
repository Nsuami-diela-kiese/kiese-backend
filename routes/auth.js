// routes/auth.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const otp = require('../utils/otp');           // ⬅️ un seul import objet
const { sendSms } = require('../utils/sms');

const OTP_DEBUG = process.env.OTP_DEBUG === '1';

// Demande d'OTP
router.post('/otp/request', async (req, res) => {
  try {
    const phone   = String(req.body.phone || '').trim();
    const name    = (req.body.name ?? '').toString().trim();
    const purpose = 'register';

    if (!otp.isE164(phone)) {
      return res.status(400).json({ error: 'PHONE_NOT_E164' });
    }

    // upsert client
    await db.query(`
      INSERT INTO clients (phone, name, verified, created_at, updated_at)
      VALUES ($1, COALESCE(NULLIF($2,''), 'Inconnu'), FALSE, NOW(), NOW())
      ON CONFLICT (phone) DO UPDATE
        SET name = COALESCE(NULLIF(EXCLUDED.name,''), clients.name),
            updated_at = NOW()
    `, [phone, name]);

    // 🔒 OTP figé : ne génère rien, ne stocke rien, ne spam pas de SMS
    if (otp.hasTestOverride(phone)) {
      return res.json({
        ok: true,
        test_override: true,
        ...(OTP_DEBUG && process.env.OTP_TEST_CODE ? { demoCode: process.env.OTP_TEST_CODE } : {}),
      });
    }

    // Génère + hash l’OTP (flux normal)
    const code      = otp.randCode6();
    const codeHash  = otp.hashCode(code);
    const expiresAt = otp.expiryDateFromNow();

    await db.query(`
      INSERT INTO otp_codes (phone, code_hash, expires_at, attempts, created_at, purpose, used)
      VALUES ($1, $2, $3, 0, NOW(), $4, FALSE)
      ON CONFLICT (phone, purpose) DO UPDATE
        SET code_hash = EXCLUDED.code_hash,
            expires_at = EXCLUDED.expires_at,
            attempts = 0,
            used = FALSE,
            used_at = NULL,
            created_at = NOW()
    `, [phone, codeHash, expiresAt, purpose]);

    // Envoi SMS (prod)
    try {
      await sendSms(phone, `Kiese: votre code est ${code}. Valide ${otp.OTP_TTL_MIN} min.`);
    } catch (e) {
      console.error('sendSms error:', e);
      // Option: return res.status(500).json({ error: 'SMS_SEND_FAILED' });
    }

    return res.json({
      ok: true,
      ...(OTP_DEBUG ? { demoCode: code } : {}),
    });
  } catch (e) {
    console.error('otp/request error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// Vérification d'OTP
router.post('/otp/verify', async (req, res) => {
  try {
    const phone   = String(req.body.phone || '').trim();
    const code    = String(req.body.code  || '').trim();
    const purpose = 'register';

    if (!otp.isE164(phone) || !/^\d{4,8}$/.test(code)) {
      return res.status(400).json({ error: 'BAD_INPUT' });
    }

    // 🔒 OTP figé : succès immédiat
    if (otp.isTestOtp(phone, code)) {
      try {
        await db.query('BEGIN');
        await db.query(
          `UPDATE clients
              SET verified = TRUE, verified_at = NOW(), updated_at = NOW()
            WHERE phone = $1`,
          [phone]
        );
        await db.query('COMMIT');
      } catch (e) {
        try { await db.query('ROLLBACK'); } catch (_) {}
        throw e;
      }
      return res.json({ ok: true, verified: true, test_override: true });
    }

    // Flux normal
    const { rows } = await db.query(
      `SELECT code_hash, expires_at, used, attempts
         FROM otp_codes
        WHERE phone = $1 AND purpose = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [phone, purpose]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'NO_OTP' });

    const row = rows[0];
    if (new Date(row.expires_at) < new Date())  return res.status(400).json({ error: 'EXPIRED' });
    if (row.used === true)                      return res.status(400).json({ error: 'ALREADY_USED' });

    const ok = otp.hashCode(code) === row.code_hash;
    if (!ok) {
      await db.query(
        `UPDATE otp_codes
            SET attempts = COALESCE(attempts,0) + 1
          WHERE phone = $1 AND purpose = $2`,
        [phone, purpose]
      );
      return res.status(400).json({ error: 'INVALID_CODE' });
    }

    await db.query('BEGIN');
    await db.query(
      `UPDATE otp_codes
          SET used = TRUE, used_at = NOW()
        WHERE phone = $1 AND purpose = $2`,
      [phone, purpose]
    );
    await db.query(
      `UPDATE clients
          SET verified = TRUE, verified_at = NOW(), updated_at = NOW()
        WHERE phone = $1`,
      [phone]
    );
    await db.query('COMMIT');

    return res.json({ ok: true, verified: true });
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    console.error('otp/verify error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

module.exports = router;
