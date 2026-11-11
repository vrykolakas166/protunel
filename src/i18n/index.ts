import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import enCommon from "../locales/en/common.json";
import enTunnelList from "../locales/en/tunnelList.json";
import enAddTunnelForm from "../locales/en/addTunnelForm.json";
import enConfigPanel from "../locales/en/configPanel.json";
import enRouterPanel from "../locales/en/routerPanel.json";
import enSettingsPanel from "../locales/en/settingsPanel.json";
import enTourGuide from "../locales/en/tourGuide.json";
import enCapturePanel from "../locales/en/capturePanel.json";
import enKnownHostsPanel from "../locales/en/knownHostsPanel.json";
import enHostKeyPrompt from "../locales/en/hostKeyPrompt.json";
import enApp from "../locales/en/app.json";
import enLocalIps from "../locales/en/localIps.json";
import enTerminal from "../locales/en/terminal.json";

import viCommon from "../locales/vi/common.json";
import viTunnelList from "../locales/vi/tunnelList.json";
import viAddTunnelForm from "../locales/vi/addTunnelForm.json";
import viConfigPanel from "../locales/vi/configPanel.json";
import viRouterPanel from "../locales/vi/routerPanel.json";
import viSettingsPanel from "../locales/vi/settingsPanel.json";
import viTourGuide from "../locales/vi/tourGuide.json";
import viCapturePanel from "../locales/vi/capturePanel.json";
import viKnownHostsPanel from "../locales/vi/knownHostsPanel.json";
import viHostKeyPrompt from "../locales/vi/hostKeyPrompt.json";
import viApp from "../locales/vi/app.json";
import viLocalIps from "../locales/vi/localIps.json";
import viTerminal from "../locales/vi/terminal.json";

export const SUPPORTED_LANGUAGES = ["en", "vi"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

void i18next.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: "common",
  ns: [
    "common",
    "tunnelList",
    "addTunnelForm",
    "configPanel",
    "routerPanel",
    "settingsPanel",
    "tourGuide",
    "capturePanel",
    "knownHostsPanel",
    "hostKeyPrompt",
    "app",
    "localIps",
    "terminal",
  ],
  resources: {
    en: {
      common: enCommon,
      tunnelList: enTunnelList,
      addTunnelForm: enAddTunnelForm,
      configPanel: enConfigPanel,
      routerPanel: enRouterPanel,
      settingsPanel: enSettingsPanel,
      tourGuide: enTourGuide,
      capturePanel: enCapturePanel,
      knownHostsPanel: enKnownHostsPanel,
      hostKeyPrompt: enHostKeyPrompt,
      app: enApp,
      localIps: enLocalIps,
      terminal: enTerminal,
    },
    vi: {
      common: viCommon,
      tunnelList: viTunnelList,
      addTunnelForm: viAddTunnelForm,
      configPanel: viConfigPanel,
      routerPanel: viRouterPanel,
      settingsPanel: viSettingsPanel,
      tourGuide: viTourGuide,
      capturePanel: viCapturePanel,
      knownHostsPanel: viKnownHostsPanel,
      hostKeyPrompt: viHostKeyPrompt,
      app: viApp,
      localIps: viLocalIps,
      terminal: viTerminal,
    },
  },
  interpolation: { escapeValue: false },
});

export default i18next;
