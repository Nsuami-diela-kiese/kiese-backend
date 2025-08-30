// utils/driverSelector.haversine.js
const db = require('../db');

/**
 * Sélectionne le chauffeur disponible le plus proche.
 * @param {Object} p
 * @param {number} p.originLat
 * @param {number} p.originLng
 * @param {string[]} [p.excludePhones]  // téléphones à exclure (déjà contactés / refusés)
 * @param {number[]} [p.radiusMetersList] // rayons successifs
 * @param {boolean} [p.useFlags]        // filtre available/on_ride/blocked
 * @returns {Promise<null|{id:number, phone:string, name?:string, lat:number, lng:number, distance_m:number}>}
 */
async function selectNearestDriverHaversine({
  originLat,
  originLng,
  excludePhones = [],
  radiusMetersList = [1500, 3000, 6000, 10000, 15000],
  useFlags = true, // si tes colonnes available/on_ride/blocked existent
}) {
  // Nettoie les téléphones à exclure (trim)
  const ex = (excludePhones || []).map(p => (p || '').trim()).filter(Boolean);

  for (const radius of radiusMetersList) {
    const sql = `
      WITH params AS (
        SELECT
          $1::float8 AS rlat,
          $2::float8 AS rlng,
          $3::text[] AS exclude_phones,
          $4::float8 AS radius_m
      ),
      bbox AS (
        SELECT
          rlat, rlng,
          (radius_m / 111320.0)                              AS lat_delta,
          (radius_m / (111320.0 * COS(RADIANS(rlat))))       AS lng_delta
        FROM params
      )
      SELECT
        d.id,
        TRIM(d.phone) AS phone,
        d.name,
        d.lat, d.lng,
        6371000 * ACOS(
          LEAST(1.0, GREATEST(-1.0,
            COS(RADIANS(p.rlat)) * COS(RADIANS(d.lat)) *
            COS(RADIANS(d.lng) - RADIANS(p.rlng)) +
            SIN(RADIANS(p.rlat)) * SIN(RADIANS(d.lat))
          ))
        ) AS distance_m
      FROM drivers d
      CROSS JOIN params p
      CROSS JOIN bbox b
      WHERE d.lat IS NOT NULL
        AND d.lng IS NOT NULL
        ${useFlags ? `
        AND COALESCE(d.available, true) = true
        AND COALESCE(d.blocked,  false) = false
        AND COALESCE(d.on_ride,  false) = false
        ` : ``}
        -- préfiltre bbox
        AND d.lat BETWEEN (p.rlat - b.lat_delta) AND (p.rlat + b.lat_delta)
        AND d.lng BETWEEN (p.rlng - b.lng_delta) AND (p.rlng + b.lng_delta)
        -- exclusions
        AND NOT (TRIM(d.phone) = ANY (p.exclude_phones))
      ORDER BY distance_m ASC, COALESCE(d.rating, 5.0) DESC
      LIMIT 1;
    `;

    const { rows } = await db.query(sql, [originLat, originLng, ex, radius]);
    if (rows.length > 0) {
      return rows[0]; // { id, phone, name, lat, lng, distance_m }
    }
  }

  return null; // rien trouvé dans les rayons successifs
}

module.exports = { selectNearestDriverHaversine };
