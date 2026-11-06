// סינון מודעות לפי רחובות חסומים שהמשתמש הגדיר.
// כל שורה ברשימה היא רחוב ("שטמפר"), ואפשר להגביל לעיר אחרי פסיק ("שטמפר, פתח תקווה").
// ההתאמה היא לפי מילים שלמות בשם הרחוב בלבד, כדי ש"הרצל" לא יחסום את "הרצליה".
var LRStreetFilter = (() => {
  function normalize(value) {
    return String(value || "")
      .replace(/[‎‏]/g, "")
      .replace(/["'`״׳”“’]/g, "")
      .replace(/[-–—_.()]/g, " ")
      .replace(/^\s*(?:רחוב|רח)\s+/, "")
      .replace(/\s+\d{1,4}\s*[א-ת]?\s*$/, "") // מספר בית בסוף
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function parseRules(list) {
    const rules = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const [streetPart, ...cityParts] = String(raw || "").split(",");
      const street = normalize(streetPart);
      if (!street) continue;
      const city = normalize(cityParts.join(","));
      rules.push({ street: street.split(" "), city });
    }
    return rules;
  }

  function containsWords(haystack, needle) {
    for (let i = 0; i + needle.length <= haystack.length; i++) {
      if (needle.every((word, j) => haystack[i + j] === word)) return true;
    }
    return false;
  }

  // מחזיר את הכלל שחסם את הכתובת, או null
  function match(rules, street, city) {
    const streetWords = normalize(street).split(" ").filter(Boolean);
    if (!streetWords.length || !rules.length) return null;
    const normalizedCity = normalize(city);
    for (const rule of rules) {
      if (!containsWords(streetWords, rule.street)) continue;
      if (rule.city && normalizedCity && !normalizedCity.includes(rule.city)) continue;
      return rule;
    }
    return null;
  }

  // ממיר טקסט חופשי מתיבת ההגדרות (שורה לכל רחוב) לרשימה נקייה
  function parseInput(text) {
    const seen = new Set();
    const out = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      const value = line.replace(/\s+/g, " ").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out.slice(0, 200);
  }

  return { normalize, parseRules, match, parseInput };
})();

if (typeof module !== "undefined") module.exports = LRStreetFilter;
