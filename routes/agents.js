// routes/agents.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');

const TWILIO_SID   = process.env.TWILIO_SID   || process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_PHONE || process.env.TWILIO_FROM;

const sms = (TWILIO_SID && TWILIO_TOKEN) ? twilio(TWILIO_SID, TWILIO_TOKEN) : null;

// (optionnel) créer un agent (id string ex: JUN001)
router.post('/create', async (req, res) => {
  const { id, name, phone } = req.body || {};
  if (!id || !name || !phone) return res.status(400).json({ error: 'id, name, phone required' });
  try {
    await db.query(
      'INSERT INTO agents (id, name, phone) VALUES ($1,$2,$3) ON CONFLICT (phone) DO NOTHING',
      [id, name, phone]
    );
    const r = await db.query('SELECT id, name, phone FROM agents WHERE phone=$1', [phone]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('agents/create', e);
    res.status(500).json({ error: 'server error' });
  }
});

// 1) Demander OTP court (6 chiffres / 5 min)
router.post('/:phone/request_otp', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const r = await db.query('SELECT id FROM agents WHERE phone=$1', [phone]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Agent inconnu' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await db.query(
      "UPDATE agents SET otp_code=$1, otp_expires=NOW() + INTERVAL '5 minutes' WHERE id=$2",
      [code, r.rows[0].id]
    );

    if (sms && TWILIO_FROM) {
      await sms.messages.create({ body: `Kiese Agents - Code: ${code}`, from: TWILIO_FROM, to: phone });
    } else {
      console.warn('⚠️ Twilio non configuré, OTP:', code);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('agents/request_otp', e);
    res.status(500).json({ error: 'server error' });
  }
});

// 2) Vérifier OTP -> transformer en token UUID (90 jours)
router.post('/:phone/verify_otp', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { otp_code } = req.body || {};
    const r = await db.query(
      'SELECT id, name, phone, otp_code, otp_expires FROM agents WHERE phone=$1',
      [phone]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Agent inconnu' });

    const ag = r.rows[0];
    if (!otp_code || otp_code !== ag.otp_code) return res.status(401).json({ error: 'OTP incorrect' });
    if (!ag.otp_expires || new Date(ag.otp_expires) < new Date()) return res.status(403).json({ error: 'OTP expiré' });

    const token = uuidv4(); // session côté client, stockée en SharedPreferences
    await db.query(
      "UPDATE agents SET otp_code=$1, otp_expires=NOW() + INTERVAL '90 days' WHERE id=$2",
      [token, ag.id]
    );

    res.json({ success: true, token, agent: { id: ag.id, name: ag.name, phone: ag.phone } });
  } catch (e) {
    console.error('agents/verify_otp', e);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
