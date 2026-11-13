const assert = require("node:assert/strict");
const test = require("node:test");

const LRLocation = require("../location.js");

test("rail distance from known coordinates matches the background calculation", () => {
  const stations = [
    { name: "רחוק", lat: 32.2, lon: 34.9 },
    { name: "תחנה מרכזית פתח תקווה", lat: 32.0917, lon: 34.8854 },
  ];
  const res = LRLocation.railFromCoordinates(stations, { lat: 32.101221, lon: 34.883189 });
  assert.equal(res.ok, true);
  assert.equal(res.approx, false);
  assert.equal(res.station.name, "תחנה מרכזית פתח תקווה");
  assert.ok(res.meters > 1000 && res.meters < 1100, String(res.meters));
  assert.equal(res.walkMin, Math.max(1, Math.round((res.meters * 1.3) / 80)));
  assert.equal(LRLocation.railFromCoordinates([], { lat: 32, lon: 34 }), null);
  assert.equal(LRLocation.railFromCoordinates(stations, { lat: NaN, lon: 34 }), null);
});
