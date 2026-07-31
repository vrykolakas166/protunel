import { useEffect } from "react";

export type ThemePreference = "system" | "light" | "dark";

function resolve(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

/** Applies `.dark` to <html> per the given preference, tracking OS changes in "system" mode. */
export function useTheme(preference: ThemePreference) {
  useEffect(() => {
    const apply = () => {
      document.documentElement.classList.toggle("dark", resolve(preference) === "dark");
    };
    apply();

    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);
}
