const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');



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
      'SELECT status FROM rides WHERE id = $1',
      //[rideId]
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course introuvable' });
    }

    res.json({ status: result.rows[0].status });
  } catch (err) {
    console.error(err);
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
      SET confirmed_price = proposed_price,
          negotiation_status = 'confirmee', status='course_acceptee'
      WHERE id = $1
      RETURNING *;
    `, [rideId]);

    res.json({ success: true, ride: result.rows[0] });
  } catch (err) {
    console.error(err);
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
        driver_phone, proposed_price,
        status
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
        SELECT name, plaque, couleur, photo, phone
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
          photo: d.photo
        };
      }
    }

    res.json({
      origin_lat: ride.origin_lat,
      origin_lng: ride.origin_lng,
      destination_lat: ride.destination_lat,
      destination_lng: ride.destination_lng,
      status: ride.status,
      proposed_price: ride.proposed_price,
      driver: driver // 🟢 Ceci est essentiel pour ResumeChauffeurAConfirmer
    });
  } catch (e) {
    console.error("❌ Erreur ride/:id/details", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});



// ?? R�cup�rer la discussion tarifaire
router.get('/:id/discussion', async (req, res) => {
  const rideId = req.params.id;

  try {
    const result = await db.query(
      'SELECT discussion FROM rides WHERE id = $1',
      [rideId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course non trouv�e' });
    }

    res.json({ discussion: result.rows[0].discussion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lecture discussion' });
  }
});
// ? Ajouter une offre ou message dans la discussion
router.post('/:id/discussion', async (req, res) => {
  const rideId = req.params.id;
  const { from, amount } = req.body;
  const message = `${from}:${amount}`;

  try {
    // Ajoute le message dans la discussion
    await db.query(
      'UPDATE rides SET discussion = array_append(discussion, $1) WHERE id = $2',
      [message, rideId]
    );

    // Met � jour proposed_price peu importe l'origine
    await db.query(
      'UPDATE rides SET proposed_price = $1, negotiation_status = \'en_attente\' WHERE id = $2',
      [amount, rideId]
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur discussion/prix' });
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
    // S�lection du chauffeur disponible le plus proche
    const chauffeurRes = await db.query(
      "SELECT phone, lat, lng FROM drivers WHERE available = true AND last_seen > NOW() - INTERVAL '10 minutes' AND solde >= 3000 ORDER BY SQRT(POWER(lat - $1, 2) + POWER(lng - $2, 2)) ASC LIMIT 1",
      [origin_lat, origin_lng]
    );

    if (chauffeurRes.rows.length === 0) {
      return res.status(404).json({ error: 'Aucun chauffeur disponible' });
    }

    const chauffeur = chauffeurRes.rows[0];

    // Appel � l'API Google Distance Matrix
    /*const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const distUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${chauffeur.lat},${chauffeur.lng}&destinations=${origin_lat},${origin_lng}|${destination_lat},${destination_lng}&key=${GOOGLE_API_KEY}`;
    */
   const API_KEY = 'AIzaSyCvTmYQegyHQDU4UJ0PlkRu8RjBs8PeT48'; // remplace ici ta vraie clé directement
  const distUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=...&key=${API_KEY}`;

    const distResponse = await axios.get(distUrl);
    console.log("📦 Google Distance response:", distResponse.data);
    if (!distResponse.data.rows || !distResponse.data.rows[0] || !distResponse.data.rows[0].elements) {
  return res.status(500).json({ error: 'Réponse Distance Matrix invalide', raw: distResponse.data });
}
    const elements = distResponse.data.rows[0].elements;

    const etaToClient = elements[0].duration.text;
    const etaToDestination = elements[1].duration.text;

    // Cr�ation de la course
    const insertRes = await db.query(`
      INSERT INTO rides (
        client_name, client_phone,
        origin_lat, origin_lng,
        destination_lat, destination_lng,
        driver_phone, status, negotiation_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'en_attente', 'en_attente')
      RETURNING id
    `, [
      client_name, client_phone,
      origin_lat, origin_lng,
      destination_lat, destination_lng,
      chauffeur.phone
    ]);

    res.status(201).json({
      ride_id: insertRes.rows[0].id,
      driver_phone: chauffeur.driver_phone,
      driver_lat: chauffeur.lat,
      driver_lng: chauffeur.lng,
      eta_to_client: etaToClient,
      eta_to_destination: etaToDestination
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur cr�ation course' });
  }
});



router.post('/:id/cancel', async (req, res) => {
  const rideId = req.params.id;
  await db.query("UPDATE rides SET status = 'annulee' WHERE id = $1", [rideId]);
  res.json({ success: true });
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
    `, [route, commission, rideId]);

    // Déduire du solde du chauffeur
    await db.query(`
      UPDATE drivers
      SET solde = solde - $1
      WHERE phone = $2
    `, [commission, driverId]);

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
      "SELECT phone, name, lat, lng, plaque, couleur, photo FROM drivers WHERE available = true AND last_seen > NOW() - INTERVAL '10 minutes' AND solde >= 3000 ORDER BY SQRT(POWER(lat - $1, 2) + POWER(lng - $2, 2)) ASC LIMIT 1",
      [origin_lat, origin_lng]
    );

    if (chauffeurRes.rows.length === 0) {
      return res.status(404).json({ error: 'Aucun chauffeur disponible' });
    }

    const chauffeur = chauffeurRes.rows[0];

    const distUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${chauffeur.lat},${chauffeur.lng}&destinations=${origin_lat},${origin_lng}|${destination_lat},${destination_lng}&key=AIzaSyCvTmYQegyHQDU4UJ0PlkRu8RjBs8PeT48`;
    const distResponse = await axios.get(distUrl);
    const elements = distResponse.data.rows?.[0]?.elements;

    if (!elements || elements.length < 2) {
      return res.status(500).json({
        error: 'Réponse Distance Matrix invalide',
        data: distResponse.data
      });
    }

    const etaToClient = elements[0]?.duration?.text || 'inconnu';
    const etaToDestination = elements[1]?.duration?.text || 'inconnu';

    const insertRes = await db.query(
      `INSERT INTO rides (
        client_name, client_phone,
        origin_lat, origin_lng,
        destination_lat, destination_lng,
        driver_phone, proposed_price, status, negotiation_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'en_attente', 'en_attente')
      RETURNING id`,
      [
        client_name, client_phone,
        origin_lat, origin_lng,
        destination_lat, destination_lng,
        chauffeur.phone, proposed_price
      ]
    );
    await db.query(
    "UPDATE rides SET discussion = array_append(discussion, $1) WHERE id = $2",
    [`client:${proposed_price}`, insertRes.rows[0].id]
    );

    res.status(201).json({
      ride_id: insertRes.rows[0].id,
      driver: {
        phone: chauffeur.phone,
        name: chauffeur.name,
        lat: chauffeur.lat,
        lng: chauffeur.lng,
        plaque: chauffeur.plaque,
        couleur: chauffeur.couleur,
        photo: chauffeur.photo
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
             r.proposed_price, d.name, d.plaque, d.couleur, d.photo,
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



module.exports = router;
