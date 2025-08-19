// middleware/requireAgent.js
const db = require('../db');

module.exports = async function requireAgent(req, res, next) {
  try {
    const auth = req.header('Authorization') || req.header('X-Agent-Token') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (!token) return res.status(401).json({ error: 'Missing token' });

    // On stocke le "token de session" directement dans agents.otp_code
    const r = await db.query(
      'SELECT id, name, phone, otp_expires FROM agents WHERE otp_code = $1',
      [token]
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'Invalid token' });

    const ag = r.rows[0];
    if (!ag.otp_expires || new Date(ag.otp_expires) < new Date()) {
      return res.status(401).json({ error: 'Token expired' });
    }

    req.agent = { id: ag.id, name: ag.name, phone: ag.phone };
    next();
  } catch (e) {
    console.error('requireAgent error', e);
    res.status(500).json({ error: 'server error' });
  }
};

