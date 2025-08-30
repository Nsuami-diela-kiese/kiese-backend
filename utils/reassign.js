// utils/reassign.js
const db = require('../db');
const { pickNearestDriverAtomicFallback } = require('./driverPicker');
const { setOnRideByPhone } = require('./driverFlags');  // set on_ride = true/false
const { sendFcm } = require('../utils/fcm');

async function getDriverFcmTokenByPhone(phone) {
  if (!phone) return null;
  const r = await db.query('SELECT fcm_token FROM drivers WHERE phone = $1', [phone]);
  return r.rows[0]?.fcm_token || null;
}

function extractLastClientAmount(discussion, proposed) {
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

  // guard (single-flight)
  const guard = await db.query(`
    UPDATE rides
       SET reassigning = TRUE
     WHERE id = $1
       AND COALESCE(reassigning, FALSE) = FALSE
     RETURNING 1
  `, [rideId]);
  if (guard.rowCount === 0) {
    return { ok: false, reason: 'BUSY' };
  }

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
    const lastClientAmount = extractLastClientAmount(ride.discussion, ride.proposed_price);

    // ++ tentative
    await db.query(
      `UPDATE rides SET reassign_attempts = COALESCE(reassign_attempts,0) + 1 WHERE id = $1`,
      [rideId]
    );

    // libère ancien chauffeur (only on_ride)
    if (oldPhone) {
      try { await setOnRideByPhone(oldPhone, false); } catch (_) {}
    }

    const exclude = Array.isArray(ride.contacted_driver_phones)
      ? [...ride.contacted_driver_phones] : [];
    if (oldPhone) exclude.push(oldPhone);

    const minSolde = Math.max(lastClientAmount, 3000);
    const driver = await pickNearestDriverAtomicFallback({
      originLat: ride.origin_lat,
      originLng: ride.origin_lng,
      excludePhones: [...new Set(exclude)],
      radii: [3, 6, 10, 15],
      minSolde
    });

    // TX : archive + reset + assign (avec casts explicites)
    try {
      await db.query('BEGIN');

      // 1) archive discussion courante
      if ((ride.discussion && ride.discussion.length > 0) || oldPhone) {
        await db.query(`
          UPDATE rides
             SET archived_discussion = archived_discussion
                  || jsonb_build_array(
                       jsonb_build_object(
                         'driver_phone', $2::text,
                         'messages', to_jsonb(COALESCE(discussion, ARRAY[]::text[])),
                         'ended_at', now()
                       )
                     )
           WHERE id = $1
        `, [rideId, oldPhone]);
      }

      const sysMsg  = 'system:driver_refused';
      const seedMsg = `client:${lastClientAmount}`;

      if (!driver) {
        // pas de chauffeur → on sème la négo et on reste en attente
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

      // chauffeur trouvé → assign + union contacted_driver_phones (casts)
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
      `, [driver.phone, sysMsg, seedMsg, lastClientAmount, rideId]);

      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      console.error('reassign tx error:', e);
      return { ok:false, reason:'TX_ERROR' };
    }

    // sécurité : marque le nouveau on_ride = true
    try { await setOnRideByPhone(driver.phone, true); } catch (_) {}

    // notif nouveau chauffeur
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
