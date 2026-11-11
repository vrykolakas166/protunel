import React from "react";
import ReactDOM from "react-dom/client";
import { TerminalApp } from "./TerminalApp";
import "../i18n";
import "../index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TerminalApp />
  </React.StrictMode>,
);
