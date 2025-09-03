const express = require('express');
const router = express.Router();
const db = require('../db');
const { randCode6, hashCode } = require('../utils/otp');
// const { sendSms } = require('../utils/sms'); // active si tu as un sender

// Demande d'OTP
router.post('/otp/request', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    const name  = (req.body.name ?? '').toString().trim(); // optionnel mais on tente de le stocker
    const purpose = 'register';

    if (!isE164(phone)) {
      return res.status(400).json({ error: 'PHONE_NOT_E164' });
    }

    // 1) upsert client (évite l’erreur NOT NULL sur name)
    await db.query(`
      INSERT INTO clients (phone, name, verified, created_at, updated_at)
      VALUES ($1, COALESCE(NULLIF($2,''), 'Inconnu'), FALSE, NOW(), NOW())
      ON CONFLICT (phone) DO UPDATE
        SET name = COALESCE(NULLIF(EXCLUDED.name,''), clients.name),
            updated_at = NOW()
    `, [phone, name]);

    // 2) génère & hash l’OTP
    const code = randCode6();                 // alias de generateNumericCode()
    const codeHash = hashCode(code);
    const expiresAt = expiryDateFromNow();

    // 3) upsert otp_codes
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

    // TODO: envoi via SMS provider ici (Twilio ou autre)
    // await sendSms(phone, `Votre code Kiese: ${code}`);

    return res.json({ ok: true /*, demoCode: code*/ });
  } catch (e) {
    console.error('otp/request error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// Vérification d'OTP
router.post('/otp/verify', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    const code  = String(req.body.code  || '').trim();
    const purpose = 'register';

    if (!isE164(phone) || !/^\d{4,8}$/.test(code)) {
      return res.status(400).json({ error: 'BAD_INPUT' });
    }

    const { rows } = await db.query(
      `SELECT code_hash, expires_at, used, attempts
         FROM otp_codes
        WHERE phone = $1 AND purpose = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [phone, purpose]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: 'NO_OTP' });
    }
    const row = rows[0];

    // expiré ?
    if (new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: 'EXPIRED' });
    }
    // déjà utilisé ?
    if (row.used === true) {
      return res.status(400).json({ error: 'ALREADY_USED' });
    }

    // compare hash
    const ok = hashCode(code) === row.code_hash;
    if (!ok) {
      await db.query(
        `UPDATE otp_codes
            SET attempts = COALESCE(attempts,0) + 1
          WHERE phone = $1 AND purpose = $2`,
        [phone, purpose]
      );
      return res.status(400).json({ error: 'INVALID_CODE' });
    }

    // marque utilisé + vérifie le client
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

    return res.json({ ok: true });
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    console.error('otp/verify error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});


module.exports = router;
