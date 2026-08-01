** Rules **

- Do not propose band-aid fixes to problems. Identify the root cause, be it architectural or logical, and address it directly. Don't be afraid to remove broken code. If something is broken, fix it at the root, even if that means refactoring and overhauling systems (if necessary).
- Enforce DRY code principles. If you find yourself copying and pasting code, stop and refactor it into a reusable function or module.
- Avoid over-engineering. Implement solutions that are as simple as possible while still meeting requirements.
- Your changes should have minimal impact. Do not break existing functionality.
- Write clear, maintainable code that is self documenting. Do not comments on new code except where it's necessary to explain non-obvious things.
- Prefer to follow existing patterns such as dialogs, state management, and API interactions, etc.

** Repository structure **

- This is a Turborepo monorepo. Root-level: `pnpm run build`, `pnpm run lint`, `pnpm run check-types`, `pnpm run test`.
- Shared packages live in `packages/` (types, functions, utilities, etc.). After modifying `packages/types` or `packages/functions`, rebuild them before downstream consumers can see changes.
- Use `<FormattedMessage defaultMessage="..." />` or `useIntl()` for i18n — never pass an `id` prop.

** `apps/desktop` — Tauri desktop app (Rust + TypeScript/React) **

- "Rust is the API, TypeScript is the Brain" — all business logic lives in TypeScript, never duplicated in Rust. Rust provides pure API capabilities without decision-making.
- Single source of truth for state is Zustand (with Immer) in TypeScript.
- Data flow: User/Native Event → Actions (`src/actions/`) → Repos (`src/repos/`) → Tauri Commands (`src-tauri/src/commands.rs`) → SQLite/Whisper/APIs.
- Repos abstract local vs remote: `BaseXxxRepo` defines interface, `LocalXxxRepo` / `CloudXxxRepo` implement. Use `toLocalXxx()` / `fromLocalXxx()` at the Tauri boundary.
- Database migrations go in `src-tauri/src/db/migrations/` as `NNN_description.sql`, registered in `db/mod.rs`.
- New Tauri commands: define in `commands.rs`, register in `app.rs` invoke_handler, create a repo, use in actions.

** `enterprise/gateway` — Enterprise API gateway **

- Handler pattern: if-else chain in `src/index.ts`.
- Scripts: `pnpm run build`, `pnpm run check-types`, `pnpm run test`

** `enterprise/admin` — Enterprise admin dashboard (React) **

- Follows STT provider pattern for new provider types (state, actions, tab, dialog, side effects).
- Scripts: `pnpm run build`, `pnpm run lint`.

** `mobile/` — Flutter mobile app **

- Flutter project at repository root (`mobile/`), not inside `apps/`.
- Uses `flutter run`, `flutter build`, standard Flutter tooling.
- Uses `flutter_zustand` and `draft` for state management, following similar patterns as the desktop app.
- Use `./mobile/generate.sh` to re-generate code.

** `apps/docs` — Documentation site (Astro + Starlight) **

- Scripts: `pnpm run dev`, `pnpm run check-types`, `pnpm run build`.

** `apps/windows-installer` — Windows installer (Tauri) **

- Build on Windows with `pnpm run tauri:build`.

** Important scripts **
