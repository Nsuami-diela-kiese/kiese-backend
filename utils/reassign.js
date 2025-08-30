// utils/reassign.js
const db = require('../db');
const { pickNearestDriverAtomicFallback } = require('./driverPicker');
const { setBusyByPhone } = require('./driverFlags'); // si absent, garde le try/catch
const { sendFcm } = require('../utils/fcm');
const { getLastClientOffer } = require('./negotiation'); // doit exister

// helper local FCM token
async function getDriverFcmTokenByPhone(phone) {
  if (!phone) return null;
  const r = await db.query('SELECT fcm_token FROM drivers WHERE phone = $1', [phone]);
  return r.rows[0]?.fcm_token || null;
}

async function reassignDriverForRide(rideId) {
  // 1) Charger la course
  const { rows } = await db.query(`
    SELECT id, origin_lat, origin_lng,
           driver_phone, discussion, proposed_price,
           contacted_driver_phones,
           reassign_attempts, max_reassign_attempts
    FROM rides
    WHERE id = $1
  `, [rideId]);

  const ride = rows[0];
  if (!ride) return { ok:false, reason:'RIDE_NOT_FOUND' };
  if (ride.origin_lat == null || ride.origin_lng == null) return { ok:false, reason:'ORIGIN_MISSING' };

  const max = ride.max_reassign_attempts ?? 5;
  if ((ride.reassign_attempts ?? 0) >= max) return { ok:false, reason:'MAX_ATTEMPTS_REACHED' };

  const oldPhone = ride.driver_phone || null;

  // 2) Libérer l’ancien chauffeur (best-effort)
  if (oldPhone) {
    try { await setBusyByPhone(oldPhone, false); } catch (_) {}
    try { await db.query(`UPDATE drivers SET available = TRUE WHERE phone = $1`, [oldPhone]); } catch (_) {}
  }

  // 3) Construire la liste d’exclus
  const exclude = Array.isArray(ride.contacted_driver_phones) ? [...ride.contacted_driver_phones] : [];
  if (oldPhone) exclude.push(oldPhone);

  // 4) Chercher un nouveau chauffeur (multi-rayons + minSolde)
  const minSolde = Math.max(ride.proposed_price ?? 0, 3000);
  const driver = await pickNearestDriverAtomicFallback({
    originLat: ride.origin_lat,
    originLng: ride.origin_lng,
    excludePhones: [...new Set(exclude)],
    radii: [3, 6, 10, 15],
    minSolde
  });

  // 5) Incrémenter la tentative quoi qu’il arrive
  await db.query(
    `UPDATE rides SET reassign_attempts = COALESCE(reassign_attempts,0)+1 WHERE id=$1`,
    [rideId]
  );

  // 6) Si rien trouvé : rester en attente sans chauffeur
  if (!driver) {
    await db.query(`UPDATE rides SET driver_phone = NULL, status = 'en_attente' WHERE id = $1`, [rideId]);
    return { ok:false, reason:'NO_DRIVER_AVAILABLE' };
  }

  // 7) Dernière offre client → redémarrage propre
  const lastClientAmount = getLastClientOffer(ride.discussion, ride.proposed_price);
  const newDiscussionFirstMsg = `client:${lastClientAmount}`;

  // 8) Transaction : archiver + assigner + reset négo + cumuler contacted_driver_phones
  try {
    await db.query('BEGIN');

    if ((ride.discussion && ride.discussion.length > 0) || oldPhone) {
      await db.query(
        `UPDATE rides
            SET archived_discussions = archived_discussions
                || jsonb_build_array(
                     jsonb_build_object(
                       'driver_phone', $2,
                       'messages', to_jsonb(COALESCE(discussion, ARRAY[]::text[])),
                       'ended_at', now()
                     )
                   )
         WHERE id = $1`,
        [rideId, oldPhone]
      );
    }

    await db.query(
      `UPDATE rides
          SET driver_phone = $1,
              status = 'en_attente',
              contacted_driver_phones = (
                SELECT ARRAY(
                  SELECT DISTINCT e
                  FROM unnest( COALESCE(contacted_driver_phones, '{}')::text[] || $2::text[] ) AS e
                )
              ),
              discussion = ARRAY[$3]::text[],
              proposed_price = $4,
              last_offer_from = NULL,
              client_accepted = TRUE,
              negotiation_status = 'en_attente'
        WHERE id = $5`,
      [
        driver.phone,
        [driver.phone],
        newDiscussionFirstMsg,   // "client:<montant>"
        lastClientAmount,
        rideId,
      ]
    );

    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('reassign tx error:', e);
    return { ok:false, reason:'TX_ERROR' };
  }

  // 9) Réserver le nouveau chauffeur (best-effort)
  try { await setBusyByPhone(driver.phone, true); } catch (_) {}
  try { await db.query(`UPDATE drivers SET available = FALSE WHERE phone = $1`, [driver.phone]); } catch (_) {}

  // 10) Notifier le nouveau chauffeur
  try {
    const token = await getDriverFcmTokenByPhone(driver.phone);
    if (token) {
      await sendFcm(
        token,
        { title: '🚗 Nouvelle course', body: `Course #${rideId} en attente` },
        { type: 'new_ride', ride_id: String(rideId) }
      );
    }
  } catch (e) {
    console.error('reassign FCM error:', e);
  }

  return { ok:true, driver };
}

module.exports = { reassignDriverForRide };
