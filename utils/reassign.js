// utils/reassign.js
const db = require('../db');
const { pickNearestDriverAtomicFallback } = require('./driverPicker');
let setBusyByPhone;
try { ({ setBusyByPhone } = require('./driverFlags')); } catch (_) {}
const { sendFcm } = require('../utils/fcm');

// Récupère le dernier montant proposé par le client (fallback 3000)
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
  // Sécurise l’UI côté client
  await db.query('UPDATE rides SET reassigning = TRUE WHERE id=$1', [rideId]).catch(()=>{});

  // Charge la course
  const r0 = await db.query(`
    SELECT id, origin_lat, origin_lng, driver_phone,
           discussion, proposed_price,
           contacted_driver_phones,
           reassign_attempts, max_reassign_attempts
    FROM rides
    WHERE id = $1
  `, [rideId]);
  const ride = r0.rows[0];
  if (!ride) {
    await db.query('UPDATE rides SET reassigning = FALSE WHERE id=$1', [rideId]);
    return { ok:false, reason:'RIDE_NOT_FOUND' };
  }
  if (ride.origin_lat == null || ride.origin_lng == null) {
    await db.query('UPDATE rides SET reassigning = FALSE WHERE id=$1', [rideId]);
    return { ok:false, reason:'ORIGIN_MISSING' };
  }

  const max = ride.max_reassign_attempts ?? 5;
  if ((ride.reassign_attempts ?? 0) >= max) {
    await db.query('UPDATE rides SET reassigning = FALSE WHERE id=$1', [rideId]);
    return { ok:false, reason:'MAX_ATTEMPTS_REACHED' };
  }

  const oldPhone = ride.driver_phone || null;
  const exclude = Array.isArray(ride.contacted_driver_phones)
    ? [...ride.contacted_driver_phones]
    : [];
  if (oldPhone) exclude.push(oldPhone);

  const minSolde = Math.max(ride.proposed_price ?? 0, 3000);
  const driver = await pickNearestDriverAtomicFallback({
    originLat: ride.origin_lat,
    originLng: ride.origin_lng,
    excludePhones: [...new Set(exclude)],
    radii: [3, 6, 10, 15],
    minSolde
  });

  // Compte la tentative (qu’elle réussisse ou pas)
  await db.query(
    `UPDATE rides SET reassign_attempts = COALESCE(reassign_attempts,0)+1 WHERE id=$1`,
    [rideId]
  );

  if (!driver) {
    await db.query(`
      UPDATE rides
         SET driver_phone = NULL,
             status = 'en_attente',
             reassigning = FALSE
       WHERE id = $1
    `, [rideId]);
    return { ok:false, reason:'NO_DRIVER_AVAILABLE' };
  }

  const lastClientAmount = getLastClientOffer(ride.discussion, ride.proposed_price);
  const newDiscussionFirstMsg = `client:${lastClientAmount}`;

  try {
    await db.query('BEGIN');

    // Archive l’ancienne discussion (COALESCE impératif)
    if ((ride.discussion?.length ?? 0) > 0 || oldPhone) {
      await db.query(`
        UPDATE rides
           SET archived_discussions = COALESCE(archived_discussions, '[]'::jsonb)
               || jsonb_build_array(
                    jsonb_build_object(
                      'driver_phone', $2,
                      'messages', to_jsonb(COALESCE(discussion, ARRAY[]::text[])),
                      'ended_at', now()
                    )
                  )
         WHERE id = $1
      `, [rideId, oldPhone]);
    }

    // 👉👉 CAST explicite pour $2 : ARRAY[$2]::text[]
    await db.query(`
      UPDATE rides
         SET driver_phone = $1,
             status = 'en_attente',
             contacted_driver_phones = (
               SELECT ARRAY(
                 SELECT DISTINCT e
                 FROM unnest(
                        COALESCE(contacted_driver_phones,'{}'::text[])
                        || ARRAY[$2]::text[]
                      ) AS e
               )
             ),
             discussion = ARRAY[$3]::text[],
             proposed_price = $4,
             last_offer_from = NULL,
             client_accepted = TRUE,
             negotiation_status = 'en_attente',
             reassigning = FALSE
       WHERE id = $5
    `, [
      driver.phone,                 // $1
      driver.phone,                 // $2 (string) → ARRAY[$2]::text[]
      newDiscussionFirstMsg,        // $3
      lastClientAmount,             // $4
      rideId                        // $5
    ]);

    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('reassign tx error:', e);
    await db.query('UPDATE rides SET reassigning = FALSE WHERE id=$1', [rideId]);
    return { ok:false, reason:'TX_ERROR' };
  }

  // Réserver le nouveau chauffeur (best-effort)
  try { if (setBusyByPhone) await setBusyByPhone(driver.phone, true); } catch (_) {}

  // Notifier le nouveau chauffeur (best-effort)
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
