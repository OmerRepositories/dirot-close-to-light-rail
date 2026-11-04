const assert = require("node:assert/strict");
const test = require("node:test");

global.LRCacheData = require("../cache-data.js");
const CacheExport = require("../cache-export.js");

function parseCsvRow(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') {
      value += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  cells.push(value);
  return cells;
}

async function readZipEntries(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const size = view.getUint32(offset + 18, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    entries.set(name, decoder.decode(bytes.slice(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return entries;
}

test("CSV export includes every amenity flag, coordinates, URL, and arbitrary record data", async () => {
  const updatedAt = Date.UTC(2026, 9, 30);
  const csv = await CacheExport.buildCsv(
    {
      "yad2:ad-123": {
        notes: "18 דקות הליכה מהרכבת; אין אוטובוסים באזור",
        amenities: { parking: true, secureRoom: false, newFlag: true },
        coordinates: { lat: 32.1, lon: 34.8 },
        price: 2500000,
        observedPrice: 2500000,
        priceHistory: [
          { price: 2600000, at: Date.UTC(2026, 9, 20) },
          { price: 2500000, at: Date.UTC(2026, 9, 30) },
        ],
        sqm: 100,
        pricePerSqm: 25000,
        rooms: 4,
        listingCreatedAt: "2026-10-14",
        listingUpdatedAt: "2026-10-20",
        updatedAt,
        url: "https://www.yad2.co.il/realestate/item/center-and-sharon/ad-123",
        railMeters: 460,
        railApprox: true,
        railStation: "שטמפפר",
        brokerage: false,
        sourceNote: "owner said \"renovated\"",
      },
      "madlan:ad-456": {
        amenities: { parking: false },
        updatedAt,
        legacyField: "kept",
      },
    },
    () => {},
    updatedAt + 1000
  );
  const rows = csv.slice(1).trimEnd().split("\r\n").map(parseCsvRow);
  const headers = rows[0];
  const yad2 = Object.fromEntries(headers.map((header, index) => [header, rows[1][index]]));
  const madlan = Object.fromEntries(headers.map((header, index) => [header, rows[2][index]]));

  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(yad2.cache_key, "yad2:ad-123");
  assert.equal(yad2.notes, "18 דקות הליכה מהרכבת; אין אוטובוסים באזור");
  assert.equal(yad2.listing_url, "https://www.yad2.co.il/realestate/item/center-and-sharon/ad-123");
  assert.equal(yad2.amenity_parking, "true");
  assert.equal(yad2.amenity_secureRoom, "false");
  assert.equal(yad2.amenity_newFlag, "true");
  assert.equal(yad2.latitude, "32.1");
  assert.equal(yad2.longitude, "34.8");
  assert.equal(yad2.price, "2500000");
  assert.equal(yad2.observedPrice, "2500000");
  assert.deepEqual(JSON.parse(yad2.priceHistory), [
    { price: 2600000, date: "2026-10-20T00:00:00.000Z" },
    { price: 2500000, date: "2026-10-30T00:00:00.000Z" },
  ]);
  assert.equal(yad2.sqm, "100");
  assert.equal(yad2.pricePerSqm, "25000");
  assert.equal(yad2.record_type, "listing");
  assert.equal(yad2.rooms, "4");
  assert.equal(yad2.listing_created_at, "2026-10-14");
  assert.equal(yad2.listing_updated_at, "2026-10-20");
  assert.equal(yad2.railMeters, "460");
  assert.equal(yad2.railApprox, "true");
  assert.equal(yad2.railStation, "שטמפפר");
  assert.equal(yad2.brokerage, "false");
  assert.equal(yad2.record_sourceNote, 'owner said "renovated"');
  assert.equal(JSON.parse(yad2.record_json).amenities.secureRoom, false);
  assert.equal(madlan.listing_url, "https://www.madlan.co.il/listings/ad-456");
  assert.equal(madlan.record_legacyField, "kept");
});

test("price history export marks inferred bootstrap dates as estimates", async () => {
  const timestamp = Date.UTC(2026, 10, 2, 10);
  const csv = await CacheExport.buildCsv(
    {
      "madlan:ad-789": {
        priceHistory: [
          { price: 2_680_000, at: timestamp - 60_000 },
          { price: 2_850_000, at: timestamp },
        ],
      },
    },
    () => {},
    timestamp
  );
  const [headers, values] = csv.slice(1).trimEnd().split("\r\n").map(parseCsvRow);
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  assert.deepEqual(JSON.parse(row.priceHistory), [
    {
      price: 2_680_000,
      date: new Date(timestamp - 86_400_000).toISOString(),
      baselineUnknown: true,
      baselineDateEstimated: true,
    },
    { price: 2_850_000, date: new Date(timestamp).toISOString() },
  ]);
});

test("Excel export is a filtered XLSX with readable amenity colors and clickable listing URLs", async () => {
  const updatedAt = Date.UTC(2026, 9, 30);
  const workbook = await CacheExport.buildExcel(
    {
      "yad2:ad-123": {
        notes: "לבדוק רעש מהכביש",
        amenities: { parking: true, secureRoom: false },
        coordinates: { lat: 32.1, lon: 34.8 },
        recordType: "project",
        title: "פרויקט שטמפפר",
        address: "יהושע שטמפפר 81, פתח תקווה",
        city: "פתח תקווה",
        neighborhood: "שיפר",
        price: 1790000,
        maxPrice: 1790000,
        sqm: 100,
        maxSqm: 120,
        pricePerSqm: 25000,
        observedPrice: 1790000,
        priceHistory: [{ price: 1790000, at: updatedAt }],
        rooms: 5,
        railMeters: 420,
        railApprox: true,
        railStation: "תחנת שטמפפר",
        brokerage: true,
        listingCreatedAt: "2026-10-14",
        listingUpdatedAt: "2026-10-20",
        updatedAt,
        url: "https://www.yad2.co.il/yad1/project/18636",
      },
    },
    () => {},
    updatedAt
  );
  const files = await readZipEntries(workbook);
  const sheet = files.get("xl/worksheets/sheet1.xml");
  const historySheet = files.get("xl/worksheets/sheet2.xml");
  const historyLinks = files.get("xl/worksheets/_rels/sheet2.xml.rels");
  const links = files.get("xl/worksheets/_rels/sheet1.xml.rels");

  assert.equal(
    workbook.type,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  assert.ok(files.has("[Content_Types].xml"));
  assert.ok(sheet.includes('<autoFilter ref="A1:AK2"/>'));
  assert.ok(sheet.includes('rightToLeft="1"'));
  assert.ok(sheet.includes("מזהה מודעה/פרויקט"));
  assert.ok(sheet.includes("מחיר / החל מ׳ (₪)"));
  assert.ok(sheet.includes("תצפיות מחיר"));
  assert.ok(!sheet.includes("JSON"));
  assert.ok(sheet.includes("פתח תקווה"));
  assert.ok(sheet.includes("<t>לבדוק רעש מהכביש</t>"));
  assert.ok(sheet.includes("תאריך יצירת מודעה"));
  assert.ok(sheet.includes("תאריך עדכון מודעה"));
  assert.ok(sheet.includes("<t>2026-10-14</t>"));
  assert.ok(sheet.includes("<t>2026-10-20</t>"));
  assert.ok(sheet.includes("<t>פרויקט</t>"));
  assert.ok(sheet.includes("מרחק מהרכבת (מ׳)"));
  assert.ok(sheet.includes("<v>420</v>"));
  assert.ok(sheet.includes("<t>תחנת שטמפפר</t>"));
  assert.ok(sheet.includes("תיווך?"));
  assert.ok(sheet.includes('<c r="Z2" s="3" t="inlineStr"><is><t>כן</t>'));
  assert.ok(sheet.includes('<c r="X2" t="inlineStr"><is><t>כן</t>'));
  assert.ok(sheet.includes("<v>1790000</v>"));
  assert.ok(sheet.includes("<v>100</v>"));
  assert.ok(sheet.includes("<v>25000</v>"));
  assert.ok(sheet.includes('s="2" t="inlineStr"><is><t>כן</t>'));
  assert.ok(sheet.includes('s="3" t="inlineStr"><is><t>לא</t>'));
  assert.ok(sheet.includes("<t>פתיחת פרויקט ↗</t>"));
  assert.ok(sheet.includes('<hyperlink ref="D2" r:id="rId1"/>'));
  assert.ok(links.includes('Target="https://www.yad2.co.il/yad1/project/18636"'));
  assert.ok(files.get("xl/workbook.xml").includes('name="היסטוריית מחירים"'));
  assert.ok(historySheet.includes("תאריך תצפית"));
  assert.ok(historySheet.includes("<t>מחיר בסיס</t>"));
  assert.ok(historySheet.includes("<t>30.10.2026</t>"));
  assert.ok(historySheet.includes("<v>1790000</v>"));
  assert.ok(historySheet.includes('<hyperlink ref="E2" r:id="rId1"/>'));
  assert.ok(historyLinks.includes('Target="https://www.yad2.co.il/yad1/project/18636"'));
});

test("Excel price history uses readable rows and marks bootstrap dates as estimates", async () => {
  const timestamp = Date.UTC(2026, 10, 2, 10);
  const workbook = await CacheExport.buildExcel(
    {
      "madlan:ad-789": {
        title: "דירה",
        address: "חפץ חיים 25, פתח תקווה",
        priceHistory: [
          { price: 2_680_000, at: timestamp - 60_000 },
          { price: 2_850_000, at: timestamp },
        ],
        url: "https://www.madlan.co.il/listings/ad-789",
      },
    },
    () => {},
    timestamp
  );
  const files = await readZipEntries(workbook);
  const sheet = files.get("xl/worksheets/sheet2.xml");
  assert.ok(sheet.includes("<t>מחיר קודם — תאריך משוער</t>"));
  assert.ok(sheet.includes("<t>עלייה — מחיר קודם עם תאריך משוער</t>"));
  assert.ok(sheet.includes("<t>1.11.2026 (משוער)</t>"));
  assert.ok(sheet.includes("<v>2680000</v>"));
  assert.ok(sheet.includes("<v>2850000</v>"));
  assert.ok(sheet.includes("<v>170000</v>"));
});

test("CSV export includes a safe Yad2 fallback URL and guards spreadsheet formulas", async () => {
  const csv = await CacheExport.buildCsv(
    {
      "yad2:token-1": {
        amenities: {},
        updatedAt: 1,
        note: "\n=HYPERLINK(\"https://example.com\")",
      },
    },
    () => {},
    2
  );
  const [headers, values] = csv.slice(1).trimEnd().split("\r\n").map(parseCsvRow);
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));

  assert.equal(
    row.listing_url,
    "https://www.yad2.co.il/realestate/item/token-1"
  );
  assert.equal(row.record_note, '\'\n=HYPERLINK("https://example.com")');
});

test("CSV generation yields progress while processing a large cache", async () => {
  const progress = [];
  const cache = Object.fromEntries(
    Array.from({ length: 450 }, (_, index) => [
      `madlan:${index}`,
      { amenities: { parking: index % 2 === 0 }, updatedAt: 100 },
    ])
  );

  await CacheExport.buildCsv(cache, (complete, total) => progress.push([complete, total]), 200);

  assert.deepEqual(progress, [
    [0, 450],
    [200, 450],
    [400, 450],
    [450, 450],
  ]);
});

test("price timeline includes changes from uncertain initial baselines with estimated-date markers", () => {
  const first = Date.UTC(2026, 10, 1, 10);
  const second = Date.UTC(2026, 10, 2, 10);
  const third = Date.UTC(2026, 10, 3, 10);
  const changes = CacheExport.getPriceChanges({
    "yad2:known-history": {
      title: "דירה א",
      priceHistory: [
        { price: 1_000_000, at: first, baselineKnown: true },
        { price: 1_050_000, at: second },
        { price: 900_000, at: third },
      ],
    },
    "madlan:uncertain-history": {
      title: "דירה ב",
      priceHistory: [
        { price: 1_000_000, at: first },
        { price: 1_050_000, at: first + 60_000 },
        { price: 950_000, at: third },
      ],
    },
  });

  assert.equal(changes.length, 4);
  const knownReduction = changes.find(
    (event) => event.title === "דירה א" && event.toPrice === 900_000
  );
  assert.equal(knownReduction.change, -150_000);
  assert.equal(knownReduction.fromPrice, 1_050_000);
  assert.equal(knownReduction.at, third);
  const estimatedIncrease = changes.find(
    (event) => event.title === "דירה ב" && event.kind === "increase"
  );
  assert.equal(estimatedIncrease.change, 50_000);
  assert.equal(estimatedIncrease.baselineDateEstimated, true);
  assert.equal(estimatedIncrease.baselineEstimatedAt, first + 60_000 - 86_400_000);
  const laterReduction = changes.find(
    (event) => event.title === "דירה ב" && event.kind === "decrease"
  );
  assert.equal(laterReduction.change, -100_000);
});

test("price timeline classifies uncertain baseline changes as estimated", () => {
  const first = Date.UTC(2026, 10, 1, 10);
  const second = Date.UTC(2026, 10, 1, 10, 1);
  const third = Date.UTC(2026, 10, 3, 10);
  const events = CacheExport.getPriceTimelineEvents({
    "yad2:known-history": {
      title: "מודעה עם עלייה וירידה",
      priceHistory: [
        { price: 1_000_000, at: first, baselineKnown: true },
        { price: 1_100_000, at: second },
        { price: 950_000, at: third },
      ],
    },
    "madlan:uncertain-history": {
      title: "מודעה עם נקודת בסיס לא ודאית",
      priceHistory: [
        { price: 1_000_000, at: null, baselineUnknown: true },
        { price: 1_050_000, at: second },
      ],
    },
    "yad2:project-1": {
      recordType: "project",
      priceHistory: [{ price: 2_000_000, at: first }],
    },
  });

  assert.equal(events.length, 3);
  assert.deepEqual(
    events.filter((event) => event.kind === "increase").map((event) => event.change),
    [100_000, 50_000]
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "decrease").map((event) => event.change),
    [-150_000]
  );
  const estimated = events.find((event) => event.title === "מודעה עם נקודת בסיס לא ודאית");
  assert.equal(estimated.kind, "increase");
  assert.equal(estimated.at, second);
  assert.equal(estimated.baselineEstimatedAt, second - 86_400_000);
  assert.equal(estimated.baselineDateEstimated, true);
  assert.equal(CacheExport.getPriceChanges({
    "yad2:rise": {
      priceHistory: [
        { price: 1_000_000, at: first, baselineKnown: true },
        { price: 1_100_000, at: second },
      ],
    },
  })[0].kind, "increase");
});

test("price timeline events include saved listing details", () => {
  const first = Date.UTC(2026, 10, 1, 10);
  const second = Date.UTC(2026, 10, 2, 10);
  const event = CacheExport.getPriceTimelineEvents({
    "yad2:listing-details": {
      rooms: 4,
      sqm: 100,
      price: 2_500_000,
      railMeters: 420,
      railApprox: true,
      railStation: "תחנת הדוגמה",
      brokerage: false,
      amenities: { secureRoom: true, storage: false },
      priceHistory: [
        { price: 2_600_000, at: first, baselineKnown: true },
        { price: 2_500_000, at: second },
      ],
    },
  })[0];

  assert.equal(event.rooms, 4);
  assert.equal(event.sqm, 100);
  assert.equal(event.currentPrice, 2_500_000);
  assert.equal(event.pricePerSqm, 25_000);
  assert.equal(event.railMeters, 420);
  assert.equal(event.railApprox, true);
  assert.equal(event.railStation, "תחנת הדוגמה");
  assert.equal(event.brokerage, false);
  assert.deepEqual(event.amenities, { secureRoom: true, storage: false });
});

test("TXT export is readable and includes listing fields, amenities, and price observations", async () => {
  const timestamp = Date.UTC(2026, 10, 3, 10);
  const progress = [];
  const txt = await CacheExport.buildTxt(
    {
      "yad2:ad-123": {
        title: "דירה ברחוב הדוגמה",
        notes: "18 דקות הליכה מהרכבת\nאין אוטובוסים באזור",
        address: "הדוגמה 25",
        city: "פתח תקווה",
        price: 900_000,
        sqm: 80,
        rooms: 3,
        updatedAt: timestamp,
        priceHistory: [
          { price: 1_000_000, at: null, baselineUnknown: true },
          { price: 900_000, at: timestamp },
        ],
        amenities: { secureRoom: true, parking: false },
        coordinates: { lat: 32.1, lon: 34.8 },
        extraNote: "תוספת",
      },
    },
    (complete, total) => progress.push([complete, total])
  );

  assert.ok(txt.startsWith("\uFEFF"));
  assert.ok(txt.includes("דירה ברחוב הדוגמה"));
  assert.ok(txt.includes("הערה אישית: 18 דקות הליכה מהרכבת"));
  assert.ok(txt.includes("אין אוטובוסים באזור"));
  assert.ok(txt.includes("הדוגמה 25"));
  assert.ok(txt.includes("מחיר: ₪900,000"));
  assert.ok(txt.includes("היסטוריית מחירים:\r\n  02.11.2026 (משוער) — ₪1,000,000"));
  assert.ok(txt.includes("  03.11.2026 — ₪900,000"));
  assert.ok(txt.includes("ממ״ד: כן"));
  assert.ok(txt.includes("חניה: לא"));
  assert.ok(txt.includes("קו רוחב: 32.1"));
  assert.ok(txt.includes("extraNote: תוספת"));
  assert.deepEqual(progress, [[0, 1], [1, 1]]);
});
