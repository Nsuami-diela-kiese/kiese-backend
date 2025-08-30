// utils/reassign.js
const db = require('../db');
const { pickNearestDriverAtomicFallback } = require('./driverPicker');
const { setOnRideByPhone } = require('./driverFlags');
const { sendFcm } = require('../utils/fcm');

async function getDriverFcmTokenByPhone(phone) {
  if (!phone) return null;
  const r = await db.query('SELECT fcm_token FROM drivers WHERE phone=$1', [phone]);
  return r.rows[0]?.fcm_token || null;
}

async function reassignDriverForRide(rideId) {
  console.log('[reassign] start ride=%s', rideId);

  // 🔒 acquire guard (single-flight)
  const guard = await db.query(`
    UPDATE rides
       SET reassigning = TRUE
     WHERE id = $1
       AND COALESCE(reassigning, FALSE) = FALSE
     RETURNING 1
  `, [rideId]);
  if (guard.rowCount === 0) {
    return { ok: false, reason: 'BUSY' }; // quelqu’un d’autre réassigne déjà
  }

  try {
    // Charge la course à jour
    const r0 = await db.query(`
      SELECT id, origin_lat, origin_lng,
             driver_phone, discussion, proposed_price,
             contacted_driver_phones,
             reassign_attempts, max_reassign_attempts
      FROM rides WHERE id=$1
    `, [rideId]);
    const ride = r0.rows[0];
    if (!ride) return { ok:false, reason:'RIDE_NOT_FOUND' };
    if (ride.origin_lat == null || ride.origin_lng == null) return { ok:false, reason:'ORIGIN_MISSING' };

    const max = ride.max_reassign_attempts ?? 5;
    if ((ride.reassign_attempts ?? 0) >= max) return { ok:false, reason:'MAX_ATTEMPTS_REACHED' };

    const oldPhone = ride.driver_phone || null;

    // Dernière offre client (fallback sur proposed_price ou 3000)
    const lastClientAmount = (() => {
      if (Array.isArray(ride.discussion)) {
        for (let i = ride.discussion.length - 1; i >= 0; i--) {
          const parts = (ride.discussion[i] || '').split(':');
          if (parts[0] === 'client' && /^\d+$/.test(parts[1] || '')) return parseInt(parts[1], 10);
        }
      }
      return Math.max(ride.proposed_price ?? 0, 3000);
    })();

    // Incrémente le compteur de tentatives
    await db.query(
      `UPDATE rides SET reassign_attempts = COALESCE(reassign_attempts,0)+1 WHERE id=$1`,
      [rideId]
    );

    // Libère l’ancien chauffeur (ne touche PAS à available)
    if (oldPhone) {
      try { await setOnRideByPhone(oldPhone, false); } catch (_) {}
    }

    // Liste d’exclus
    const exclude = Array.isArray(ride.contacted_driver_phones) ? [...ride.contacted_driver_phones] : [];
    if (oldPhone) exclude.push(oldPhone);

    // Cherche un nouveau chauffeur
    const minSolde = Math.max(lastClientAmount, 3000);
    const driver = await pickNearestDriverAtomicFallback({
      originLat: ride.origin_lat,
      originLng: ride.origin_lng,
      excludePhones: [...new Set(exclude)],
      radii: [3, 6, 10, 15],
      minSolde
    });

    // TX : archive + reset + assigne (ou laisse sans chauffeur)
    try {
      await db.query('BEGIN');

      // Archive l’ancienne discussion
      if ((ride.discussion && ride.discussion.length > 0) || oldPhone) {
        await db.query(`
          UPDATE rides
             SET archived_discussions = archived_discussions
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

      const sysMsg = 'system:driver_refused';
      const seedMsg = `client:${lastClientAmount}`;

      if (!driver) {
        // Pas de chauffeur : on laisse driver_phone NULL, status en_attente, discussion semée
        await db.query(`
          UPDATE rides
             SET driver_phone = NULL,
                 status = 'en_attente',
                 discussion = ARRAY[$1, $2]::text[],
                 last_offer_from = NULL,
                 client_accepted = TRUE,
                 negotiation_status = 'en_attente'
           WHERE id = $3
        `, [sysMsg, seedMsg, rideId]);

        await db.query('COMMIT');
        console.log('[reassign] none ride=%s', rideId);
        return { ok:false, reason:'NO_DRIVER_AVAILABLE' };
      }

      // Chauffeur trouvé : on assigne et on cumule contacted_driver_phones
      await db.query(`
        UPDATE rides
           SET driver_phone = $1,
               status = 'en_attente',
               contacted_driver_phones = (
                 SELECT ARRAY(
                   SELECT DISTINCT e
                   FROM unnest(
                     COALESCE(contacted_driver_phones, '{}'::text[]) || ARRAY[$1]::text[]
                   ) AS e
                 )
               ),
               discussion = ARRAY[$2, $3]::text[],
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

    // Marque le nouveau chauffeur occupé (sécurité si pas déjà on_ride=TRUE)
    try { await setOnRideByPhone(driver.phone, true); } catch (_) {}

    // Notifie le nouveau chauffeur
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
    // 🔓 release guard
    await db.query(`UPDATE rides SET reassigning = FALSE WHERE id=$1`, [rideId]);
  }
}

module.exports = { reassignDriverForRide };
