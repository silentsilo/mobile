import { api } from "../api";

export type ThemeChoice = "system" | "dark" | "light";

const KEY = "theme";
const phoneLight = window.matchMedia("(prefers-color-scheme: light)");
let current: ThemeChoice = "system";

export function readTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "dark" || saved === "light" ? saved : "system";
  } catch {
    return "system";
  }
}

// The page always carries the theme on screen, so the stylesheet needs one
// light block, whether the theme was chosen or followed from the phone.
function paint() {
  document.documentElement.dataset.theme = current === "system" ? (phoneLight.matches ? "light" : "dark") : current;
}

phoneLight.addEventListener("change", () => {
  if (current === "system") paint();
});

/** Sets the theme on the page. "system" follows the phone's setting. */
export function applyTheme(choice: ThemeChoice) {
  current = choice;
  paint();
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Still applies for this session.
  }
  // The system bars, the window behind the page and the next cold start.
  api.setAppTheme(choice).catch(() => undefined);
}
