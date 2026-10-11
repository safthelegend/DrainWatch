// Shared description of data/nyc-elevation.png (made by scripts/bake-elevation.mjs).
//   elevation_m = (R * 256 + G) / 100 - 100
//   B = 1 + neighborhood (NTA) index, or 0 for water / outside the city

export const ELEVATION = {
  url: 'data/nyc-elevation.png',
  bbox: { west: -74.27, east: -73.68, south: 40.48, north: 40.93 },
  size: 448,
};

export function decodeElevation(r, g) {
  return (r * 256 + g) / 100 - 100;
}

/** lon/lat of the centre of grid cell (row, col). */
export function cellLonLat(row, col, size = ELEVATION.size, bbox = ELEVATION.bbox) {
  return [bbox.west + ((col + 0.5) / size) * (bbox.east - bbox.west), bbox.north - ((row + 0.5) / size) * (bbox.north - bbox.south)];
}
