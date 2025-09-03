const express = require('express');
const router = express.Router();
const db = require('../db');
const { randCode6, hashCode } = require('../utils/otp');
// const { sendSms } = require('../utils/sms'); // active si tu as un sender

// Demande d'OTP
router.post('/otp/request', async (req, res) => {
  const phone   = String(req.body?.phone || '').trim();   // E.164 ex: +243...
  const nameRaw = (req.body?.name  || '').toString().trim();
  const fcm     = (req.body?.fcm_token ?? null);
  const name    = nameRaw || phone; // jamais NULL

  if (!phone.startsWith('+') || phone.length < 8) {
    return res.status(400).json({ ok:false, error:'PHONE_INVALID' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) upsert client
    await client.query(`
      INSERT INTO clients (phone, name, fcm_token, verified, created_at, updated_at)
      VALUES ($1, $2, $3, FALSE, NOW(), NOW())
      ON CONFLICT (phone) DO UPDATE
      SET name       = COALESCE(NULLIF($2,''), clients.name),
          fcm_token  = COALESCE($3, clients.fcm_token),
          updated_at = NOW()
    `, [phone, name, fcm]);

    // anti-spam (60s)
    const r = await client.query(`
      SELECT COUNT(*)::int AS c
      FROM otp_codes
      WHERE phone=$1 AND created_at > NOW() - interval '60 seconds'
    `, [phone]);
    if (r.rows[0].c >= 1) {
      await client.query('ROLLBACK');
      return res.status(429).json({ ok:false, error:'TOO_MANY_REQUESTS' });
    }

    // invalider anciens non utilisés
    await client.query(`
      UPDATE otp_codes SET used = TRUE, used_at = NOW()
      WHERE phone = $1 AND used = FALSE
    `, [phone]);

    // 2) nouveau code
    const code = randCode6();
    const codeHash = hashCode(code);

    await client.query(`
      INSERT INTO otp_codes (phone, code_hash, expires_at, attempts, created_at, purpose, used, used_at)
      VALUES ($1,   $2,       NOW() + interval '5 minutes', 0,       NOW(),      'login', FALSE, NULL)
    `, [phone, codeHash]);

    await client.query('COMMIT');

    // Envoi SMS (ou log en dev)
    try {
      // await sendSms(phone, `Votre code Kiese: ${code} (5 min)`);
      console.log('[DEV][OTP] code pour', phone, '=>', code);
    } catch (e) { console.error('sendSms error:', e); }

    return res.json({ ok:true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('otp/request error:', e);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  } finally {
    client.release();
  }
});

// Vérification d'OTP
router.post('/otp/verify', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const code  = String(req.body?.code  || '').trim();

  if (!phone || !code) {
    return res.status(400).json({ ok:false, error:'MISSING_PARAMS' });
  }

  try {
    // on prend le dernier OTP valide et non utilisé
    const q = await db.query(`
      SELECT phone, code_hash, expires_at, attempts, created_at
      FROM otp_codes
      WHERE phone=$1 AND used=FALSE AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `, [phone]);

    if (q.rows.length === 0) {
      return res.status(400).json({ ok:false, error:'NO_VALID_OTP' });
    }

    const row = q.rows[0];
    const maxAttempts = 5;
    const newAttempts = row.attempts + 1;

    // mauvais code
    if (hashCode(code) !== row.code_hash) {
      await db.query(`
        UPDATE otp_codes
        SET attempts = $1,
            used     = CASE WHEN $1 >= $2 THEN TRUE ELSE used END,
            used_at  = CASE WHEN $1 >= $2 THEN NOW() ELSE used_at END
        WHERE phone=$3 AND created_at=$4
      `, [newAttempts, maxAttempts, phone, row.created_at]);

      return res.status(400).json({ ok:false, error:'INVALID_CODE' });
    }

    // bon code → valider & marquer utilisé
    await db.query(`
      UPDATE otp_codes
      SET used=TRUE, used_at=NOW()
      WHERE phone=$1 AND created_at=$2
    `, [phone, row.created_at]);

    await db.query(`
      UPDATE clients
      SET verified=TRUE, updated_at=NOW()
      WHERE phone=$1
    `, [phone]);

    // tu peux émettre un JWT ici si tu veux
    return res.json({ ok:true });
  } catch (e) {
    console.error('otp/verify error:', e);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

module.exports = router;
