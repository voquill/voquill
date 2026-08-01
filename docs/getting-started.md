# Getting Started

Commands in this guide run from the repository root unless a section says
otherwise.

## Repository layout

| Path                     | Description                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`           | Tauri desktop app. React and TypeScript own the UI, state, and business logic; Rust exposes native capabilities. |
| `apps/desktop/src-tauri` | Rust commands for audio, keyboard input, SQLite, Whisper, updates, and other native integrations.                |
| `apps/windows-installer` | Windows installer built with Tauri.                                                                              |
| `apps/docs`              | Astro and Starlight documentation site.                                                                          |
| `enterprise/admin`       | React and Vite enterprise administration dashboard.                                                              |
| `enterprise/gateway`     | Enterprise API gateway.                                                                                          |
| `mobile`                 | Flutter mobile app for iOS and Android. This is outside the pnpm workspace.                                      |
| `cli`                    | Rust command-line application.                                                                                   |
| `packages`               | Shared TypeScript and Rust packages used by the applications.                                                    |
| `release`                | Release notes and promotion instructions.                                                                        |
| `docs`                   | Architecture notes and contributor documentation.                                                                |

The pnpm workspace membership is defined in
[`pnpm-workspace.yaml`](../pnpm-workspace.yaml). See
[`desktop-architecture.md`](desktop-architecture.md) for the desktop data flow
and ownership boundaries.

## Prerequisites

### Node.js and pnpm

[`package.json`](../package.json) supports Node.js 18 or newer, but contributors
should install the Node.js version selected by [`.nvmrc`](../.nvmrc), currently
Node.js 24. The repository pins its pnpm version in the `packageManager` field
of [`package.json`](../package.json).

With [nvm](https://github.com/nvm-sh/nvm):

```sh
nvm install
nvm use
corepack enable
pnpm install --frozen-lockfile
```

Run pnpm from the repository root so it uses the pinned version and the shared
lockfile.

### Native toolchains

- Install Rust with [rustup](https://rustup.rs/) for the desktop app, Windows
  installer, CLI, and Rust packages.
- Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your operating system. Linux and Windows contributors can use the
  repository scripts described in the desktop section below.
- Install a Flutter SDK whose Dart version satisfies
  [`mobile/pubspec.yaml`](../mobile/pubspec.yaml), plus Xcode and CocoaPods for
  iOS or the Android SDK for Android.

## JavaScript and TypeScript workspaces

The root manifest exposes the Turborepo tasks used across pnpm workspaces:

```sh
pnpm run build
pnpm run lint
pnpm run check-types
pnpm run test
```

Turbo runs only scripts exposed by each workspace. Use a pnpm filter when
working on one application or package. The full test task also runs desktop
evals and gateway tests, so it needs the credentials and services described in
those sections.

## Desktop app

On Linux, install the native dependencies:

```sh
./apps/desktop/scripts/setup-linux.sh
```

On Windows, run the setup script from an elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/setup-windows.ps1
```

Pass `-EnableGpu` to the Windows script, or set
`VOQUILL_ENABLE_GPU=1` before running the Linux script, to install the optional
Vulkan build dependencies.

Start the desktop app with the platform selected automatically:

```sh
pnpm --filter desktop run dev
```

The development command uses the emulator flavor by default. Set
`VITE_FLAVOR=dev` to use the hosted development services. The available
flavors and commands live in
[`apps/desktop/package.json`](../apps/desktop/package.json) and the checked-in
`apps/desktop/.env.*` files.

Validate desktop changes with:

```sh
pnpm --filter desktop run build
pnpm --filter desktop run lint
pnpm --filter desktop run test:unit
```

`pnpm --filter desktop run test` additionally runs integration tests and evals
that require `GROQ_API_KEY`.

## Documentation site

The docs site's commands are defined in
[`apps/docs/package.json`](../apps/docs/package.json):

```sh
pnpm --filter docs run dev
pnpm --filter docs run check-types
pnpm --filter docs run build
```

The development server listens on port 3490.

## Windows installer

Build the installer on Windows after the desktop app has produced its installer
input:

```sh
pnpm --filter @voquill/windows-installer run tauri:build
```

The installer workflow and its other commands live in
[`apps/windows-installer/package.json`](../apps/windows-installer/package.json).

## Enterprise apps

Run and validate the admin dashboard:

```sh
pnpm --filter admin run dev
pnpm --filter admin run lint
pnpm --filter admin run build
```

Run and validate the gateway:

```sh
pnpm --filter @repo/enterprise-gateway run dev
pnpm --filter @repo/enterprise-gateway run check-types
pnpm --filter @repo/enterprise-gateway run test
pnpm --filter @repo/enterprise-gateway run build
```

These commands are owned by
[`enterprise/admin/package.json`](../enterprise/admin/package.json) and
[`enterprise/gateway/package.json`](../enterprise/gateway/package.json). The
gateway tests require PostgreSQL. They use `DATABASE_URL` when set and otherwise
connect to `postgres://postgres:postgres@localhost:5432/voquill`.

## Shared packages

The root build compiles shared packages before their consumers. To work on one
package, filter by the name in its manifest:

```sh
pnpm --filter @voquill/types run build
pnpm --filter @voquill/functions run build
```

Rebuild `@voquill/types` or `@voquill/functions` after changing them so
downstream workspaces see the updated output.

## Mobile app

The mobile app is a separate Flutter project and does not use pnpm. Prepare it
from a fresh clone with:

```sh
cd mobile
flutter pub get
cp .env.example .env
./generate.sh
```

Replace the placeholder values in `.env` before launching the app. The
available flavors are `dev`, `emulators`, and `prod`; each has a matching entry
point under `mobile/lib`.

```sh
flutter run --flavor dev -t lib/main_dev.dart
flutter analyze
flutter test
```

Build release artifacts with the helper script:

```sh
./deploy.sh ios prod
./deploy.sh android prod
```

The script calls `flutter build ipa` for iOS and `flutter build appbundle` for
Android. iOS packaging requires macOS, Xcode, CocoaPods, and signing configured
for the selected flavor.

## CLI

The CLI is a standalone Rust crate:

```sh
cargo build --manifest-path cli/Cargo.toml
cargo test --manifest-path cli/Cargo.toml
```

## Releases and CI

Pushes to `main`, `prod`, and `enterprise` are orchestrated by
[`.github/workflows/release.yml`](../.github/workflows/release.yml). That
workflow owns the component filters, release channels, and reusable workflows.
See [`release/README.md`](../release/README.md) for promotion and rollback
instructions and [`desktop-release.md`](desktop-release.md) for desktop release
details.

## Additional documentation

- [Desktop architecture](desktop-architecture.md)
- [Desktop release guide](desktop-release.md)
- [Local model integration](local-model-integration.md)
- [Resources](resources.md)

Unless otherwise noted, Voquill is released under the AGPLv3. See
[`LICENCE`](../LICENCE) for the complete terms and third-party attributions.
