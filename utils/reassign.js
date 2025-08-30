// utils/reassign.js
const db = require('../db');
const { pickNearestDriverAtomicFallback } = require('./driverPicker');
const { setBusyByPhone } = require('./driverFlags'); // déjà proposé plus tôt
const { sendFcm, getDriverFcmTokenByPhone } = require('../utils/fcm');

async function reassignDriverForRide(rideId) {
  // 🔎 on récupère tout ce qu'il faut
  const { rows } = await db.query(`
    SELECT id, origin_lat, origin_lng, driver_phone,
           proposed_price,
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

  // 1) libère l'ancien s'il y en a un
  const oldPhone = ride.driver_phone;
  if (oldPhone) {
    await setBusyByPhone(oldPhone, false); // on_ride=false (available inchangé si tu veux)
  }

  // 2) construit la liste d'exclus
  const exclude = Array.isArray(ride.contacted_driver_phones) ? ride.contacted_driver_phones : [];
  if (oldPhone) exclude.push(oldPhone);

  // 3) cherche un nouveau (multi-rayons) avec un solde minimal logique
  const minSolde = Math.max(ride.proposed_price ?? 0, 3000);
  const driver = await pickNearestDriverAtomicFallback({
    originLat: ride.origin_lat,
    originLng: ride.origin_lng,
    excludePhones: [...new Set(exclude)],
    radii: [3, 6, 10, 15],
    minSolde
  });

  // incrémenter l'attmept quoi qu'il arrive
  await db.query(
    `UPDATE rides SET reassign_attempts = COALESCE(reassign_attempts,0)+1 WHERE id=$1`,
    [rideId]
  );

  if (!driver) {
    // on garde status 'en_attente', driver_phone null; le client voit "recherche..."
    await db.query(`UPDATE rides SET driver_phone = NULL WHERE id = $1`, [rideId]);
    return { ok:false, reason:'NO_DRIVER_AVAILABLE' };
  }

  const updatedExclude = [...new Set([...exclude, driver.phone])];

  // 4) met à jour la course
  await db.query(`
    UPDATE rides
       SET driver_phone = $1,
           status = 'en_attente',
           contacted_driver_phones = $2
     WHERE id = $3
  `, [driver.phone, updatedExclude, rideId]);

  // 5) Notif FCM nouveau chauffeur (best-effort)
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
