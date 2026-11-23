// CodeMirror 6 for the file panel's viewer/editor. Loaded on first use only
// (`import("./editor")`), so the terminal window doesn't pay for it up front.
// Colours come from the theme's CSS variables, so it follows every theme.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
  type LanguageSupport,
  type StreamParser,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { extOf } from "./paths";

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--color-bg)", color: "var(--color-text)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--color-accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(var(--color-accent-rgb), 0.25) !important",
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-surface)",
    color: "var(--color-muted)",
    borderRight: "1px solid var(--color-border)",
  },
  ".cm-activeLine": { backgroundColor: "rgba(var(--color-accent-rgb), 0.06)" },
  ".cm-activeLineGutter": { backgroundColor: "rgba(var(--color-accent-rgb), 0.1)", color: "var(--color-text)" },
  ".cm-matchingBracket": { backgroundColor: "rgba(var(--color-accent-rgb), 0.2)", outline: "none" },
  ".cm-searchMatch": { backgroundColor: "rgba(var(--color-accent-rgb), 0.2)" },
  ".cm-searchMatch-selected": { backgroundColor: "rgba(var(--color-accent-rgb), 0.4)" },
  ".cm-panels": { backgroundColor: "var(--color-surface)", color: "var(--color-text)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-border)" },
  ".cm-panel input, .cm-panel button": { fontSize: "12px" },
  ".cm-textfield": {
    backgroundColor: "var(--color-bg)",
    border: "1px solid var(--color-border)",
    color: "var(--color-text)",
  },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--color-surface-hover)", color: "var(--color-text)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--color-surface-hover)", border: "none", color: "var(--color-muted)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--color-accent)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--color-amber)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--color-coral)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta], color: "var(--color-muted)", fontStyle: "italic" },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: "var(--color-accent)", opacity: "0.85" },
  { tag: [t.heading], color: "var(--color-accent)", fontWeight: "600" },
  { tag: [t.typeName, t.className, t.tagName], color: "var(--color-coral)", opacity: "0.9" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--color-text)" },
  { tag: t.invalid, color: "var(--color-coral)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.link, textDecoration: "underline" },
]);

const legacy = async (load: () => Promise<StreamParser<unknown>>) => StreamLanguage.define(await load());

/** The language for a file name; plain text when unknown. */
async function languageFor(name: string): Promise<Extension> {
  const ext = extOf(name);
  const lower = name.toLowerCase();
  try {
    if (["json", "jsonc", "lock"].includes(ext)) return (await import("@codemirror/lang-json")).json();
    if (["yaml", "yml"].includes(ext)) return (await import("@codemirror/lang-yaml")).yaml();
    if (["js", "mjs", "cjs", "jsx", "ts", "tsx"].includes(ext)) {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ typescript: ext.startsWith("ts"), jsx: ext.endsWith("x") });
    }
    if (ext === "py") return (await import("@codemirror/lang-python")).python();
    if (["xml", "svg"].includes(ext)) return (await import("@codemirror/lang-xml")).xml();
    if (["html", "htm"].includes(ext)) return (await import("@codemirror/lang-html")).html();
    if (["css", "scss"].includes(ext)) return (await import("@codemirror/lang-css")).css();
    if (["md", "markdown"].includes(ext)) return (await import("@codemirror/lang-markdown")).markdown();
    if (ext === "sql") return (await import("@codemirror/lang-sql")).sql();
    if (["sh", "bash", "zsh", "env"].includes(ext) || /^\.(bash|zsh|profile)/.test(name))
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell as StreamParser<unknown>);
    if (ext === "toml") return legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml as StreamParser<unknown>);
    if (lower === "dockerfile" || ext === "dockerfile")
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile as StreamParser<unknown>);
    if (lower.includes("nginx") || (ext === "conf" && lower.includes("site")))
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/nginx")).nginx as StreamParser<unknown>);
    if (["ini", "conf", "cfg", "cnf", "properties", "service", "timer", "socket", "repo"].includes(ext))
      return legacy(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties as StreamParser<unknown>);
  } catch {
    // A language pack that fails to load just means no colours.
  }
  return [];
}

export interface Editor {
  text: () => string;
  /** Replaces the content (Revert); undoable. */
  reset: (text: string) => void;
  setWrap: (wrap: boolean) => void;
  focus: () => void;
  destroy: () => void;
}

export async function createEditor(
  parent: HTMLElement,
  options: {
    text: string;
    name: string;
    readOnly: boolean;
    wrap: boolean;
    onChange: (text: string) => void;
    onSave: () => void;
  },
): Promise<Editor> {
  const language = await languageFor(options.name);
  const wrapping = new Compartment();
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: false }),
    syntaxHighlighting(highlight),
    theme,
    language as LanguageSupport | Extension,
    wrapping.of(options.wrap ? EditorView.lineWrapping : []),
    EditorState.readOnly.of(options.readOnly),
    EditorView.editable.of(!options.readOnly),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (options.onSave(), true) },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) options.onChange(u.state.doc.toString());
    }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: options.text, extensions }) });
  return {
    text: () => view.state.doc.toString(),
    reset: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    setWrap: (wrap) => view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
