import { useEffect } from "react";
import i18n, { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../i18n";

function isSupported(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Switches the i18next UI language to match the persisted setting. */
export function useLanguage(language: string | undefined) {
  useEffect(() => {
    if (language && isSupported(language) && i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
  }, [language]);
}
