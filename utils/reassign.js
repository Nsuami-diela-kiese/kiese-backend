// utils/reassign.js
const db = require('../db');
const { pickNearestDriverAtomicFallback } = require('./driverPicker');
let setBusyByPhone; try { ({ setBusyByPhone } = require('./driverFlags')); } catch (_) {}
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
  // signal visuel côté client
  await db.query('UPDATE rides SET reassigning = TRUE WHERE id=$1', [rideId]).catch(() => {});

  // charge la course
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

  // libère l’ancien (best-effort)
  try { if (oldPhone && setBusyByPhone) await setBusyByPhone(oldPhone, false); } catch (_) {}

  // exclure déjà contactés + ancien
  const exclude = Array.isArray(ride.contacted_driver_phones) ? [...ride.contacted_driver_phones] : [];
  if (oldPhone) exclude.push(oldPhone);

  // sélection nouveau chauffeur (multi-rayons + minSolde)
  const minSolde = Math.max(ride.proposed_price ?? 0, 3000);
  const driver = await pickNearestDriverAtomicFallback({
    originLat: ride.origin_lat,
    originLng: ride.origin_lng,
    excludePhones: [...new Set(exclude)],
    radii: [3, 6, 10, 15],
    minSolde
  });

  // compte une tentative, quoi qu’il arrive
  await db.query(
    `UPDATE rides SET reassign_attempts = COALESCE(reassign_attempts,0)+1 WHERE id=$1::int`,
    [rideId]
  );

  if (!driver) {
    // rien trouvé: laisser sans chauffeur mais en attente, et retirer le flag
    await db.query(`
      UPDATE rides
         SET driver_phone = NULL,
             status = 'en_attente',
             reassigning = FALSE
       WHERE id = $1::int
    `, [rideId]);
    return { ok:false, reason:'NO_DRIVER_AVAILABLE' };
  }

  // message de redémarrage de négo
  const lastClientAmount = getLastClientOffer(ride.discussion, ride.proposed_price);
  const newDiscussionFirstMsg = `client:${lastClientAmount}`;

  // construire l’objet d’archive côté Node → $2::jsonb (évite tout 42P18)
  const archiveEntry = {
    driver_phone: oldPhone ?? null,
    messages: Array.isArray(ride.discussion) ? ride.discussion : [],
    ended_at: new Date().toISOString(),
  };

  try {
    await db.query('BEGIN');

    // archiver l’historique si utile
    if ((ride.discussion?.length ?? 0) > 0 || oldPhone) {
      await db.query(`
        UPDATE rides
           SET archived_discussions = COALESCE(archived_discussions, '[]'::jsonb)
                                       || ($2::jsonb)
         WHERE id = $1::int
      `, [rideId, JSON.stringify([archiveEntry])]); // jsonb array
    }

    // assigner le nouveau + réinitialiser la négo
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
             reassigning = FALSE
       WHERE id = $5::int
    `, [
      driver.phone,            // $1
      driver.phone,            // $2 (string dans ARRAY[...])
      newDiscussionFirstMsg,   // $3
      lastClientAmount,        // $4
      rideId                   // $5
    ]);

    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('reassign tx error:', e);
    await db.query('UPDATE rides SET reassigning = FALSE WHERE id=$1', [rideId]);
    return { ok:false, reason:'TX_ERROR' };
  }

  // marquer occupé (optionnel)
  try { if (setBusyByPhone) await setBusyByPhone(driver.phone, true); } catch (_) {}

  // notifier le nouveau chauffeur (best-effort)
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
