// Shared location helpers used by listing pages and Facebook.
var LRLocation = (() => {
  function validCoordinates(point) {
    return (
      point &&
      Number.isFinite(point.lat) &&
      Number.isFinite(point.lon) &&
      Math.abs(point.lat) <= 90 &&
      Math.abs(point.lon) <= 180
    );
  }

  function stationMapsQuery(name) {
    const station = String(name || "").trim();
    return /תחנ|רכבת קלה|light rail|tram/i.test(station)
      ? station
      : `תחנת הרכבת הקלה ${station}`;
  }

  function isUsableCity(value) {
    const city = String(value || "").trim();
    return Boolean(city) && !/מיקומים שנבחרו|נבחרו עד|מיקום נבחר/i.test(city);
  }

  function listingMapsOrigin(address, queries = [], fallbackCity = "") {
    const street = String((address && address.street) || "").trim();
    const city = isUsableCity(address && address.city)
      ? String(address.city).trim()
      : isUsableCity(fallbackCity)
        ? String(fallbackCity).trim()
        : "";
    if (street && city) return `${street}, ${city}`;
    if (street) {
      const streetQuery = queries.find(
        (query) =>
          !query.cityOnly &&
          query.q.startsWith(`${street}, `) &&
          isUsableCity(query.q.slice(street.length + 2))
      );
      if (streetQuery) return streetQuery.q;
      return street;
    }
    return (
      queries.find((query) => !query.cityOnly && isUsableCity(query.q))?.q ||
      null
    );
  }

  function hasListingMapsAddress(address, queries = [], fallbackCity = "") {
    const origin = listingMapsOrigin(address, queries, fallbackCity);
    if (!origin) return false;
    const parts = origin.split(",").map((part) => part.trim());
    const hasStreet = Boolean(String((address && address.street) || "").trim()) ||
      queries.some((query) => !query.cityOnly && query.q === origin);
    return hasStreet &&
      parts.length >= 2 &&
      Boolean(parts[0]) &&
      isUsableCity(parts.slice(1).join(", "));
  }

  function mapsDirectionsUrl(origin, destination) {
    const params = new URLSearchParams({
      api: "1",
      travelmode: "walking",
      origin:
        typeof origin === "string"
          ? origin
          : `${origin.lat},${origin.lon}`,
      destination:
        typeof destination === "string"
          ? stationMapsQuery(destination)
          : destination.name
            ? stationMapsQuery(destination.name)
            : `${destination.lat},${destination.lon}`,
    });
    return `https://www.google.com/maps/dir/?${params}`;
  }

  // מרחק לתחנה הקרובה כשהמיקום ידוע – אותו חישוב שעושה הרקע (background.js), כדי שאפשר יהיה לחשב
  // בדף עצמו בלי לחכות לרקע. stations: הרשימה השמורה (storage.local "stations")
  const WALK_DETOUR = 1.3;
  const WALK_M_PER_MIN = 80;
  function haversine(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }
  function railFromCoordinates(stations, coordinates) {
    if (!Array.isArray(stations) || !stations.length || !validCoordinates(coordinates)) return null;
    let best = null;
    for (const station of stations) {
      if (!station || !Number.isFinite(station.lat) || !Number.isFinite(station.lon)) continue;
      const distance = haversine(coordinates.lat, coordinates.lon, station.lat, station.lon);
      if (!best || distance < best.distance) best = { station, distance };
    }
    if (!best) return null;
    const meters = Math.round(best.distance);
    return {
      ok: true,
      approx: false,
      matched: "קואורדינטות המודעה",
      meters,
      walkMin: Math.max(1, Math.round((meters * WALK_DETOUR) / WALK_M_PER_MIN)),
      station: { name: best.station.name, lat: best.station.lat, lon: best.station.lon },
      origin: { lat: coordinates.lat, lon: coordinates.lon },
    };
  }

  return {
    validCoordinates,
    railFromCoordinates,
    mapsDirectionsUrl,
    stationMapsQuery,
    listingMapsOrigin,
    hasListingMapsAddress,
  };
})();

if (typeof module !== "undefined") module.exports = LRLocation;
