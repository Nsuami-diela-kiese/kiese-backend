require('dotenv').config();
const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const { sendFcm } = require('../utils/fcm'); // 🔔 FCM Admin
const { reassignDriverForRide } = require('../utils/reassign');

// petit helper pour récupérer le token FCM du chauffeur
async function getDriverFcmTokenByPhone(phone) {
  if (!phone) return null;
  const r = await db.query('SELECT fcm_token FROM drivers WHERE phone=$1', [phone]);
  return r.rows[0]?.fcm_token || null;
}

router.get('/__ping', (req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

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
  const rideId = req.params.id;

  try {
    const result = await db.query(`
      SELECT
        origin_lat, origin_lng,
        destination_lat, destination_lng,
        driver_phone,
        proposed_price,
        confirmed_price,
        negotiation_status,
        cancelled_by,
        status,
        client_accepted  -- ✅ ajouter ceci
      FROM rides
      WHERE id = $1
    `, [rideId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Course introuvable" });
    }

    const ride = result.rows[0];
    let driver = null;

    if (ride.driver_phone) {
      const driverRes = await db.query(`
        SELECT name, plaque, couleur, photo, phone, lat, lng, marque, modele
        FROM drivers
        WHERE phone = $1
      `, [ride.driver_phone]);

      if (driverRes.rows.length > 0) {
        const d = driverRes.rows[0];
        driver = {
          phone: d.phone,
          name: d.name,
          plaque: d.plaque,
          couleur: d.couleur,
          photo: d.photo,
          lat: d.lat,
          lng: d.lng,
          marque: d.marque,
          modele: d.modele
        };
      }
    }

    res.json({
      origin_lat: ride.origin_lat,
      origin_lng: ride.origin_lng,
      destination_lat: ride.destination_lat,
      destination_lng: ride.destination_lng,
      status: ride.status,
      negotiation_status: ride.negotiation_status,
      proposed_price: ride.proposed_price,
      confirmed_price: ride.confirmed_price,
      cancelled_by: ride.cancelled_by,
      client_accepted: ride.client_accepted,  // ✅ ici aussi
      driver: driver
    });
  } catch (e) {
    console.error("❌ Erreur ride/:id/details", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});




// ?? R�cup�rer la discussion tarifaire
router.post('/:id/discussion', async (req, res) => {
  const rideId = req.params.id;
  const body = req.body;

  console.log('🟢 BODY REÇU :', body);

  if (!body || !body.from || !body.type) {
    return res.status(400).json({ error: 'Corps invalide ou manquant', received: body });
  }

  const { from, amount, type } = body;

  try {
    let message = `${from}:${amount ?? ''}`;

    if (type === 'last_offer') {
      message += ':last_offer';
      await db.query(
        `UPDATE rides SET last_offer_from = $1, last_offer_value = $2 WHERE id = $3`,
        [from, amount ?? null, rideId]
      );
    } else if (type === 'accept') {
      message += ':accepted';
      if (from === 'client') {
        await db.query(`UPDATE rides SET client_accepted = true WHERE id = $1`, [rideId]);
      }
    } else if (type === 'refuse') {
      // Lire état utile
      const r0 = await db.query(
        `SELECT last_offer_from, discussion, driver_phone, contacted_driver_phones
           FROM rides WHERE id = $1`,
        [rideId]
      );
      const row = r0.rows[0] || {};
      const lastOfferFrom = row.last_offer_from;
      const discussion = row.discussion || [];
      const lastMsg = discussion.length > 0 ? discussion[discussion.length - 1] : '';
      const lastWasLastOffer = lastMsg.includes(':last_offer');
      const currDriver = row.driver_phone || null;
      const contacted = row.contacted_driver_phones || [];

      message += ':refused';

      // Si le chauffeur refuse → on réassigne immédiatement
      if (from === 'chauffeur') {
        // (trace) si refus d’une "dernière offre" opposée
        if (lastOfferFrom && lastWasLastOffer && lastOfferFrom !== from) {
          await db.query(
            `UPDATE rides SET cancel_reason = 'chauffeur_refuse_last_offer' WHERE id = $1`,
            [rideId]
          );
        }

        // Exclure le chauffeur courant
        const updatedExclude = currDriver
          ? Array.from(new Set([...contacted, currDriver]))
          : contacted;

        // Remettre en attente et libérer le chauffeur
        await db.query(
          `UPDATE rides
              SET status = 'en_attente',
                  driver_phone = NULL,
                  contacted_driver_phones = $2
            WHERE id = $1`,
          [rideId, updatedExclude]
        );

        // Réassigner
        const r = await reassignDriverForRide(Number(rideId));
        if (!r.ok) {
          // Persister le message puis signaler qu'il n'y a personne
          await db.query(
            `UPDATE rides SET discussion = array_append(discussion, $1) WHERE id = $2`,
            [message, rideId]
          );
          return res.status(404).json({ error: r.reason || 'NO_DRIVER_AVAILABLE' });
        }

        // Notifier le nouveau chauffeur
        try {
          const tokNew = await fcm.getDriverFcmTokenByPhone(r.driver.phone);
          if (tokNew) {
            await fcm.sendFcm(
              tokNew,
              { title: '🚗 Nouvelle course', body: 'Une course vous a été assignée.' },
              { type: 'new_ride', ride_id: String(rideId) }
            );
          }
        } catch (e) {
          console.error('Notif new driver after refuse:', e);
        }

        // Enregistrer le message puis répondre avec le nouveau driver
        await db.query(
          `UPDATE rides SET discussion = array_append(discussion, $1) WHERE id = $2`,
          [message, rideId]
        );
        return res.json({ success: true, reassign: true, driver: r.driver });
      }

      // Cas "client refuse" : on garde juste la trace (ta logique existante)
      if (lastOfferFrom && lastWasLastOffer && lastOfferFrom !== from) {
        await db.query(
          `UPDATE rides SET status = 'annulee', cancelled_by = $1 WHERE id = $2`,
          [from, rideId]
        );
      }
    }

    // Enregistrer le message dans tous les autres cas
    await db.query(
      `UPDATE rides SET discussion = array_append(discussion, $1) WHERE id = $2`,
      [message, rideId]
    );

    // Mettre à jour le prix proposé (sauf accept/refuse)
    if (type !== 'accept' && type !== 'refuse' && amount) {
      await db.query(
        `UPDATE rides SET proposed_price = $1 WHERE id = $2`,
        [amount, rideId]
      );
    }

    // Logique client_accepted comme avant
    if (from === 'client' && (type === 'normal' || type === 'last_offer' || type === 'accept')) {
      await db.query(`UPDATE rides SET client_accepted = true WHERE id = $1`, [rideId]);
    }
    if (from === 'chauffeur' && (type === 'normal' || type === 'last_offer')) {
      await db.query(`UPDATE rides SET client_accepted = false WHERE id = $1`);
    }

    // Notifier uniquement l'AUTRE partie (ta logique existante côté chauffeur)
    try {
      const rideIdNum = Number(rideId);
      if (from === 'client') {
        const r1 = await db.query('SELECT driver_phone FROM rides WHERE id=$1', [rideIdNum]);
        const driverPhone = r1.rows[0]?.driver_phone;
        const token = await fcm.getDriverFcmTokenByPhone(driverPhone);
        if (token) {
          await fcm.sendFcm(
            token,
            {
              title: '💬 Nouvelle proposition',
              body: (amount ? `Le client a proposé ${amount} CDF` : 'Mise à jour de la négociation'),
            },
            { type: 'nego_update', ride_id: String(rideIdNum), sender: 'client' }
          );
        }
      }
      // (Plus tard: notif côté client si tu stockes son fcm_token)
    } catch (e) {
      console.error('Notif nego_update:', e);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('❌ Erreur discussion:', e);
    res.status(500).json({ error: 'Erreur serveur' });
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
router.post('/create_auto', async (req, res) => {
  const {
    client_name,
    client_phone,
    origin_lat,
    origin_lng,
    destination_lat,
    destination_lng
  } = req.body;

  try {
    const chauffeurRes = await db.query(
      "SELECT phone, lat, lng FROM drivers WHERE available = true AND solde >= 3000 ORDER BY SQRT(POWER(lat - $1, 2) + POWER(lng - $2, 2)) ASC LIMIT 1",
      [origin_lat, origin_lng]
    );

    if (chauffeurRes.rows.length === 0) {
      return res.status(404).json({ error: 'Aucun chauffeur disponible' });
    }

    const chauffeur = chauffeurRes.rows[0];
    const montantPropose = 3000;
    const messageInitial = `client:${montantPropose}`;

    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    const distUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${chauffeur.lat},${chauffeur.lng}&destinations=${origin_lat},${origin_lng}|${destination_lat},${destination_lng}&key=${API_KEY}`;

    const distResponse = await axios.get(distUrl);
    const elements = distResponse.data.rows?.[0]?.elements;

    if (!elements || elements.length < 2) {
      return res.status(500).json({ error: 'Réponse Distance Matrix invalide', data: distResponse.data });
    }

    const etaToClient = elements[0].duration.text;
    const etaToDestination = elements[1].duration.text;

    const insertRes = await db.query(`
      INSERT INTO rides (
        client_name, client_phone,
        origin_lat, origin_lng,
        destination_lat, destination_lng,
        driver_phone, proposed_price,
        discussion, client_accepted,
        status, negotiation_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ARRAY[$9], true, 'en_attente', 'en_attente')
      RETURNING id
    `, [
      client_name, client_phone,
      origin_lat, origin_lng,
      destination_lat, destination_lng,
      chauffeur.phone,
      montantPropose,
      messageInitial
    ]);

    res.status(201).json({
      ride_id: insertRes.rows[0].id,
      driver_phone: chauffeur.phone,
      driver_lat: chauffeur.lat,
      driver_lng: chauffeur.lng,
      eta_to_client: etaToClient,
      eta_to_destination: etaToDestination
    });
  } catch (err) {
    console.error("❌ Erreur create_auto :", err);
    res.status(500).json({ error: 'Erreur serveur création course', details: err.message });
  }
});


const db = require('../db');
const { reassignDriverForRide } = require('../utils/reassign');
const { sendFcm, getDriverFcmTokenByPhone } = require('../utils/fcm');

router.post('/:id/cancel', async (req, res) => {
  const rideId = Number(req.params.id);
  const by = String(req.body?.by || '').toLowerCase();

  if (!rideId) return res.status(400).json({ error: 'INVALID_RIDE_ID' });

  try {
    const r0 = await db.query(
      `SELECT driver_phone, reassign_on_cancel, contacted_driver_phones
         FROM rides WHERE id = $1`,
      [rideId]
    );
    const ride = r0.rows[0];
    if (!ride) return res.status(404).json({ error: 'RIDE_NOT_FOUND' });

    const prevDriver = ride.driver_phone || null;

    // Notifier l'ancien chauffeur que la course est annulée (comportement existant)
    if (prevDriver) {
      try {
        const tokPrev = await fcm.getDriverFcmTokenByPhone(prevDriver);
        if (tokPrev) {
          await fcm.sendFcm(
            tokPrev,
            { title: '❌ Course annulée', body: 'La course a été annulée' },
            { type: 'status_update', ride_id: String(rideId) }
          );
        }
      } catch (e) {
        console.error('Notif cancel (prev driver):', e);
      }
    }

    if (ride.reassign_on_cancel) {
      const updatedExclude = prevDriver
        ? Array.from(new Set([...(ride.contacted_driver_phones || []), prevDriver]))
        : (ride.contacted_driver_phones || []);

      // Remettre la course en attente + exclure l’ancien chauffeur
      await db.query(
        `UPDATE rides
            SET status = 'en_attente',
                driver_phone = NULL,
                cancel_reason = $2,
                contacted_driver_phones = $3
          WHERE id = $1`,
        [rideId, by || null, updatedExclude]
      );

      // Réassignation immédiate
      const r = await reassignDriverForRide(rideId);
      if (!r.ok) {
        return res.status(404).json({ error: r.reason || 'NO_DRIVER_AVAILABLE' });
      }

      // Notifier le nouveau chauffeur
      try {
        const tokNew = await fcm.getDriverFcmTokenByPhone(r.driver.phone);
        if (tokNew) {
          await fcm.sendFcm(
            tokNew,
            { title: '🚗 Nouvelle course', body: 'Une course vous a été assignée.' },
            { type: 'new_ride', ride_id: String(rideId) }
          );
        }
      } catch (e) {
        console.error('Notif new driver after cancel:', e);
      }

      return res.json({ ok: true, driver: r.driver });
    }

    // Sinon: annulation "finale" (legacy)
    await db.query(
      `UPDATE rides SET status='annulee', cancel_reason=$2 WHERE id=$1`,
      [rideId, by || null]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error('cancel error', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ? Terminer une course


router.post('/:id/finish', async (req, res) => {
  const rideId = req.params.id;
  const { route } = req.body;
if (!route) return res.status(400).json({ error: "Route manquante" });
  try {
    // Récupérer le montant confirmé
    const priceRes = await db.query("SELECT confirmed_price, driver_phone FROM rides WHERE id = $1", [rideId]);
    if (priceRes.rows.length === 0) {
      return res.status(404).json({ error: "Course introuvable" });
    }

    const confirmedPrice = priceRes.rows[0].confirmed_price || 0;
    const driverId = priceRes.rows[0].driver_phone;

    const commission = Math.floor(confirmedPrice * 0.15);
    const soldeNet = confirmedPrice - commission;

    // Mettre à jour la course
    await db.query(`
      UPDATE rides
      SET status = 'terminee',
          finished_at = NOW(),
          route = $1,
          commission = $2
      WHERE id = $3
    `, [JSON.stringify(route), commission, rideId]);

    // Déduire du solde du chauffeur
    await db.query(`
      UPDATE drivers
      SET solde = solde - $1
      WHERE phone = $2
    `, [commission, driverId]);

    try {
  const rideIdNum = Number(rideId);
  const r = await db.query('SELECT driver_phone FROM rides WHERE id=$1', [rideIdNum]);
  const token = await getDriverFcmTokenByPhone(r.rows[0]?.driver_phone);
  if (token) {
    await sendFcm(
      token,
      { title: '✅ Course terminée', body: 'Merci pour votre conduite' },
      { type: 'status_update', ride_id: String(rideIdNum) }
    );
  }
} catch (e) {
  console.error('Notif finish:', e);
}


    res.json({ success: true, commission });
  } catch (e) {
    console.error("Erreur finish :", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});



router.post('/create_negociation', async (req, res) => {
  const {
    client_name,
    client_phone,
    origin_lat,
    origin_lng,
    destination_lat,
    destination_lng,
    proposed_price
  } = req.body;

  try {
    const chauffeurRes = await db.query(
      "SELECT phone, name, lat, lng, plaque, couleur, photo, marque, modele FROM drivers WHERE available = true AND solde >= 3000 ORDER BY SQRT(POWER(lat - $1, 2) + POWER(lng - $2, 2)) ASC LIMIT 1",
      [origin_lat, origin_lng]
    );

    if (chauffeurRes.rows.length === 0) {
      return res.status(404).json({ error: 'Aucun chauffeur disponible' });
    }

    const chauffeur = chauffeurRes.rows[0];
    const messageInitial = `client:${proposed_price}`;

    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    const distUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${chauffeur.lat},${chauffeur.lng}&destinations=${origin_lat},${origin_lng}|${destination_lat},${destination_lng}&key=${API_KEY}`;
    const distResponse = await axios.get(distUrl);
    const elements = distResponse.data.rows?.[0]?.elements;

    if (!elements || elements.length < 2) {
      return res.status(500).json({ error: 'Réponse Distance Matrix invalide', data: distResponse.data });
    }

    const etaToClient = elements[0]?.duration?.text || 'inconnu';
    const etaToDestination = elements[1]?.duration?.text || 'inconnu';

    const insertRes = await db.query(
      `INSERT INTO rides (
        client_name, client_phone,
        origin_lat, origin_lng,
        destination_lat, destination_lng,
        driver_phone, proposed_price,
        discussion, client_accepted,
        status, negotiation_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ARRAY[$9], true, 'en_attente', 'en_attente')
      RETURNING id`,
      [
        client_name, client_phone,
        origin_lat, origin_lng,
        destination_lat, destination_lng,
        chauffeur.phone, proposed_price,
        messageInitial
      ]
    );

    try {
  const rideId = insertRes.rows[0].id;
  const token = await getDriverFcmTokenByPhone(chauffeur.phone);
  if (token) {
    await sendFcm(
      token,
      { title: '🚗 Nouvelle course', body: 'Un client attend votre réponse' },
      { type: 'new_ride', ride_id: String(rideId) } // 👈 data que lit l’app chauffeur
    );
  }
} catch (e) {
  console.error('Notif new_ride (create_negociation):', e);
}


    res.status(201).json({
      ride_id: insertRes.rows[0].id,
      driver: {
        phone: chauffeur.phone,
        name: chauffeur.name,
        lat: chauffeur.lat,
        lng: chauffeur.lng,
        plaque: chauffeur.plaque,
        couleur: chauffeur.couleur,
        photo: chauffeur.photo,
        marque: chauffeur.marque,
        modele: chauffeur.modele
      },
      eta_to_client: etaToClient,
      eta_to_destination: etaToDestination,
      status: 'en_attente'
    });
  } catch (err) {
    console.error("❌ Erreur backend :", err);
    res.status(500).json({ error: 'Erreur serveur création négociation', details: err.message });
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
  const rideId = req.params.id;

  try {
    const result = await db.query(
      'SELECT discussion FROM rides WHERE id = $1',
      [rideId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course introuvable' });
    }

    res.json(result.rows[0].discussion || []);
  } catch (err) {
    console.error("❌ Erreur récupération discussion :", err);
    res.status(500).json({ error: 'Erreur serveur négociation' });
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






module.exports = router;






