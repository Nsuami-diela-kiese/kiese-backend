// utils/reassign.js
const db = require('../db');
const { pickNearestDriverAtomicFallback } = require('./driverPicker'); // ta sélection Haversine multi-rayons
const { setBusyByPhone } = require('./driverFlags'); // cf. patch (A)
const { sendFcm } = require('../utils/fcm');

function getLastClientOffer(discussion, fallback) {
  let last = (fallback ?? 3000);
  if (Array.isArray(discussion)) {
    for (let i = discussion.length - 1; i >= 0; i--) {
      const parts = String(discussion[i]).split(':');
      if (parts[0] === 'client' && /^\d+$/.test(parts[1] || '')) {
        last = parseInt(parts[1], 10);
        break;
      }
    }
  }
  if (!last || last < 3000) last = 3000;
  return last;
}

async function getDriverFcmTokenByPhone(phone) {
  const r = await db.query('SELECT fcm_token FROM drivers WHERE phone=$1', [phone]);
  return r.rows[0]?.fcm_token || null;
}

async function reassignDriverForRide(rideId) {
  console.log(`[reassign] start ride=${rideId}`);
  await db.query('UPDATE rides SET reassigning = TRUE WHERE id=$1', [rideId]).catch(()=>{});

  const r0 = await db.query(`
    SELECT id, origin_lat, origin_lng, driver_phone,
           discussion, proposed_price,
           contacted_driver_phones,
           reassign_attempts, max_reassign_attempts
      FROM rides
     WHERE id = $1::int
  `, [rideId]);

  const ride = r0.rows[0];
  if (!ride) {
    console.log(`[reassign] ride not found ${rideId}`);
    await db.query('UPDATE rides SET reassigning = FALSE WHERE id=$1', [rideId]);
    return { ok:false, reason:'RIDE_NOT_FOUND' };
  }
  if (ride.origin_lat == null || ride.origin_lng == null) {
    console.log(`[reassign] origin missing ${rideId}`);
    await db.query('UPDATE rides SET reassigning = FALSE WHERE id=$1', [rideId]);
    return { ok:false, reason:'ORIGIN_MISSING' };
  }

  const max = ride.max_reassign_attempts ?? 5;
  if ((ride.reassign_attempts ?? 0) >= max) {
    console.log(`[reassign] max attempts reached ride=${rideId}`);
    await db.query('UPDATE rides SET reassigning = FALSE WHERE id=$1', [rideId]);
    return { ok:false, reason:'MAX_ATTEMPTS_REACHED' };
  }

  const oldPhone = ride.driver_phone || null;

  // libère l'ancien chauffeur (doit le remettre available=true)
  if (oldPhone) {
    try {
      await setBusyByPhone(oldPhone, false);
      console.log(`[reassign] freed old driver ${oldPhone}`);
    } catch (e) {
      console.log(`[reassign] free old driver error:`, e.message);
    }
  }

  // exclusion
  const exclude = Array.isArray(ride.contacted_driver_phones) ? [...ride.contacted_driver_phones] : [];
  if (oldPhone) exclude.push(oldPhone);
  const excludeDistinct = [...new Set(exclude)];
  console.log(`[reassign] exclude=${JSON.stringify(excludeDistinct)}`);

  // pick nouveau
  const minSolde = Math.max(ride.proposed_price ?? 0, 3000);
  const driver = await pickNearestDriverAtomicFallback({
    originLat: ride.origin_lat,
    originLng: ride.origin_lng,
    excludePhones: excludeDistinct,
    radii: [3, 6, 10, 15],
    minSolde
  });

  // tenter++ quoi qu'il arrive (mais on reset à 0 si succès)
  await db.query(
    `UPDATE rides SET reassign_attempts = COALESCE(reassign_attempts,0)+1 WHERE id=$1::int`,
    [rideId]
  );

  if (!driver) {
    console.log(`[reassign] NO_DRIVER_AVAILABLE ride=${rideId}`);
    await db.query(`
      UPDATE rides
         SET driver_phone = NULL,
             status = 'en_attente',
             reassigning = FALSE
       WHERE id = $1::int
    `, [rideId]);
    return { ok:false, reason:'NO_DRIVER_AVAILABLE' };
  }

  console.log(`[reassign] picked driver=${driver.phone}`);

  const lastClientAmount = getLastClientOffer(ride.discussion, ride.proposed_price);
  const newDiscussionFirstMsg = `client:${lastClientAmount}`;
  const archiveEntry = {
    driver_phone: oldPhone ?? null,
    messages: Array.isArray(ride.discussion) ? ride.discussion : [],
    ended_at: new Date().toISOString(),
  };

  try {
    await db.query('BEGIN');

    if ((ride.discussion?.length ?? 0) > 0 || oldPhone) {
      await db.query(`
        UPDATE rides
           SET archived_discussions = COALESCE(archived_discussions, '[]'::jsonb)
                                       || ($2::jsonb)
         WHERE id = $1::int
      `, [rideId, JSON.stringify([archiveEntry])]);
    }

    await db.query(`
      UPDATE rides
         SET driver_phone = $1::text,
             status = 'en_attente',
             contacted_driver_phones = (
               SELECT ARRAY(
                 SELECT DISTINCT e
                   FROM unnest(
                          COALESCE(contacted_driver_phones, '{}'::text[])
                          || ARRAY[ ($2)::text ]
                        ) AS e
               )
             ),
             discussion = ARRAY[ ($3)::text ],
             proposed_price = $4::int,
             last_offer_from = NULL,
             client_accepted = TRUE,
             negotiation_status = 'en_attente',
             reassign_attempts = 0,
             reassigning = FALSE
       WHERE id = $5::int
    `, [
      driver.phone,
      driver.phone,
      newDiscussionFirstMsg,
      lastClientAmount,
      rideId
    ]);

    await db.query('COMMIT');
    console.log(`[reassign] committed ride=${rideId} -> new=${driver.phone}`);
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('[reassign] tx error:', e);
    await db.query('UPDATE rides SET reassigning = FALSE WHERE id=$1', [rideId]);
    return { ok:false, reason:'TX_ERROR' };
  }

  // marquer le nouveau indisponible (busy=true => available=false)
  try {
    await setBusyByPhone(driver.phone, true);
    console.log(`[reassign] new driver set busy ${driver.phone}`);
  } catch (e) {
    console.log(`[reassign] set busy error:`, e.message);
  }

  // notif
  try {
    const token = await getDriverFcmTokenByPhone(driver.phone);
    if (token) {
      await sendFcm(
        token,
        { title: '🚗 Nouvelle course', body: `Course #${rideId} en attente` },
        { type: 'new_ride', ride_id: String(rideId) }
      );
      console.log(`[reassign] FCM sent to ${driver.phone}`);
    }
  } catch (e) {
    console.error('[reassign] FCM error:', e);
  }

  return { ok:true, driver };
}

module.exports = { reassignDriverForRide };
