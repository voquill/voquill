# Tray language menu is TypeScript-driven

The tray's dictation-language submenu is built and kept in sync by TypeScript, not Rust. TypeScript computes the menu model (language code + display label + checked flag) from app state and pushes it to Rust via a command; Rust only rebuilds the native submenu from that list and emits an event when an item is clicked. A TypeScript side-effect re-pushes the menu whenever the Active Dictation Language or the configured language set changes.

## Why

The repo rule is "Rust is the API, TypeScript is the Brain" — decision logic and the canonical language list/labels already live in TypeScript (`language.utils.ts`). The alternative, having Rust read preferences from SQLite and build the menu itself, would duplicate that language data in Rust and let it drift. The push model also means a single mechanism keeps the tray correct after both a tray click and a settings edit. The existing `set_menu_icon` command (which toggles a tray item from TypeScript) is the precedent; this extends the same pattern from one item to a rebuildable submenu.
