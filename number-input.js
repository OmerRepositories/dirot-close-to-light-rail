// שדות מספר עם פסיקי אלפים (1,000,000) בזמן ההקלדה.
// שדה שמסומן ב-data-thousands הופך לשדה טקסט מספרי; input.value מחזיר את המספר בלי פסיקים
// (כך שהקוד הקיים שקורא Number(input.value) ממשיך לעבוד), והשמה ל-input.value מוצגת עם פסיקים.
(function (root) {
  const NATIVE = Object.getOwnPropertyDescriptor(
    root.HTMLInputElement ? root.HTMLInputElement.prototype : {},
    "value"
  );

  // מנקה פסיקים, רווחים וסימן ₪; משאיר ספרות, נקודה עשרונית ומינוס בהתחלה
  function clean(text) {
    const raw = String(text == null ? "" : text).replace(/[^\d.\-]/g, "");
    const negative = raw.startsWith("-");
    const [whole, ...fraction] = raw.replace(/-/g, "").split(".");
    const decimals = fraction.length ? `.${fraction.join("")}` : "";
    return `${negative ? "-" : ""}${whole}${decimals}`;
  }

  function format(text) {
    const value = clean(text);
    if (value === "" || value === "-") return value;
    const negative = value.startsWith("-");
    const [whole, decimals] = value.replace("-", "").split(".");
    const grouped = whole.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${negative ? "-" : ""}${grouped}${decimals !== undefined ? `.${decimals}` : ""}`;
  }

  function parse(text) {
    const value = clean(text);
    return value === "" ? NaN : Number(value);
  }

  function enhance(input) {
    if (!NATIVE || input.dataset.thousandsReady) return;
    input.dataset.thousandsReady = "true";
    const initial = NATIVE.get.call(input);
    input.type = "text";
    input.inputMode = input.dataset.thousands === "decimal" ? "decimal" : "numeric";
    input.autocomplete = "off";
    input.dir = "ltr";
    Object.defineProperty(input, "value", {
      configurable: true,
      get() {
        return clean(NATIVE.get.call(this));
      },
      set(next) {
        NATIVE.set.call(this, format(next));
      },
    });
    NATIVE.set.call(input, format(initial));
    // מעצבים מחדש בכל הקלדה ושומרים את הסמן אחרי אותה ספרה
    input.addEventListener("input", () => {
      const shown = NATIVE.get.call(input);
      const caret = input.selectionStart == null ? shown.length : input.selectionStart;
      const digitsBefore = shown.slice(0, caret).replace(/[^\d.\-]/g, "").length;
      const formatted = format(shown);
      if (formatted === shown) return;
      NATIVE.set.call(input, formatted);
      let position = 0;
      let seen = 0;
      while (position < formatted.length && seen < digitsBefore) {
        if (/[\d.\-]/.test(formatted[position])) seen++;
        position++;
      }
      try {
        input.setSelectionRange(position, position);
      } catch (_error) {
        // שדה שאינו בפוקוס
      }
    });
  }

  function enhanceAll(scope) {
    for (const input of (scope || root.document).querySelectorAll("input[data-thousands]")) {
      enhance(input);
    }
  }

  const api = { clean, format, parse, enhance, enhanceAll };
  root.LRNumberInput = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root.document) enhanceAll();
})(typeof window !== "undefined" ? window : globalThis);
