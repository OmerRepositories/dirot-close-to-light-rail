var LRWhatsAppMessage = (() => {
  function normalizeFloor(value, isFloorField = false) {
    const text = String(value || "")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return null;
    const beforeLabel = text.match(/([0-9]+(?:\.\d+)?|קרקע|מרתף)\s*קומה/);
    if (beforeLabel) return `קומה ${beforeLabel[1]}`;
    const afterLabel = text.match(/קומה\s*([0-9]+(?:\.\d+)?|קרקע|מרתף)/);
    if (afterLabel) return `קומה ${afterLabel[1]}`;
    if (isFloorField && /^[0-9]+(?:\.\d+)?$/.test(text)) return `קומה ${text}`;
    return null;
  }

  function readFloor(root, selectors, overviewSelector) {
    if (!root || typeof root.querySelector !== "function") return null;
    const overview = overviewSelector && root.querySelector(overviewSelector);
    if (overview && typeof overview.querySelector === "function") {
      const overviewFloor = overview.querySelector('[data-auto="floor"]');
      if (overviewFloor) {
        const value = overviewFloor.firstElementChild;
        const label = overviewFloor.children && overviewFloor.children[1];
        const labelText = String(label && (label.innerText || label.textContent) || "").trim();
        const floor = normalizeFloor(
          value && labelText === "קומה"
            ? `${value.innerText || value.textContent || ""}\nקומה`
            : overviewFloor.innerText || overviewFloor.textContent || ""
        );
        if (floor) return floor;
      }
    }

    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = element && String(element.innerText || element.textContent || "").trim();
      const floor = normalizeFloor(text, Boolean(element && /floor|קומה/i.test(selector)));
      if (floor) return floor;
    }

    return overview
      ? normalizeFloor(overview.innerText || overview.textContent || "")
      : null;
  }

  // "קומה 4" → "4", כדי שהשורה תהיה "קומה: 4" ולא "קומה: קומה 4"
  function floorValue(floor) {
    const text = String(floor || "").replace(/^\s*קומה\s*/, "").trim();
    return text || null;
  }

  // "4" + 6 → "4 מתוך 6"
  function floorWithTop(floor, topFloor) {
    if (!floor) return null;
    return Number.isFinite(topFloor) && topFloor > 0 && /^\d+$/.test(floor) ? `${floor} מתוך ${topFloor}` : floor;
  }

  // listingCreatedAt בפורמט YYYY-MM-DD (או תאריך ISO מלא)
  function createdDate(createdAt) {
    const match = String(createdAt || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? { text: `${match[3]}/${match[2]}/${match[1]}`, utc: Date.UTC(+match[1], +match[2] - 1, +match[3]) } : null;
  }

  function ageText(createdAt, now = Date.now()) {
    const created = createdDate(createdAt);
    if (!created) return null;
    const today = new Date(now);
    const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const days = Math.max(0, Math.round((todayUtc - created.utc) / 86400000));
    if (days === 0) return "פורסמה היום";
    if (days === 1) return "יום אחד";
    if (days === 2) return "יומיים";
    return `${days.toLocaleString("he-IL")} ימים`;
  }

  function format(data, now = Date.now()) {
    const value = (item) => (item === null || item === undefined || item === "" ? "לא זוהה" : item);
    const created = createdDate(data.listingCreatedAt);
    const lines = [
      // מספר בית שהאתר שיער (המוכר פרסם רק רחוב/שכונה) – מסומן כמשוער
      data.addressApprox && data.address
        ? `כתובת משוערת: ${data.address} (המוכר פרסם רק רחוב – מספר הבית לפי מיקום הסיכה במפה)`
        : `כתובת: ${value(data.address)}`,
      `מחיר: ${value(data.price)}`,
      `מ"ר: ${value(data.sqm)}`,
      `חדרים: ${value(data.rooms)}`,
      `קומה: ${value(floorWithTop(floorValue(data.floor), data.buildingTopFloor))}`,
      `תאריך פרסום: ${value(created && created.text)}`,
      `גיל המודעה: ${value(ageText(data.listingCreatedAt, now))}`,
      `מחיר למ"ר: ${value(data.pricePerSqm)}`,
      `מרחק בקו אווירי מהרכבת (המרחק בהליכה עשוי להיות גדול יותר): ${value(data.railDistance)}`,
      `קישור למודעה: ${value(data.url)}`,
    ];
    const missingAmenities = Array.isArray(data.missingAmenities)
      ? [
          ...new Set(
            data.missingAmenities.filter(
              (amenity) => typeof amenity === "string" && amenity.trim()
            )
          ),
        ]
      : [];
    if (missingAmenities.length) {
      lines.push(`שים לב חסר: ${missingAmenities.join(", ")}`);
    }
    if (data.realDeals) lines.push(`מחיר למ"ר מול עסקאות אמת: ${data.realDeals}`);
    // מרחק למקלט רק כשידוע (יד2 מציגה אותו בעמוד המודעה) – לא שורת "לא זוהה"
    if (Number.isFinite(data.shelterMeters)) {
      lines.push(`מרחק למקלט ציבורי: ${Math.round(data.shelterMeters).toLocaleString("he-IL")} מ׳`);
    }
    if (data.brokerage === true) {
      lines.push("שים לב מדובר במודעת תיווך!");
    }
    return lines.join("\n");
  }

  return { format, normalizeFloor, readFloor, ageText };
})();

if (typeof module !== "undefined") module.exports = LRWhatsAppMessage;
