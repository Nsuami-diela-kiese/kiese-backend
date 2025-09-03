// routes/auth.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { randCode6, hashCode, isE164, expiryDateFromNow } = require('../utils/otp');
if (!otp.isE164(phone)) {
  return res.status(400).json({ error: 'PHONE_NOT_E164' });
}
const code = otp.randCode6();
const codeHash = otp.hashCode(code);
const expiresAt = otp.expiryDateFromNow();
const ok = (otp.hashCode(code) === row.code_hash);

// Demande d'OTP
router.post('/otp/request', async (req, res) => {
  try {
    const phone   = String(req.body.phone || '').trim();
    const name    = (req.body.name ?? '').toString().trim();
    const purpose = 'register';

    if (!isE164(phone)) return res.status(400).json({ error: 'PHONE_NOT_E164' });

    // 1) upsert client
    await db.query(`
      INSERT INTO clients (phone, name, verified, created_at, updated_at)
      VALUES ($1, COALESCE(NULLIF($2,''), 'Inconnu'), FALSE, NOW(), NOW())
      ON CONFLICT (phone) DO UPDATE
        SET name = COALESCE(NULLIF(EXCLUDED.name,''), clients.name),
            updated_at = NOW()
    `, [phone, name]);

    // 2) OTP
    const code = randCode6();             // 6 chiffres
    const codeHash = hashCode(code);
    const expiresAt = expiryDateFromNow();

    // 3) upsert otp_codes (1 ligne / phone+purpose)
    await db.query(`
      INSERT INTO otp_codes (phone, purpose, code_hash, expires_at, attempts, created_at, used, used_at)
      VALUES ($1, $2, $3, $4, 0, NOW(), FALSE, NULL)
      ON CONFLICT (phone, purpose) DO UPDATE
        SET code_hash = EXCLUDED.code_hash,
            expires_at = EXCLUDED.expires_at,
            attempts = 0,
            used = FALSE,
            used_at = NULL,
            created_at = NOW()
    `, [phone, purpose, codeHash, expiresAt]);

    // TODO: send SMS ici
    // await sendSms(phone, `Votre code Kiese: ${code}`);

    return res.json({ ok: true /*, demoCode: code*/ });
  } catch (e) {
    console.error('otp/request error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// Vérification d’OTP (transaction + verrou)
router.post('/otp/verify', async (req, res) => {
  const client = await db.connect();
  try {
    const phone   = String(req.body.phone || '').trim();
    const code    = String(req.body.code  || '').trim();
    const purpose = 'register';

    if (!isE164(phone) || !/^\d{4,8}$/.test(code)) {
      return res.status(400).json({ error: 'BAD_INPUT' });
    }

    await client.query('BEGIN');

    // 1) lock la ligne (unique par phone+purpose)
    const r0 = await client.query(
      `SELECT id, code_hash, expires_at, used, attempts
         FROM otp_codes
        WHERE phone = $1 AND purpose = $2
        FOR UPDATE`,
      [phone, purpose]
    );
    if (r0.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'NO_OTP' });
    }
    const row = r0.rows[0];

    // 2) checks
    if (new Date(row.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'EXPIRED' });
    }
    if (row.used === true) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'ALREADY_USED' });
    }

    // 3) compare hash
    const ok = (hashCode(code) === row.code_hash);
    if (!ok) {
      await client.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      await client.query('COMMIT');
      return res.status(400).json({ error: 'INVALID_CODE' });
    }

    // 4) marque utilisé + vérifie le client
    await client.query(`UPDATE otp_codes SET used = TRUE, used_at = NOW() WHERE id = $1`, [row.id]);
    await client.query(`UPDATE clients SET verified = TRUE, verified_at = NOW(), updated_at = NOW() WHERE phone = $1`, [phone]);

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('otp/verify error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  } finally {
    client.release();
  }
});

module.exports = router;
