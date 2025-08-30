// utils/driverPicker.js
const db = require('../db');

/**
 * Sélectionne un candidat dans un rayon (km) puis tente la réservation atomique (on_ride=TRUE).
 * Retourne { phone, lat, lng } ou null.
 */
async function _pickOnce({ originLat, originLng, excludePhones = [], radiusKm, minSolde = 3000 }) {
  // 1) Chercher le meilleur candidat par distance dans le rayon
  const excluded = (Array.isArray(excludePhones) && excludePhones.length) ? excludePhones : null;

  const candRes = await db.query(`
    SELECT
      d.phone
    FROM drivers d
    WHERE d.available = TRUE
      AND d.on_ride  = FALSE
      AND d.blocked  = FALSE
      AND d.solde   >= $5
      AND ( $3::text[] IS NULL OR NOT (d.phone = ANY($3::text[])) )
      AND (
        6371 * acos(
          cos(radians($1)) * cos(radians(d.lat)) * cos(radians(d.lng) - radians($2))
          + sin(radians($1)) * sin(radians(d.lat))
        )
      ) <= $4
    ORDER BY
      (
        6371 * acos(
          cos(radians($1)) * cos(radians(d.lat)) * cos(radians(d.lng) - radians($2))
          + sin(radians($1)) * sin(radians(d.lat))
        )
      ) ASC
    LIMIT 1
  `, [originLat, originLng, excluded, radiusKm, minSolde]);

  if (!candRes.rows.length) return null;

  const phone = candRes.rows[0].phone;

  // 2) Réservation atomique: on_ride passe à TRUE si encore libre
  const lockRes = await db.query(`
    UPDATE drivers
       SET on_ride = TRUE
     WHERE phone = $1
       AND on_ride = FALSE
     RETURNING phone, lat, lng
  `, [phone]);

  return lockRes.rows[0] || null; // null si collision
}

/**
 * Essaie plusieurs rayons (ex: 3 → 6 → 10 → 15 km) jusqu'à trouver.
 */
async function pickNearestDriverAtomicFallback({
  originLat,
  originLng,
  excludePhones = [],
  radii = [3, 6, 10, 15],
  minSolde = 3000,
}) {
  for (const r of radii) {
    const found = await _pickOnce({ originLat, originLng, excludePhones, radiusKm: r, minSolde });
    if (found) return found;
    // si collision, on retente rayon suivant (comportement simple et robuste)
  }
  return null;
}

module.exports = { _pickOnce, pickNearestDriverAtomicFallback };
