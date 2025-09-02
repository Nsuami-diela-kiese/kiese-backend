// utils/driverPicker.js
const db = require('../db');

async function _pickOnce({ originLat, originLng, excludePhones = [], radiusKm, minSolde = 3000 }) {
  const params = [originLat, originLng, excludePhones, radiusKm, minSolde];
  const sql = `
    WITH ranked AS (
      SELECT
        d.phone, d.lat, d.lng,
        6371 * acos(
          cos(radians($1)) * cos(radians(d.lat)) * cos(radians(d.lng) - radians($2))
          + sin(radians($1)) * sin(radians(d.lat))
        ) AS km
      FROM drivers d
      WHERE d.available = TRUE
        AND d.on_ride  = FALSE
        AND d.blocked  = FALSE
        AND d.solde   >= $5
        AND (array_length($3::text[], 1) IS NULL OR d.phone <> ALL($3))
      -- Si tu as une colonne last_seen, tu peux filtrer les frais (décommente) :
      -- AND d.last_seen > NOW() - INTERVAL '45 seconds'
    ),
    candidate AS (
      SELECT phone
      FROM ranked
      WHERE km <= $4
      ORDER BY km ASC, random()
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE drivers d
       SET on_ride = TRUE
      FROM candidate c
     WHERE d.phone = c.phone
     RETURNING d.phone, d.lat, d.lng;
  `;
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

// -> Peut prendre soit radiusM (mètres), soit radii (km).
function _radiiFromOptions({ radiusM, radii }) {
  if (Array.isArray(radii) && radii.length) return radii.map(x => Math.max(1, Math.ceil(Number(x))));
  const baseKm = Math.max(2, Math.ceil((Number(radiusM) || 0) / 1000));
  // progression douce, plafonnée à 15 km
  return [baseKm, Math.min(baseKm * 2, 12), 15];
}

async function pickNearestDriverAtomicFallback({
  originLat,
  originLng,
  excludePhones = [],
  radii,        // km (ex: [3,6,10,15])
  radiusM,      // mètres (ex: 5000) -> radii auto
  minSolde = 3000,
}) {
  const radiiKm = _radiiFromOptions({ radiusM, radii });
  for (const r of radiiKm) {
    const found = await _pickOnce({ originLat, originLng, excludePhones, radiusKm: r, minSolde });
    if (found) return found;
  }
  return null;
}

module.exports = { _pickOnce, pickNearestDriverAtomicFallback };
