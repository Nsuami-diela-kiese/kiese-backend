// utils/reassign.js
const db = require('../db');
const { pickNearestDriverAtomicFallback } = require('./driverPicker');
const { setOnRideByPhone } = require('./driverFlags'); // doit exister: UPDATE drivers SET on_ride=$2 WHERE phone=$1
const { sendFcm } = require('../utils/fcm');

async function getDriverFcmTokenByPhone(phone) {
  if (!phone) return null;
  const r = await db.query('SELECT fcm_token FROM drivers WHERE phone = $1', [phone]);
  return r.rows[0]?.fcm_token || null;
}

// récupère la dernière offre du client, sinon proposed/min3000
function lastClientAmount(discussion, proposed) {
  if (Array.isArray(discussion)) {
    for (let i = discussion.length - 1; i >= 0; i--) {
      const parts = (discussion[i] || '').split(':');
      if (parts[0] === 'client' && /^\d+$/.test(parts[1] || '')) {
        return parseInt(parts[1], 10);
      }
    }
  }
  return Math.max(proposed ?? 0, 3000);
}

async function reassignDriverForRide(rideId) {
  console.log('[reassign] start ride=%s', rideId);

  // single-flight guard
  const guard = await db.query(`
    UPDATE rides
       SET reassigning = TRUE
     WHERE id = $1
       AND COALESCE(reassigning, FALSE) = FALSE
     RETURNING 1
  `, [rideId]);
  if (guard.rowCount === 0) return { ok:false, reason:'BUSY' };

  try {
    const r0 = await db.query(`
      SELECT id, origin_lat, origin_lng,
             driver_phone, discussion, proposed_price,
             contacted_driver_phones,
             reassign_attempts, max_reassign_attempts
      FROM rides WHERE id = $1
    `, [rideId]);
    const ride = r0.rows[0];
    if (!ride) return { ok:false, reason:'RIDE_NOT_FOUND' };
    if (ride.origin_lat == null || ride.origin_lng == null) return { ok:false, reason:'ORIGIN_MISSING' };

    const max = ride.max_reassign_attempts ?? 5;
    if ((ride.reassign_attempts ?? 0) >= max) return { ok:false, reason:'MAX_ATTEMPTS_REACHED' };

    const oldPhone = ride.driver_phone || null;
    const seedAmount = lastClientAmount(ride.discussion, ride.proposed_price);

    // ++ tentative
    await db.query(
      `UPDATE rides SET reassign_attempts = COALESCE(reassign_attempts,0)+1 WHERE id=$1`,
      [rideId]
    );

    // libère ancien chauffeur (on_ride=false)
    if (oldPhone) {
      try { await setOnRideByPhone(oldPhone, false); } catch (_) {}
    }

    // exclus
    const exclude = Array.isArray(ride.contacted_driver_phones) ? [...ride.contacted_driver_phones] : [];
    if (oldPhone) exclude.push(oldPhone);

    // pick
    const driver = await pickNearestDriverAtomicFallback({
      originLat: ride.origin_lat,
      originLng: ride.origin_lng,
      excludePhones: [...new Set(exclude)],
      radii: [3, 6, 10, 15],
      minSolde: Math.max(seedAmount, 3000),
    });

    const sysMsg  = 'system:driver_refused';
    const seedMsg = `client:${seedAmount}`;

    // === TX: archive + reset + assign ===
    try {
      await db.query('BEGIN');

      // 1) archive discussion courante — ❗️pas de $2, on lit driver_phone depuis la ligne
      await db.query(`
        UPDATE rides
           SET archived_discussion = COALESCE(archived_discussion, '[]'::jsonb)
                || jsonb_build_array(
                     jsonb_build_object(
                       'driver_phone', driver_phone::text,
                       'messages', to_jsonb(COALESCE(discussion, ARRAY[]::text[])),
                       'ended_at', now()
                     )
                   )
         WHERE id = $1
      `, [rideId]);

      if (!driver) {
        // aucun chauffeur → on remet en attente, on sème la négo
        await db.query(`
          UPDATE rides
             SET driver_phone = NULL,
                 status = 'en_attente',
                 discussion = ARRAY[$1::text, $2::text],
                 last_offer_from = NULL,
                 client_accepted = TRUE,
                 negotiation_status = 'en_attente'
           WHERE id = $3
        `, [sysMsg, seedMsg, rideId]);

        await db.query('COMMIT');
        console.log('[reassign] none ride=%s', rideId);
        return { ok:false, reason:'NO_DRIVER_AVAILABLE' };
      }

      // chauffeur trouvé → assign + union contacted_driver_phones (casts explicites)
      await db.query(`
        UPDATE rides
           SET driver_phone = $1,
               status = 'en_attente',
               contacted_driver_phones = (
                 SELECT ARRAY(
                   SELECT DISTINCT e
                   FROM unnest(
                     COALESCE(contacted_driver_phones, '{}'::text[]) || ARRAY[$1::text]
                   ) AS e
                 )
               ),
               discussion = ARRAY[$2::text, $3::text],
               proposed_price = $4,
               last_offer_from = NULL,
               client_accepted = TRUE,
               negotiation_status = 'en_attente'
         WHERE id = $5
      `, [driver.phone, sysMsg, seedMsg, seedAmount, rideId]);

      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      console.error('reassign tx error:', e);
      return { ok:false, reason:'TX_ERROR' };
    }

    // marque le nouveau chauffeur on_ride=true
    try { await setOnRideByPhone(driver.phone, true); } catch (_) {}

    // Notif FCM
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

    console.log('[reassign] committed ride=%s -> new=%s', rideId, driver.phone);
    return { ok:true, driver };
  } finally {
    await db.query(`UPDATE rides SET reassigning = FALSE WHERE id = $1`, [rideId]);
  }
}

module.exports = { reassignDriverForRide };
