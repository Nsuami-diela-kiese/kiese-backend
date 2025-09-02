require('dotenv').config();
const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');

const { sendFcm } = require('../utils/fcm');                 // ✅ une seule import FCM
const { reassignDriverForRide, ensureReassignForRide } = require('../utils/reassign');
const { pickNearestDriverAtomicFallback } = require('../utils/driverPicker');
function toInt(x, def = 0) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : def; }

// ✅ Import "optionnel" des helpers de flags SANS redéclaration
let setOnRideByPhone = async () => {};
let setBusyByPhone   = async () => {};
try {
  const flags = require('../utils/driverFlags');
  if (typeof flags.setOnRideByPhone === 'function') setOnRideByPhone = flags.setOnRideByPhone;
  if (typeof flags.setBusyByPhone   === 'function') setBusyByPhone   = flags.setBusyByPhone;
} catch (_) {
  // module absent : on garde des no-op
}


async function getDriverFcmTokenByPhone(phone) {
  if (!phone) return null;
  const r = await db.query('SELECT fcm_token FROM drivers WHERE phone = $1', [phone]);
  return r.rows[0]?.fcm_token || null;
}

// 🛺 Crée une course
router.post('/create', async (req, res) => {
  const {
    client_name,
    origin_lat,
    origin_lng,
    destination_lat,
    destination_lng,
    driver_phone
  } = req.body;

  try {
    const result = await db.query(`
      INSERT INTO rides (
        client_name, origin_lat, origin_lng,
        destination_lat, destination_lng, driver_phone
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      client_name,
      origin_lat,
      origin_lng,
      destination_lat,
      destination_lng,
      driver_phone
    ]);

    res.status(201).json({ ride: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur création course' });
  }
});

// 🔍 Vérifie le statut d’une course
router.get('/:id/status', async (req, res) => {
  const rideId = req.params.id;

  try {
    const result = await db.query(
      'SELECT status, cancelled_by FROM rides WHERE id = $1',
      [rideId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course introuvable' });
    }

    const { status, cancelled_by } = result.rows[0];

    // On renvoie cancelled_by seulement s'il est non nul
    const response = { status };
    if (cancelled_by) {
      response.cancelled_by = cancelled_by;
    }

    res.json(response);
  } catch (err) {
    console.error('Erreur lors de la récupération du statut de course :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ?? Enregistre le montant n�goci�
router.post('/:id/price', async (req, res) => {
  const rideId = req.params.id;
  const { price } = req.body;

  try {
    await db.query(
      'UPDATE rides SET proposed_price = $1 WHERE id = $2',
      [price, rideId]
    );
    res.json({ success: true, message: 'Montant enregistr�' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur enregistrement montant' });
  }
});

/*router.post('/:id/price', async (req, res) => {
  const rideId = req.params.id;
  const { price } = req.body;

  try {
    await db.query(
      'UPDATE rides SET proposed_price = $1 WHERE id = $2',
      [price, rideId]
    );
    res.json({ success: true, message: 'Montant enregistr�' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur enregistrement montant' });
  }
});*/
router.post('/create', async (req, res) => {
  const {
    client_phone,
    origin_lat,
    origin_lng,
    destination_lat,
    destination_lng,
    driver_phone
  } = req.body;

  try {
    const result = await db.query(`
      INSERT INTO rides (
        client_phone, origin_lat, origin_lng,
        destination_lat, destination_lng,
        driver_phone, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'en_attente_n�gociation')
      RETURNING id
    `, [client_name, origin_lat, origin_lng, destination_lat, destination_lng, driver_phone]);

    res.status(201).json({ ride_id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur cr�ation course' });
  }
});
// ? Chauffeur confirme le prix propos�
router.post('/:id/confirm_price', async (req, res) => {
  const rideId = req.params.id;

  try {
    const result = await db.query(`
      UPDATE rides
      SET
        confirmed_price = proposed_price,
        negotiation_status = 'confirmee',
        status = 'course_acceptee'
      WHERE id = $1
      RETURNING *;
    `, [rideId]);

    res.json({ success: true, ride: result.rows[0] });
  } catch (err) {
    console.error("❌ Erreur confirm_price :", err);
    res.status(500).json({ error: 'Erreur confirmation prix' });
  }
});

// ?? R�cup�re toutes les courses en attente de confirmation de prix
router.get('/en_attente/:driverPhone', async (req, res) => {
  const driverPhone = req.params.driverPhone;

  try {
    const result = await db.query(`
      SELECT * FROM rides
      WHERE status = 'en_attente'
        AND negotiation_status = 'en_attente'
        AND driver_phone = $1
      ORDER BY id DESC
    `, [driverPhone]);

    res.json({ rides: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur récupération des courses' });
  }
});

// ?? V�rifie si le prix a �t� confirm� pour une course
router.get('/:id/confirmation_status', async (req, res) => {
  const rideId = req.params.id;

  try {
    const result = await db.query(
      'SELECT confirmed_price FROM rides WHERE id = $1',
      [rideId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course non trouv�e' });
    }

    const confirmedPrice = result.rows[0].confirmed_price;
    res.json({ confirmed: confirmedPrice !== null, confirmed_price: confirmedPrice });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
// ?? Retourne les infos de la course (client + destination)
/*router.get('/:id/details', async (req, res) => {
  const rideId = req.params.id;

  try {
    const result = await db.query(`
      SELECT origin_lat, origin_lng, destination_lat, destination_lng
      FROM rides
      WHERE id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course introuvable' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur r�cup�ration d�tails course' });
  }
});*/
// ?? Marque la course comme "en cours"
router.post('/:id/start', async (req, res) => {
  const rideId = req.params.id;

  try {
    await db.query(
      `UPDATE rides SET status = 'en_cours', started_at=NOW() WHERE id = $1`,
      [rideId]
    );
    res.json({ success: true, message: 'Course d�marr�e' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur d�marrage course' });
  }
});
// ?? Donne les coordonn�es client + destination pour une course




router.get('/:id/details', async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.query(`
    SELECT id, status, reassigning,
           origin_lat, origin_lng, destination_lat, destination_lng,
           proposed_price, driver_phone, discussion
    FROM rides WHERE id=$1
  `, [id]);
  const ride = r.rows[0];
  if (!ride) return res.status(404).json({ error: 'RIDE_NOT_FOUND' });

  let driver = null;
  if (ride.driver_phone) {
    const d = await db.query(`
      SELECT phone, name, lat, lng, marque, modele, couleur, plaque, photo
      FROM drivers WHERE phone=$1
    `, [ride.driver_phone]);
    driver = d.rows[0] || null;
  }

  res.json({
    id: ride.id,
    status: ride.status,
    reassigning: ride.reassigning === true,
    origin_lat: ride.origin_lat,
    origin_lng: ride.origin_lng,
    destination_lat: ride.destination_lat,
    destination_lng: ride.destination_lng,
    proposed_price: ride.proposed_price,
    driver,
    discussion: ride.discussion || []
  });
});






// POST /api/ride/:id/discussion
router.post('/:id/discussion', async (req, res) => {
  const rideId = Number(req.params.id);
  const body = req.body || {};
  let detached = false;

  try {
    const from = (body.from || '').toString();     // 'client' | 'chauffeur'
    const type = (body.type || '').toString();     // 'normal'|'last_offer'|'accept'|'refuse'
    const amountRaw = (body.amount ?? '').toString();
    const amount = /^\d+$/.test(amountRaw) ? parseInt(amountRaw, 10) : null;

    if (!from || !type) {
      return res.status(400).json({ error: 'from et type sont requis' });
    }
    if ((type === 'normal' || type === 'last_offer') && (amount == null || amount < 3000)) {
      return res.status(400).json({ error: 'Montant invalide (min 3000)' });
    }

    const r0 = await db.query(`
      SELECT id, status, driver_phone, proposed_price, discussion
      FROM rides WHERE id = $1
    `, [rideId]);
    const ride = r0.rows[0];
    if (!ride) return res.status(404).json({ error: 'RIDE_NOT_FOUND' });

    // consigner message (sans "system:")
    let msg = `${from}:${amount != null ? amount : ''}`;
    if (type === 'last_offer') msg += ':last_offer';
    if (type === 'accept')     msg += ':accepted';
    if (type === 'refuse')     msg += ':refused';

    await db.query(
      `UPDATE rides SET discussion = array_append(discussion, $1::text) WHERE id = $2`,
      [msg, rideId]
    );

    // proposed / last_offer
    if ((type === 'normal' || type === 'last_offer') && amount != null) {
      await db.query(`UPDATE rides SET proposed_price = $1 WHERE id = $2`, [amount, rideId]);
    }
    if (type === 'last_offer' && amount != null) {
      await db.query(
        `UPDATE rides SET last_offer_from = $1, last_offer_value = $2 WHERE id = $3`,
        [from, amount, rideId]
      );
    }

    // accept
    if (type === 'accept') {
      if (from === 'client') {
        await db.query(`UPDATE rides SET client_accepted = TRUE WHERE id = $1`, [rideId]);
      } else if (from === 'chauffeur') {
        await db.query(`UPDATE rides SET status = 'course_acceptee' WHERE id = $1`, [rideId]);
      }
    }

    // refuse
    if (type === 'refuse' && from === 'chauffeur') {
      // renseigne qui/quoi (pas d'annulation de la course côté client)
      await db.query(
        `UPDATE rides SET cancelled_by = 'chauffeur', cancel_reason = 'driver_refused' WHERE id = $1`,
        [rideId]
      );

      // lance la réassignation (archive / reset / pick / notif)
      detached = true;
      const rr = await reassignDriverForRide(rideId);
      console.log('[discussion] reassign result:', JSON.stringify(rr));
    }

    // notif chauffeur si c'est le client qui écrit
    if (from === 'client') {
      try {
        const r1 = await db.query(`SELECT driver_phone FROM rides WHERE id = $1`, [rideId]);
        const driverPhone = r1.rows[0]?.driver_phone;
        if (driverPhone) {
          const token = await getDriverFcmTokenByPhone(driverPhone);
          if (token) {
            await sendFcm(
              token,
              {
                title:
                  (type === 'last_offer') ? '⚠️ Dernière offre du client'
                  : (type === 'accept')   ? '✅ Le client a accepté'
                  : (type === 'refuse')   ? '❌ Le client a refusé'
                                          : '💬 Nouvelle proposition',
                body: amount != null ? `Proposition: ${amount} CDF` : 'Mise à jour de la négociation',
              },
              { type: 'nego_update', ride_id: String(rideId), sender: 'client' }
            );
          }
        }
      } catch (e) {
        console.error('Notif nego_update error:', e);
      }
    }

    return res.json({ success: true, detached });
  } catch (e) {
    console.error('❌ /discussion error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});



router.get('/:id/discussion', async (req, res) => {
  const rideId = req.params.id;

  try {
    const result = await db.query(
      'SELECT discussion FROM rides WHERE id = $1',
      [rideId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course introuvable' });
    }

    res.json({ discussion: result.rows[0].discussion || [] });
  } catch (e) {
    console.error("❌ Erreur GET discussion:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// Cr�e une course automatiquement avec ETA chauffeur ? client et client ? destination
// routes/rides.js
router.post('/create_auto', async (req, res) => {
  const {
    client_name, client_phone,
    origin_lat, origin_lng,
    destination_lat, destination_lng
  } = req.body;

  try {
    // 🔎 sélection atomique + réservation
    const driver = await pickNearestDriverAtomicFallback({
      originLat: origin_lat,
      originLng: origin_lng,
      excludePhones: [],
      radii: [3, 6, 10, 15],
      minSolde: 3000,
    });

    if (!driver) {
      return res.status(404).json({ error: 'Aucun chauffeur disponible' });
    }

    // (double-sécu si tu veux uniformiser tes flags ailleurs)
    try {
      if (setOnRideByPhone) await setOnRideByPhone(driver.phone, true);
      else if (setBusyByPhone) await setBusyByPhone(driver.phone, true);
    } catch (_) {}

    // ETA Google
    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    const distUrl =
      `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric` +
      `&origins=${driver.lat},${driver.lng}` +
      `&destinations=${origin_lat},${origin_lng}|${destination_lat},${destination_lng}` +
      `&key=${API_KEY}`;

    const distResponse = await axios.get(distUrl);
    const elements = distResponse.data?.rows?.[0]?.elements || [];
    const etaToClient = elements?.[0]?.duration?.text ?? '-';
    const etaToDestination = elements?.[1]?.duration?.text ?? '-';

    // 🚕 INSERT
    const montantPropose = 3000;
    const messageInitial = `client:${montantPropose}`;

    const ins = await db.query(`
      INSERT INTO rides (
        client_name, client_phone,
        origin_lat, origin_lng,
        destination_lat, destination_lng,
        driver_phone, proposed_price,
        discussion, client_accepted,
        status, negotiation_status,
        contacted_driver_phones, reassign_attempts, reassigning
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,
        ARRAY[$9]::text[], TRUE,
        'en_attente','en_attente',
        ARRAY[$7]::text[], 0, FALSE
      )
      RETURNING id
    `, [
      client_name, client_phone,
      origin_lat, origin_lng,
      destination_lat, destination_lng,
      driver.phone, montantPropose,
      messageInitial
    ]);

    const rideId = ins.rows[0].id;

    // 🔔 Notif chauffeur
    try {
      const token = await getDriverFcmTokenByPhone(driver.phone);
      if (token) {
        await sendFcm(
          token,
          { title: '🚗 Nouvelle course', body: `Course #${rideId} en attente` },
          { type: 'new_ride', ride_id: String(rideId) }
        );
      }
    } catch (e) { console.error('FCM create_auto:', e); }

    return res.status(201).json({
      ride_id: rideId,
      driver: { phone: driver.phone, lat: driver.lat, lng: driver.lng },
      eta_to_client: etaToClient,
      eta_to_destination: etaToDestination,
      status: 'en_attente'
    });
  } catch (e) {
    console.error('create_auto error:', e);
    return res.status(500).json({ error: 'Erreur serveur création course' });
  }
});

/**
 * POST /api/ride/create_negociation
 * - version négociation (montant proposé par le client)
 * - utilise aussi le picker atomique
 * - seed contacted_driver_phones
 */




// POST /api/ride/:id/cancel
// Body: { by: "driver" | "client" | "system" }
// POST /api/ride/:id/cancel
// POST /api/ride/:id/cancel
// body: { by?: 'client' | 'chauffeur' | 'system', reason?: string }
router.post('/:id/cancel', async (req, res) => {
  const rideId = Number(req.params.id);
  const by = String(req.body?.by || 'client').toLowerCase();
  const reason = req.body?.reason || (by === 'client' ? 'client_cancel' : 'auto_reassign');

  try {
    // 1) Charger la course
    const r0 = await db.query(
      `SELECT id, status, driver_phone
         FROM rides
        WHERE id = $1`,
      [rideId]
    );
    const ride = r0.rows[0];
    if (!ride) return res.status(404).json({ error: 'RIDE_NOT_FOUND' });

    const oldPhone = ride.driver_phone || null;

    // 2) Branche "client"
    if (by === 'client') {
      // Idempotence: si déjà annulée/terminée on répond 200
      if (ride.status === 'annulee' || ride.status === 'terminee') {
        return res.json({ ok: true, status: ride.status });
      }

      await db.query('BEGIN');
      await db.query(
        `UPDATE rides
            SET status = 'annulee',
                cancelled_by = 'client',
                cancel_reason = $2,
                reassigning = FALSE,
                discussion = COALESCE(discussion, ARRAY[]::text[]) || 'client:0:cancelled'::text
          WHERE id = $1`,
        [rideId, reason]
      );
      await db.query('COMMIT');

      // Notifier le chauffeur + libérer son flag d'occupation (best-effort)
      if (oldPhone) {
        try {
          const token = await getDriverFcmTokenByPhone(oldPhone);
          if (token) {
            await sendFcm(
              token,
              { title: '❌ Course annulée', body: 'Le client a annulé la course.' },
              { type: 'status_update', ride_id: String(rideId) }
            );
          }
        } catch (e) {
          console.error('FCM cancel->driver error:', e);
        }
        try { if (setBusyByPhone) await setBusyByPhone(oldPhone, false); } catch (_) {}
      }

      return res.json({ ok: true, status: 'annulee' });
    }

    // 3) Branche "chauffeur" -> on lance une RÉASSIGNATION
    if (by === 'chauffeur') {
      await db.query('BEGIN');
      await db.query(
        `UPDATE rides
            SET cancelled_by = 'chauffeur',
                cancel_reason = $2,
                status = 'en_attente',
                driver_phone = NULL,
                reassigning = TRUE
          WHERE id = $1`,
        [rideId, reason]
      );
      await db.query('COMMIT');

      // libérer l'ancien chauffeur côté flags (best-effort)
      try { if (oldPhone && setBusyByPhone) await setBusyByPhone(oldPhone, false); } catch (_) {}

      // réassignation
      const r = await reassignDriverForRide(rideId).catch(e => {
        console.error('reassign error:', e);
        return { ok: false, reason: 'TX_ERROR' };
      });

      // Fin de phase "reassigning"
      try {
        await db.query(`UPDATE rides SET reassigning = FALSE WHERE id = $1`, [rideId]);
      } catch (_) {}

      if (r?.ok) {
        return res.json({ ok: true, status: 'en_attente', reassigned_to: r.driver.phone });
      } else {
        // On reste en attente sans chauffeur; le client verra "recherche…"
        return res.status(202).json({ ok: false, status: 'en_attente', searching: true, reason: r?.reason || 'NO_DRIVER' });
      }
    }

    // 4) Fallback "system" (si jamais tu l’utilises)
    await db.query(
      `UPDATE rides
          SET status = 'annulee',
              cancelled_by = 'system',
              cancel_reason = $2,
              reassigning = FALSE
        WHERE id = $1`,
      [rideId, reason]
    );
    return res.json({ ok: true, status: 'annulee' });

  } catch (e) {
    // Si jamais un BEGIN a été fait plus haut sans COMMIT:
    try { await db.query('ROLLBACK'); } catch (_) {}
    console.error('cancel route error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

module.exports = router;






// ? Terminer une course


router.post('/:id/finish', async (req, res) => {
  const rideId = Number(req.params.id);
  const { route } = req.body;

  if (!route) return res.status(400).json({ error: "Route manquante" });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verrouille la course pour éviter les doubles débits
    const { rows } = await client.query(
      `SELECT id, status, confirmed_price, driver_phone
       FROM rides
       WHERE id = $1
       FOR UPDATE`,
      [rideId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Course introuvable" });
    }

    const ride = rows[0];
    const driverPhone = ride.driver_phone;

    // Si déjà terminée, on s'assure tout de même de libérer le chauffeur (idempotence)
    if (ride.status === 'terminee') {
      if (driverPhone) {
        await client.query(
          `UPDATE drivers
           SET on_ride = FALSE,
               current_ride_id = NULL
           WHERE phone = $1`,
          [driverPhone]
        );
      }
      await client.query('COMMIT');

      // Notif hors transaction
      try {
        const token = await getDriverFcmTokenByPhone(driverPhone);
        if (token) {
          await sendFcm(
            token,
            { title: '✅ Course terminée', body: 'Merci pour votre conduite' },
            { type: 'status_update', ride_id: String(rideId) }
          );
        }
      } catch (e) { console.error('Notif finish (idempotent):', e); }

      return res.json({ success: true, alreadyFinished: true });
    }

    const confirmedPrice = ride.confirmed_price || 0;
    const commission = Math.floor(confirmedPrice * 0.15);

    // Met à jour la course
    await client.query(
      `UPDATE rides
       SET status = 'terminee',
           finished_at = NOW(),
           route = $1,
           commission = $2
       WHERE id = $3`,
       [JSON.stringify(route), commission, rideId]
    );

    // Déduit la commission et libère le chauffeur
    if (driverPhone) {
      await client.query(
        `UPDATE drivers
         SET solde = solde - $1,
             on_ride = FALSE,
         WHERE phone = $2`,
        [commission, driverPhone]
      );
    }

    await client.query('COMMIT');

    // Notif hors transaction
    try {
      const token = await getDriverFcmTokenByPhone(driverPhone);
      if (token) {
        await sendFcm(
          token,
          { title: '✅ Course terminée', body: 'Merci pour votre conduite' },
          { type: 'status_update', ride_id: String(rideId) }
        );
      }
    } catch (e) { console.error('Notif finish:', e); }

    res.json({ success: true, commission });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch(_) {}
    console.error("Erreur finish :", e);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});



router.post('/create_negociation', async (req, res) => {
  const {
    client_name, client_phone,
    origin_lat, origin_lng,
    destination_lat, destination_lng,
    proposed_price
  } = req.body;

  try {
    const minSolde = Math.max(Number(proposed_price) || 0, 3000);

    const driver = await pickNearestDriverAtomicFallback({
      originLat: origin_lat,
      originLng: origin_lng,
      excludePhones: [],
      radii: [3, 6, 10, 15],
      minSolde
    });

    if (!driver) {
      return res.status(404).json({ error: 'Aucun chauffeur disponible' });
    }

    // (double-sécu flags)
    try {
      if (setOnRideByPhone) await setOnRideByPhone(driver.phone, true);
      else if (setBusyByPhone) await setBusyByPhone(driver.phone, true);
    } catch (_) {}

    // ETA Google
    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    const distUrl =
      `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric` +
      `&origins=${driver.lat},${driver.lng}` +
      `&destinations=${origin_lat},${origin_lng}|${destination_lat},${destination_lng}` +
      `&key=${API_KEY}`;

    const distResponse = await axios.get(distUrl);
    const elements = distResponse.data?.rows?.[0]?.elements || [];
    const etaToClient = elements?.[0]?.duration?.text ?? '-';
    const etaToDestination = elements?.[1]?.duration?.text ?? '-';

    // 🚕 INSERT
    const messageInitial = `client:${proposed_price}`;

    const ins = await db.query(`
      INSERT INTO rides (
        client_name, client_phone,
        origin_lat, origin_lng,
        destination_lat, destination_lng,
        driver_phone, proposed_price,
        discussion, client_accepted,
        status, negotiation_status,
        contacted_driver_phones, reassign_attempts, reassigning
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,
        ARRAY[$9]::text[], TRUE,
        'en_attente','en_attente',
        ARRAY[$7]::text[], 0, FALSE
      )
      RETURNING id
    `, [
      client_name, client_phone,
      origin_lat, origin_lng,
      destination_lat, destination_lng,
      driver.phone, proposed_price,
      messageInitial
    ]);

    const rideId = ins.rows[0].id;

    // 🔔 Notif chauffeur
    try {
      const token = await getDriverFcmTokenByPhone(driver.phone);
      if (token) {
        await sendFcm(
          token,
          { title: '🚗 Nouvelle course', body: 'Un client attend votre réponse' },
          { type: 'new_ride', ride_id: String(rideId) }
        );
      }
    } catch (e) { console.error('FCM create_negociation:', e); }

    return res.status(201).json({
      ride_id: rideId,
      driver: { phone: driver.phone, lat: driver.lat, lng: driver.lng },
      eta_to_client: etaToClient,
      eta_to_destination: etaToDestination,
      status: 'en_attente'
    });
  } catch (e) {
    console.error('create_negociation error:', e);
    return res.status(500).json({ error: 'Erreur serveur création négociation' });
  }
});



router.get('/:id/driver_position', async (req, res) => {
  const rideId = req.params.id;

  try {
    const result = await db.query(`
      SELECT d.lat, d.lng
      FROM rides r
      JOIN drivers d ON r.driver_phone = d.phone
      WHERE r.id = $1
    `, [rideId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Chauffeur non trouvé" });
    }

    const { lat, lng } = result.rows[0];
    res.json({ lat, lng });
  } catch (err) {
    console.error("Erreur /driver_position :", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get('/:id/resume_details', async (req, res) => {
  const rideId = req.params.id;

  try {
    const result = await db.query(`
      SELECT r.id, r.driver_phone, r.origin_lat, r.origin_lng, r.destination_lat, r.destination_lng, 
             r.proposed_price, d.name, d.plaque, d.couleur, d.photo,marque, modele
             r.status
      FROM rides r
      JOIN drivers d ON r.driver_phone = d.phone
      WHERE r.id = $1
    `, [rideId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Course introuvable" });
    }

    const row = result.rows[0];

    res.json({
      chauffeur: {
        phone: row.driver_phone,
        name: row.name,
        plaque: row.plaque,
        couleur: row.couleur,
        photo: row.photo,
        marque: row.marque,
        modele: row.modele,
      },
      eta_to_client: "Inconnu",
      eta_to_destination: "Inconnu",
      proposed_price: row.proposed_price,
      status: row.status
    });
  } catch (err) {
    console.error("❌ Erreur resume_details :", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


router.post('/:id/negociation', async (req, res) => {
  const rideId = req.params.id;
  const { from, type, message } = req.body;

  try {
    let formatted = from;

    if (type === 'proposition') {
      formatted += `:${message}`;
    } else if (type === 'dernier') {
      formatted += `:dernier:${message}`;
    } else {
      formatted += `:${type}`; // accepte ou refuse
    }

    const rideRes = await db.query('SELECT discussion FROM rides WHERE id = $1', [rideId]);
    const discussion = rideRes.rows[0]?.discussion || [];

    const lastLine = discussion[discussion.length - 1] || '';
    const lastWasDernier = lastLine.includes(':dernier');
    const lastWasFromOther = !lastLine.startsWith(from);

    let updates = [`discussion = array_append(discussion, $1)`];
    let values = [formatted, rideId];

    if (type === 'refuse' && lastWasDernier && lastWasFromOther) {
      updates.push("status = 'annulee'", "cancelled_by = $2");
      values.push(from);
    }

    await db.query(
      `UPDATE rides SET ${updates.join(', ')} WHERE id = $${values.length}`,
      values
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Erreur négociation :", err);
    res.status(500).json({ error: 'Erreur serveur négociation' });
  }
});

router.get('/:id/negociations', async (req, res) => {
  try {
    const rideId = Number(req.params.id);
    const r = await db.query('SELECT discussion FROM rides WHERE id = $1', [rideId]);
    const raw = r.rows[0]?.discussion || [];
    const list = raw.filter(m => typeof m === 'string' && !m.startsWith('system:'));
    return res.json({ list });
  } catch (e) {
    console.error('GET /:id/negociations error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});







// ✅ IMPORTANT : PAS de /api ni /ride ici, car server.js fait app.use('/api/ride', router)
router.post('/:id/reassign_driver', async (req, res) => {
  const rideId = Number(req.params.id || 0);
  if (!rideId) return res.status(400).json({ error: 'INVALID_RIDE_ID' });

  try {
    const r = await reassignDriverForRide(rideId);
    if (!r.ok) {
      if (r.reason === 'NO_DRIVER_AVAILABLE') return res.status(404).json({ error: r.reason });
      if (r.reason === 'MAX_ATTEMPTS_REACHED') return res.status(409).json({ error: r.reason });
      if (r.reason === 'RIDE_NOT_FOUND') return res.status(404).json({ error: r.reason });
      return res.status(500).json({ error: 'REASSIGN_FAILED' });
    }
    return res.status(200).json({ driver: r.driver });
  } catch (e) {
    console.error('reassign_driver error', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});



async function ensureHandler(req, res) {
  const rideId = Number(req.params.id || 0);
  if (!rideId) return res.status(400).json({ ok:false, error:'INVALID_RIDE_ID' });

  const { radius_m, radii_km, clear_blacklist = false } = req.body || {};
  const opts = {
    radiusM: toInt(radius_m, 0) || undefined,
    radii: Array.isArray(radii_km) ? radii_km : undefined,
    clearBlacklist: !!clear_blacklist,
  };

  const r = await ensureReassignForRide(rideId, opts).catch(e => ({ ok:false, reason:'ENSURE_EXCEPTION' }));
  if (r.ok)         return res.json({ ok:true, searching:false, reason: r.reason || null, reassigned_to: r.driver?.phone || null });
  if (r.searching)  return res.status(202).json({ ok:false, searching:true, reason: r.reason || 'SEARCH_ACTIVE' });
  return res.status(200).json({ ok:false, searching:true, reason: r.reason || 'NO_DRIVER_AVAILABLE' });
}
router.post('/:id/ensure_reassign', ensureHandler);
router.post('/ensure_reassign/:id', ensureHandler);


router.post('/:id/reassign', async (req, res) => {
  const rideId = Number(req.params.id || 0);
  if (!rideId) return res.status(400).json({ ok:false, error:'INVALID_RIDE_ID' });

  const { reactivate = true, radius_m, radii_km, force = false, clear_blacklist = false } = req.body || {};
  if (reactivate === true) {
    await db.query(`UPDATE rides SET reassigning = TRUE WHERE id = $1`, [rideId]).catch(()=>{});
  }

  const opts = {
    radiusM: toInt(radius_m, 0) || undefined,
    radii: Array.isArray(radii_km) ? radii_km : undefined,
    clearBlacklist: !!clear_blacklist,
    force: !!force
  };

  const r = await reassignDriverForRide(rideId, opts).catch(e => ({ ok:false, reason:'REASSIGN_EXCEPTION' }));
  if (r.ok) return res.json({ ok:true, searching:false, reassigned_to: r.driver?.phone || null });

  const reason = String(r.reason || 'NO_DRIVER_AVAILABLE').toUpperCase();
  return res.status(reason === 'NO_DRIVER_AVAILABLE' ? 202 : 200).json({ ok:false, searching:true, reason });
});




module.exports = router;




































