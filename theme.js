// ערכת צבעים לעמודי התוסף: בהיר / כהה / לפי המחשב.
// נטען ב-<head> לפני הציור הראשון: קורא את הבחירה האחרונה מ-localStorage (מיידי, בלי הבהוב),
// ואז מסתנכרן עם chrome.storage.sync כדי שהבחירה תחול בכל העמודים ובכל המחשבים.
(function () {
  const KEY = "lightrailTheme";
  const CHOICES = ["system", "light", "dark"];
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  let choice = "system";
  try {
    choice = CHOICES.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : "system";
  } catch (_error) {
    // בלי localStorage (מצב פרטי) – לפי המחשב עד שההגדרה תיטען
  }

  function apply() {
    const dark = choice === "dark" || (choice === "system" && Boolean(media && media.matches));
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.themeChoice = choice;
    for (const button of document.querySelectorAll("[data-theme-choice]")) {
      const active = button.dataset.themeChoice === choice;
      button.setAttribute("aria-checked", String(active));
      button.tabIndex = active ? 0 : -1;
    }
  }

  function set(next, persist) {
    choice = CHOICES.includes(next) ? next : "system";
    try {
      localStorage.setItem(KEY, choice);
    } catch (_error) {
      // לא קריטי: ההגדרה נשמרת גם ב-chrome.storage
    }
    apply();
    if (persist && window.chrome && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ theme: choice });
    }
  }

  apply();
  if (media && media.addEventListener) media.addEventListener("change", apply);
  if (window.chrome && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get({ theme: choice }, (settings) => {
      if (!chrome.runtime.lastError && settings) set(settings.theme, false);
    });
    chrome.storage.sync.onChanged.addListener((changes) => {
      if (changes.theme) set(changes.theme.newValue, false);
    });
  }

  // מחבר את כפתורי הבחירה (בהיר / כהה / לפי המחשב) אחרי שה-DOM נטען
  document.addEventListener("DOMContentLoaded", () => {
    for (const button of document.querySelectorAll("[data-theme-choice]")) {
      button.addEventListener("click", () => set(button.dataset.themeChoice, true));
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const group = [...button.parentElement.querySelectorAll("[data-theme-choice]")];
        const step = event.key === "ArrowLeft" ? 1 : -1; // RTL: שמאלה = הבא
        const next = group[(group.indexOf(button) + step + group.length) % group.length];
        next.focus();
        set(next.dataset.themeChoice, true);
      });
    }
    apply();
  });

  window.LRTheme = { get: () => choice, set: (next) => set(next, true) };
})();
