'use strict';

/* WGS84 lat/lon → USNG/MGRS (1 m precision). Validated against the NGA-based
   python `mgrs` library across the TX operating bbox — see tests/usng-check. */
function toUSNG(lat, lon) {
  const a = 6378137.0, f = 1 / 298.257223563;
  const k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const zone = Math.floor((lon + 180) / 6) + 1;
  const lonOrigin = (zone - 1) * 6 - 180 + 3;
  const latR = lat * Math.PI / 180, lonR = lon * Math.PI / 180, lonOR = lonOrigin * Math.PI / 180;

  const N = a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
  const T = Math.tan(latR) ** 2;
  const C = ep2 * Math.cos(latR) ** 2;
  const A = Math.cos(latR) * (lonR - lonOR);
  const M = a * (
    (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * latR
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * latR)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * latR)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * latR));
  const easting = k0 * N * (A + (1 - T + C) * A ** 3 / 6
    + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  let northing = k0 * (M + N * Math.tan(latR) * (A ** 2 / 2
    + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
    + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (lat < 0) northing += 10000000;

  const bands = 'CDEFGHJKLMNPQRSTUVWX';
  const band = bands[Math.floor((lat + 80) / 8)];
  const colLetters = ['STUVWXYZ', 'ABCDEFGH', 'JKLMNPQR'][zone % 3];
  const col = colLetters[Math.floor(easting / 100000) - 1];
  const rowLetters = 'ABCDEFGHJKLMNPQRSTUV';
  const rowOffset = (zone % 2 === 0) ? 5 : 0;
  const row = rowLetters[(Math.floor(northing / 100000) + rowOffset) % 20];
  const e5 = String(Math.floor(easting % 100000)).padStart(5, '0');
  const n5 = String(Math.floor(northing % 100000)).padStart(5, '0');
  return `${zone}${band} ${col}${row} ${e5} ${n5}`;
}
