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

  function format(data) {
    const value = (item) => (item === null || item === undefined || item === "" ? "לא זוהה" : item);
    const lines = [
      `כתובת: ${value(data.address)}`,
      `מחיר: ${value(data.price)}`,
      `מ"ר: ${value(data.sqm)}`,
      `חדרים: ${value(data.rooms)}`,
      `קומה: ${value(data.floor)}`,
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
    return lines.join("\n");
  }

  return { format, normalizeFloor, readFloor };
})();

if (typeof module !== "undefined") module.exports = LRWhatsAppMessage;
