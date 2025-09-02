// utils/reassign.js
const db = require('../db');
const { pickNearestDriverAtomicFallback } = require('./driverPicker');
const { setOnRideByPhone } = require('./driverFlags');
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

/**
 * Tente une réassignation immédiate (un essai).
 * opts:
 *  - radiusM?: number      (mètres) -> progressive radii calculée
 *  - radii?: number[]      (km)     -> séquence personnalisée
 *  - clearBlacklist?: bool
 *  - force?: bool          (ignore le guard "BUSY")
 *  - minSolde?: number     (défaut: max(dernier montant client, 3000))
 */
async function reassignDriverForRide(rideId, opts = {}) {
  const { radiusM, radii, clearBlacklist = false, force = false } = opts;
  const logPrefix = `[reassign] ride=${rideId}`;

  // --- Guard concurrence
  if (force) {
    await db.query(`UPDATE rides SET reassigning = TRUE WHERE id = $1`, [rideId]);
  } else {
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
  }

  try {
    const r0 = await db.query(`
      SELECT id, origin_lat, origin_lng,
             driver_phone, discussion, proposed_price,
             contacted_driver_phones,
             reassign_attempts, max_reassign_attempts
        FROM rides
       WHERE id = $1
    `, [rideId]);

    const ride = r0.rows[0];
    if (!ride) return { ok:false, reason:'RIDE_NOT_FOUND' };
    if (ride.origin_lat == null || ride.origin_lng == null) return { ok:false, reason:'ORIGIN_MISSING' };

    const max = ride.max_reassign_attempts ?? 5;
    if (!force && (ride.reassign_attempts ?? 0) >= max) return { ok:false, reason:'MAX_ATTEMPTS_REACHED' };

    const oldPhone = ride.driver_phone || null;
    const lastClientAmount = Math.max(extractLastClientAmount(ride.discussion, ride.proposed_price), opts.minSolde || 0, 3000);

    // ++ tentative
    await db.query(`UPDATE rides SET reassign_attempts = COALESCE(reassign_attempts,0) + 1 WHERE id = $1`, [rideId]);

    // libère ancien on_ride
    if (oldPhone) {
      try { await setOnRideByPhone(oldPhone, false); } catch (_) {}
    }

    // blacklist
    let exclude = Array.isArray(ride.contacted_driver_phones) ? [...ride.contacted_driver_phones] : [];
    if (oldPhone) exclude.push(oldPhone);
    exclude = [...new Set(exclude)];
    if (clearBlacklist === true) exclude = oldPhone ? [oldPhone] : [];

    // pick
    const driver = await pickNearestDriverAtomicFallback({
      originLat: ride.origin_lat,
      originLng: ride.origin_lng,
      excludePhones: exclude,
      radii,
      radiusM,
      minSolde: lastClientAmount
    });

    // TX
    try {
      await db.query('BEGIN');

      // archive discussion/driver courant
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

      const seedMsg = `client:${lastClientAmount}`;

      if (!driver) {
        // pas de nouveau → on reste en attente, seed discussion, gère blacklist
        await db.query(`
          UPDATE rides
             SET driver_phone = NULL,
                 status = 'en_attente',
                 discussion = ARRAY[$1::text],
                 last_offer_from = NULL,
                 client_accepted = TRUE,
                 negotiation_status = 'en_attente',
                 contacted_driver_phones = CASE
                    WHEN $2::boolean IS TRUE THEN COALESCE(ARRAY[NULL]::text[], '{}'::text[]) -- clear
                    ELSE (
                      SELECT ARRAY(
                        SELECT DISTINCT e FROM unnest(
                          COALESCE(contacted_driver_phones,'{}'::text[])
                          || CASE WHEN $3::text IS NULL THEN '{}'::text[] ELSE ARRAY[$3::text] END
                        ) AS e
                      )
                    )
                 END
           WHERE id = $4
        `, [seedMsg, clearBlacklist === true, oldPhone, rideId]);

        await db.query('COMMIT');
        console.log(`${logPrefix} -> none`);
        return { ok:false, reason:'NO_DRIVER_AVAILABLE' };
      }

      // nouveau chauffeur trouvé
      await db.query(`
        UPDATE rides
           SET driver_phone = $1,
               status = 'en_attente',
               contacted_driver_phones = (
                 SELECT ARRAY(
                   SELECT DISTINCT e
                   FROM unnest(
                     CASE WHEN $2::boolean IS TRUE THEN '{}'::text[] ELSE COALESCE(contacted_driver_phones, '{}'::text[]) END
                     || ARRAY[$1::text]
                     || CASE WHEN $3::text IS NULL THEN '{}'::text[] ELSE ARRAY[$3::text] END
                   ) AS e
                 )
               ),
               discussion = ARRAY[$4::text],
               proposed_price = $5,
               last_offer_from = NULL,
               client_accepted = TRUE,
               negotiation_status = 'en_attente'
         WHERE id = $6
      `, [driver.phone, clearBlacklist === true, oldPhone, seedMsg, lastClientAmount, rideId]);

      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      console.error('reassign tx error:', e);
      return { ok:false, reason:'TX_ERROR' };
    }

    // marquer nouveau on_ride (sécurité)
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
    } catch (e) { console.error('reassign FCM error:', e); }

    console.log(`${logPrefix} -> new=${driver.phone}`);
    return { ok:true, driver };
  } finally {
    // On relâche le flag; l’API de plus haut renverra "searching" au client si besoin.
    await db.query(`UPDATE rides SET reassigning = FALSE WHERE id = $1`, [rideId]);
  }
}

/**
 * Idempotent "assure la recherche":
 * - Chauffeur déjà assigné → ALREADY_ASSIGNED
 * - reassigning = TRUE & pas de driver → SEARCH_ALREADY_ACTIVE (ne relance pas)
 * - sinon → lance une réassignation (un essai)
 */
async function ensureReassignForRide(rideId, opts = {}) {
  const r0 = await db.query(`
    SELECT id, status, driver_phone, COALESCE(reassigning,false) AS reassigning
      FROM rides WHERE id=$1
  `, [rideId]);
  const ride = r0.rows[0];
  if (!ride) return { ok:false, reason:'RIDE_NOT_FOUND' };

  if (ride.driver_phone) {
    return { ok:true, reason:'ALREADY_ASSIGNED' };
  }
  if (ride.reassigning === true) {
    return { ok:false, searching:true, reason:'SEARCH_ALREADY_ACTIVE' };
  }
  // sinon on fait un essai (non-force)
  const r = await reassignDriverForRide(rideId, { ...opts, force: false });
  if (r.ok) return r;
  // si pas de driver trouvé, le client doit rester en "searching"
  return { ok:false, searching:true, reason:r.reason || 'NO_DRIVER_AVAILABLE' };
}

module.exports = { reassignDriverForRide, ensureReassignForRide };
