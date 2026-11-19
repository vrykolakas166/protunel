import React from "react";
import ReactDOM from "react-dom/client";
import { TerminalApp } from "./TerminalApp";
import "../i18n";
import "../index.css";
import { installContextMenuGuard } from "../contextMenu";

// No webview right-click menu (Reload, Inspect…); see contextMenu.ts.
installContextMenuGuard();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TerminalApp />
  </React.StrictMode>,
);
