import React from "react";
import ReactDOM from "react-dom/client";
import { TerminalApp } from "./TerminalApp";
import "../i18n";
import "../index.css";
import { installContextMenuGuard } from "../contextMenu";

// No webview right-click menu (Reload, Inspect…); see contextMenu.ts.
installContextMenuGuard();

// The window's layout never scrolls: everything is sized to fit, and the
// shells scroll their own history (virtually, without DOM scrolling). A
// browser still scrolls an overflow-hidden box when something inside it is
// focused or a wheel runs past a pane's end (a terminal's input textarea left
// below a pane after a scroll or a resize), which slid the whole UI up. Any
// such scroll of the page or a layout box is put straight back.
const PINNED = "[data-pin-scroll], .xterm, .xterm-screen, .xterm-scrollable-element";
document.documentElement.style.overflow = "hidden";
document.body.style.overflow = "hidden";
document.addEventListener(
  "scroll",
  (e) => {
    const el = e.target;
    if (el === document) {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    } else if (el instanceof HTMLElement && el.matches(PINNED) && (el.scrollTop || el.scrollLeft)) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  },
  true,
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TerminalApp />
  </React.StrictMode>,
);
