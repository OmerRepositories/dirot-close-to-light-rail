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
    if (!String((address && address.street) || "").trim()) return false;
    const origin = listingMapsOrigin(address, queries, fallbackCity);
    if (!origin) return false;
    const parts = origin.split(",").map((part) => part.trim());
    return parts.length >= 2 && Boolean(parts[0]) && isUsableCity(parts.slice(1).join(", "));
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

  return {
    validCoordinates,
    mapsDirectionsUrl,
    stationMapsQuery,
    listingMapsOrigin,
    hasListingMapsAddress,
  };
})();

if (typeof module !== "undefined") module.exports = LRLocation;
