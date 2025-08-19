// routes/agents.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_NUMBER = process.env.TWILIO_FROM;

// Middleware: auth par token stocké dans agents.session_token
async function requireAgent(req, res, next) {
  try {
    const auth = req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const r = await db.query(
      "SELECT id, name, phone, session_expires FROM agents WHERE session_token=$1",
      [token]
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'Invalid token' });

    const ag = r.rows[0];
    if (ag.session_expires && new Date(ag.session_expires) < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }
    req.agent = { id: ag.id, name: ag.name, phone: ag.phone, token };
    next();
  } catch (e) {
    console.error('requireAgent error', e);
    res.status(500).json({ error: 'server error' });
  }
}

// Créer un agent (exécuté par toi via script/backoffice)
router.post('/create', async (req, res) => {
  try {
    const { id, name, phone } = req.body || {};
    if (!id || !name || !phone) return res.status(400).json({ error: 'id, name, phone required' });

    await db.query(
      "INSERT INTO agents (id, name, phone) VALUES ($1,$2,$3) ON CONFLICT (phone) DO NOTHING",
      [id, name, phone]
    );
    const r = await db.query("SELECT id, name, phone FROM agents WHERE phone=$1", [phone]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('agents/create error', e);
    res.status(500).json({ error: 'server error' });
  }
});

// Demander OTP
router.post('/:phone/request_otp', async (req, res) => {
  try {
    const phone = req.params.phone;
    const r = await db.query("SELECT id FROM agents WHERE phone=$1", [phone]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Agent inconnu' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await db.query(
      "UPDATE agents SET otp_code=$1, otp_expires=NOW() + INTERVAL '60 secondes' WHERE id=$2",
      [code, r.rows[0].id]
    );

    await twilioClient.messages.create({
      body: `Kiese Agents - Votre code est : ${code}`,
      from: FROM_NUMBER,
      to: phone
    });

    res.json({ success: true });
  } catch (e) {
    console.error('agents/request_otp error', e);
    res.status(500).json({ error: 'server error' });
  }
});

// Vérifier OTP -> créer session persistante (90 jours), effacer OTP
router.post('/:phone/verify_otp', async (req, res) => {
  try {
    const phone = req.params.phone;
    const { otp_code } = req.body || {};
    const r = await db.query(
      "SELECT id, name, phone, otp_code, otp_expires FROM agents WHERE phone=$1",
      [phone]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Agent inconnu' });

    const ag = r.rows[0];
    if (!otp_code || otp_code !== ag.otp_code) return res.status(401).json({ error: 'OTP incorrect' });
    if (!ag.otp_expires || new Date(ag.otp_expires) < new Date()) return res.status(403).json({ error: 'OTP expiré' });

    const token = uuidv4();
    await db.query(
      "UPDATE agents SET session_token=$1, session_expires=NOW() + INTERVAL '90 days', otp_code=NULL, otp_expires=NULL WHERE id=$2",
      [token, ag.id]
    );

    res.json({ success: true, token, agent: { id: ag.id, name: ag.name, phone: ag.phone } });
  } catch (e) {
    console.error('agents/verify_otp error', e);
    res.status(500).json({ error: 'server error' });
  }
});

// Logout (révocation)
router.post('/logout', requireAgent, async (req, res) => {
  try {
    await db.query("UPDATE agents SET session_token=NULL, session_expires=NULL WHERE id=$1", [req.agent.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('agents/logout error', e);
    res.status(500).json({ error: 'server error' });
  }
});

// Vérifier la session
router.get('/me', requireAgent, (req, res) => res.json({ ok: true, agent: req.agent }));

module.exports = { router, requireAgent };

