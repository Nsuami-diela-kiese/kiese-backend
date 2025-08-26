const express = require('express');
const router = express.Router();
const db = require('../db');
const allowReviewer = process.env.ALLOW_REVIEWER_OTP === 'true';
const reviewerPhone = process.env.REVIEWER_PHONE_DRIVER;
const reviewerOtp   = process.env.REVIEWER_OTP_DRIVER;
// Twilio
const twilio = require('twilio');
const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_TOKEN;

const client = require('twilio')(accountSid, authToken);
const fromNumber = process.env.TWILIO_PHONE;
// 🔄 Met à jour la position d’un chauffeur
router.post('/update_position', async (req, res) => {
  const { phone, lat, lng } = req.body;

  try {
    await db.query(
      'UPDATE drivers SET lat = $1, lng = $2 WHERE phone = $3',
      [lat, lng, phone]
    );
    res.json({ message: 'Position mise à jour' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// 📍 Trouve le chauffeur disponible le plus proche
router.post('/nearest', async (req, res) => {
  const { lat, lng } = req.body;

  try {
    const result = await db.query(`
      SELECT phone, name, lat, lng,
        SQRT(POWER(lat - $1, 2) + POWER(lng - $2, 2)) AS distance
      FROM drivers
      WHERE available = true
      ORDER BY distance ASC
      LIMIT 1
    `, [lat, lng]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Aucun chauffeur disponible' });
    }

    res.json({ driver: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/:phone/request_otp', async (req, res) => {
  const phone = req.params.phone;

  try {
    // === Bypass reviewer : pas d’envoi SMS, on pose directement le code de démo en DB ===
    if (allowReviewer && phone === reviewerPhone) {
      await db.query(
        "UPDATE drivers SET otp_code = $1, otp_expires = NOW() + INTERVAL '60 minutes' WHERE phone = $2",
        [reviewerOtp, phone]
      );
      return res.json({ success: true, reviewer: true });
    }

    // === Flux normal ===
    const result = await db.query('SELECT phone FROM drivers WHERE phone = $1', [phone]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Chauffeur introuvable" });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await db.query(
      "UPDATE drivers SET otp_code = $1, otp_expires = NOW() + INTERVAL '5 minutes' WHERE phone = $2",
      [code, phone]
    );

    await client.messages.create({
      body: `Kiese - Votre code est : ${code}`,
      from: fromNumber,
      to: phone
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Erreur OTP Twilio:", {
      message: err.message,
      code: err.code,
      moreInfo: err.moreInfo,
    });
    res.status(500).json({ error: "Erreur d'envoi OTP", details: err.message });
  }
});


router.post('/:phone/verify_otp', async (req, res) => {
  const { otp_code } = req.body;
  const phone = req.params.phone;

  try {
    // === Bypass reviewer : accepte directement si code/numéro correspondent ===
    if (allowReviewer && phone === reviewerPhone && otp_code === reviewerOtp) {
      return res.json({ success: true, reviewer: true });
    }

    // === Flux normal ===
    const result = await db.query(
      "SELECT otp_code, otp_expires FROM drivers WHERE phone = $1",
      [phone]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Chauffeur introuvable" });
    }

    const row = result.rows[0];

    if (row.otp_code !== otp_code) {
      return res.status(401).json({ error: "Code incorrect" });
    }

    const now = new Date();
    const expiry = new Date(row.otp_expires);
    if (now > expiry) {
      return res.status(403).json({ error: "Code expiré" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Erreur vérification OTP:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


router.get('/:rideId/driver_position', async (req, res) => {
  const result = await db.query(`
    SELECT d.lat, d.lng
    FROM rides r
    JOIN drivers d ON r.driver_phone = d.phone
    WHERE r.id = $1
  `, [req.params.rideId]);

  res.json(result.rows[0]);
});

// ✅ Route POST pour mettre à jour la disponibilité d'un chauffeur
router.post('/update_availability', async (req, res) => {
  const { phone, available } = req.body;
  if (!phone || available === undefined) {
    return res.status(400).json({ error: 'Champs manquants' });
  }
  try {
    await db.query(
      'UPDATE drivers SET available = $1 WHERE phone = $2',
      [available, phone]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Erreur disponibilité :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/:phone/availability', async (req, res) => {
  const phone = req.params.phone;
  try {
    const result = await db.query('SELECT available, solde FROM drivers WHERE phone = $1', [phone]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Chauffeur introuvable" });
    }
    res.json({
      available: result.rows[0].available,
      solde: result.rows[0].solde
    });
  } catch (err) {
    console.error("Erreur route availability :", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get('/:phone/historique', async (req, res) => {
  const phone = req.params.phone;
  const periode = req.query.periode || 'jour';

  let condition = "";
  if (periode === 'jour') {
    condition = "AND finished_at::date = CURRENT_DATE";
  } else if (periode === 'semaine') {
    condition = "AND finished_at >= CURRENT_DATE - INTERVAL '7 days'";
  } else if (periode === 'mois') {
    condition = "AND date_trunc('month', finished_at) = date_trunc('month', CURRENT_DATE)";
  } else if (periode === 'annee') {
    condition = "AND date_trunc('year', finished_at) = date_trunc('year', CURRENT_DATE)";
  }

  const query = `
    SELECT id, client_name, confirmed_price, status, finished_at
    FROM rides
    WHERE driver_phone = $1 AND status = 'terminee'
    ${condition}
    ORDER BY finished_at DESC
  `;

  try {
    const result = await db.query(query, [phone]);
    res.json({ courses: result.rows });
  } catch (e) {
    console.error("Erreur historique chauffeur :", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});
router.post('/:phone/ping_position', async (req, res) => {
  const phone = req.params.phone;
  const { lat, lng } = req.body;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'Coordonnées manquantes' });
  }

  try {
    await db.query(
      'UPDATE drivers SET lat = $1, lng = $2, last_seen = NOW() WHERE phone = $3',
      [lat, lng, phone]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Erreur ping_position :", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});











// ADMIN: créer / MAJ chauffeur (agent identifié par son téléphone)
router.post('/admin/driver', async (req, res) => {
  const { name, phone, vehicle_make, vehicle_type, plate, color, photo } = req.body || {};
  const agentPhone = req.header('X-Agent-Phone');
  if (!agentPhone) return res.status(401).json({ error: 'X-Agent-Phone header required' });
  if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });

  try {
    const ar = await db.query('SELECT id FROM agents WHERE phone=$1', [agentPhone]);
    if (ar.rows.length === 0) return res.status(401).json({ error: 'Unknown agent phone' });
    const agentId = ar.rows[0].id;

    const DEFAULT_SOLDE = 50000; // appliqué UNIQUEMENT à la création
    const DEFAULT_PHOTO = 'https://via.placeholder.com/100';

    // Mapping:
    // vehicle_make -> marque
    // vehicle_type -> modele
    // plate        -> plaque
    // color        -> couleur
    //
    // -> created_by_agent_id défini à la création
    // -> modified_by défini lors d’un UPDATE (ON CONFLICT)
    await db.query(`
      INSERT INTO drivers (phone, name, marque, modele, plaque, couleur, solde, photo, created_by_agent_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (phone) DO UPDATE SET
        name    = EXCLUDED.name,
        marque  = EXCLUDED.marque,
        modele  = EXCLUDED.modele,
        plaque  = EXCLUDED.plaque,
        couleur = EXCLUDED.couleur,
        photo   = COALESCE(drivers.photo, EXCLUDED.photo),
        modified_by = $10
    `, [
      phone,
      name,
      vehicle_make || null,
      vehicle_type || null,
      plate || null,
      color || null,
      DEFAULT_SOLDE,               // uniquement en INSERT
      photo || DEFAULT_PHOTO,
      agentId,                     // created_by_agent_id (INSERT)
      agentId,                     // modified_by (UPDATE)
    ]);

    res.status(201).json({ success: true });
  } catch (e) {
    console.error('admin upsert driver', e);
    res.status(500).json({ error: 'server error', details: e.message });
  }
});




// ADMIN: lire un chauffeur

router.get('/admin/driver/:phone', async (req, res) => {
  const agentPhone = req.header('X-Agent-Phone');
  if (!agentPhone) return res.status(401).json({ error: 'X-Agent-Phone header required' });

  try {
    const ar = await db.query('SELECT 1 FROM agents WHERE phone=$1', [agentPhone]);
    if (ar.rows.length === 0) return res.status(401).json({ error: 'Unknown agent phone' });

    const phone = decodeURIComponent(req.params.phone);
    const r = await db.query(
      `SELECT phone, name, marque, modele, plaque, couleur, available, solde, created_by_agent_id, photo
       FROM drivers WHERE phone=$1`,
      [phone]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });

    const d = r.rows[0];
    res.json({
      phone: d.phone,
      name: d.name,
      vehicle_make: d.marque,
      vehicle_type: d.modele,
      plate: d.plaque,
      color: d.couleur,              // ✅ couleur -> color (pour l’app)
      available: d.available,
      solde: d.solde,
      created_by_agent_id: d.created_by_agent_id,
      photo: d.photo,
    });
  } catch (e) {
    console.error('admin get driver', e);
    res.status(500).json({ error: 'server error', details: e.message });
  }
});



// ADMIN: recharge solde (montant positif uniquement)
router.post('/admin/driver/:phone/update_solde', async (req, res) => {
  const agentPhone = req.header('X-Agent-Phone');
  if (!agentPhone) return res.status(401).json({ error: 'X-Agent-Phone header required' });

  try {
    // Agent
    const ag = await db.query('SELECT id FROM agents WHERE phone=$1', [agentPhone]);
    if (ag.rows.length === 0) return res.status(401).json({ error: 'Unknown agent phone' });
    const agentId = ag.rows[0].id;

    // Inputs
    const phone = decodeURIComponent(req.params.phone);
    // On accepte 'amount' (nouveau) ou 'delta' (ancien) — tous deux doivent être > 0
    const raw = (req.body && (req.body.amount ?? req.body.delta));
    const amount = Number.parseInt(raw, 10);
    const method = (req.body && req.body.method) || null; // ex: "cash"
    const note   = (req.body && req.body.note)   || null; // texte libre

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive integer' });
    }

    await db.query('BEGIN');

    // Verrouille le chauffeur pour éviter des races
    const r0 = await db.query('SELECT solde FROM drivers WHERE phone=$1 FOR UPDATE', [phone]);
    if (r0.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'driver not found' });
    }

    const oldSolde = r0.rows[0].solde || 0;
    const newSolde = oldSolde + amount;

    await db.query('UPDATE drivers SET solde=$1 WHERE phone=$2', [newSolde, phone]);

    const reason = method ? `Recharge (${method})${note ? ' - ' + note : ''}` : (note || 'Recharge');

    await db.query(
      'INSERT INTO solde_history (driver_phone, agent_id, old_solde, delta, new_solde, reason) VALUES ($1,$2,$3,$4,$5,$6)',
      [phone, agentId, oldSolde, amount, newSolde, reason]
    );

    await db.query('COMMIT');
    return res.json({ success: true, added: amount, new_solde: newSolde });
  } catch (e) {
    console.error('admin update_solde (recharge)', e);
    try { await db.query('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: 'server error', details: e.message });
  }
});


//§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§§
// Enregistre / met à jour le token FCM d’un chauffeur
router.post("/:phone/fcm_token", async (req, res) => {
  try {
    const { phone } = req.params;
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "token manquant" });

    await db.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS fcm_token text`);
    await db.query(`UPDATE drivers SET fcm_token=$1 WHERE phone=$2`, [token, phone]);

    res.json({ ok: true });
  } catch (e) {
    console.error("fcm_token:", e);
    res.status(500).json({ error: "server error" });
  }
});





router.get('/:phone/manager', async (req, res) => {
  const phone = req.params.phone;
  try {
    const q = `
      SELECT a.name AS manager_name, a.phone AS manager_phone
      FROM drivers d
      LEFT JOIN agents a ON a.id = d.created_by_agent_id
      WHERE d.phone = $1
      LIMIT 1
    `;
    const r = await db.query(q, [phone]);
    if (r.rows.length === 0) {
      return res.json({ manager_name: null, manager_phone: null });
    }
    res.json(r.rows[0]);
  } catch (e) {
    console.error('manager lookup error:', e);
    res.status(500).json({ error: 'server error' });
  }
});





module.exports = router;













