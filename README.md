# Easy Craft

[English](./README.md) | [简体中文](./README.zh-CN.md)

A Minecraft Java Edition launcher for **Windows x64**, built with React, TypeScript, Tauri and Rust. Manage game instances, modpacks, local content and world settings from one workspace, with light and dark themes.

**Development version: 0.3.1.** The latest source includes updates through November 1, 2026. Development builds have not completed a full release acceptance cycle. Microsoft sign-in still requires an Easy Craft application Client ID and real-account verification; CurseForge API access requires a separately configured API key.

## Features

- Instance library with search, directory grouping, renaming, local version scanning/import, isolation settings and persistent navigation.
- Vanilla and Fabric installation, Forge/NeoForge installer support within the documented compatibility scope, and ZIP/MRPACK modpack inspection and installation. Downloads use checksums, resumable temporary files and transactional installation.
- Modrinth browsing with resource versions, installation targets and dependency previews. Mods, resource packs, shader packs and world-specific datapacks have separate compatibility checks.
- Automatic Java selection: reuse a compatible local runtime first, then download a verified Mojang Windows x64 runtime if necessary. Explicit instance Java paths are preserved. Downloads support cancellation and retry.
- Per-instance Java and memory settings; automatic memory allocation and optional working-set maintenance.
- Mod management, screenshots, supported world and audio/video settings, and configuration backup previews and restoration.
- Optional CFPA translation resources after modpack installation. Existing translations are checked first; a translation failure does not undo a successful game installation.
- Offline profiles and Microsoft device-code authentication implementation; account refresh tokens use Windows DPAPI encryption.
- Task progress, failure suggestions and previewable diagnostic summaries. Known identities, tokens and local paths are filtered before copying; review reports before sharing.
- Declarative local plugins for tools, appearance and instance checks, with enable/disable, dependency checks and recovery mode.

## Current limits

- Microsoft sign-in is not yet verified end to end with the project's own application registration. Offline profiles do not grant ownership or authenticate to online-mode servers or Realms.
- Automatic Java channels cover 8, 16, 17, 21 and 25; complete download, verification, cancellation, retry and reuse were tested with Java 21. That runtime test did not launch Minecraft.
- General mod translations do not cover every term, modpack quest book or script patch. Some mods already contain Chinese translations.
- Configuration backups are **not full world backups**. Exit the game before editing world files. Hardcore worlds are read-only, and unsupported world formats are rejected.
- Downloading resource/shader/datapacks does not guarantee in-game activation. Compatibility checks cover declared metadata, not every runtime interaction.
- Plugins do not provide an arbitrary third-party code execution environment.
- **Closing the launcher ends games started by it. Save and exit your world first.**

See the dated [implementation records](docs/IMPLEMENTATION_STATUS.md) for supported combinations and evidence. Earlier documents describe the state at their respective dates.

## Run locally

Prepare Node.js/npm and the Windows toolchain described in [Windows toolchain setup](docs/WINDOWS_TOOLCHAIN.md). The repository uses a portable toolchain under `../build-tools/easycraft`; it is not included in Git. The PowerShell wrapper sets process-local paths without changing the global PATH.

From the cloned repository:

```powershell
npm ci
.\scripts\native.ps1 -Action dev
```

The latest locally built desktop executable is `src-tauri/target/debug/easy-craft.exe`. Older release binaries or installers may not match current source.

For a browser preview:

```powershell
npm run dev
```

Open [the local preview](http://127.0.0.1:1420/). Real downloads, authentication and game launch require the desktop app; browser previews do not simulate their success. Demo mode is available at `/?demo=1`.

## First launch

1. Install a game version, import a supported modpack, or scan an existing installation. Installation does not require signing in first.
2. Select a game account using the avatar or launch button. Offline names must contain 3–16 letters, digits or underscores and are case-sensitive.
3. Launch the instance. Automatic Java mode finds or prepares a compatible runtime; select a trusted `java.exe` in instance settings when using a custom runtime.
4. Adjust memory, isolation, local content or supported world settings as needed. Exit the game before editing world configuration.

Changing an offline name or switching account identities changes the player UUID and can affect inventories, progress and ownership. Player data is not automatically migrated.

## Application credentials

For distribution, set the public application GUID in `EASYCRAFT_MICROSOFT_CLIENT_ID` before building. New configurations and existing empty Client IDs use the bundled value; nonempty configurations remain unchanged. This is a **Client ID, not a Client Secret**. Application registration and real sign-in acceptance remain the distributor's responsibility. See [Microsoft's device-code flow documentation](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-device-code).

CurseForge access uses the host environment variable `EASYCRAFT_CURSEFORGE_API_KEY`, read at startup. Do not place an API key in source code, browser configuration, screenshots or public issues. Credential files and local game data are excluded from this repository.

## Build and verify

```powershell
npm run build
npm run typecheck
npm run lint
npm test
npm run test:e2e
.\scripts\native.ps1 -Action check
.\scripts\native.ps1 -Action test
.\scripts\native.ps1 -Action clippy
.\scripts\native.ps1 -Action fmt
.\scripts\native.ps1 -Action build
.\scripts\native.ps1 -Action bundle
```

- `build` in the native wrapper creates a debug desktop executable; `bundle` creates a release executable and NSIS installer under `src-tauri/target/release/bundle/nsis/`.
- Browser tests require Microsoft Edge. Network/system integration tests are separate from regular tests; inspect the verification scripts before running them.
- Latest recorded results: **150 backend tests, 112 frontend tests and 14 browser tests passed**. Twenty backend integration tests are ignored by default; the official Java runtime integration was explicitly run and passed.
- Runtime-only desktop verification: set `EASYCRAFT_RUNTIME_UI_CHECK=1` for the process and run `node scripts/verify-usability-final.mjs`. It uses isolated fixtures and does not launch the game.

## Architecture and data

`src/app` wires services; `src/features` contains UI workflows; `src/core/native-contracts.ts` defines the native interface. Rust modules in `src-tauri/src` implement authentication, downloads, installation, runtime preparation and file operations.

Development uses the project's `data/` directory; standalone executables default to a sibling `data/` directory. Set `EASYCRAFT_DATA_DIR` to choose another location. `settings.json` and `instances.json` store configuration, while `account.dpapi` is bound to the Windows user. Native data is separate from browser demo storage. Invalid configuration files are retained with an error; do not delete the entire data directory to fix an account issue.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) · [Implementation status](docs/IMPLEMENTATION_STATUS.md) · [Roadmap](docs/ROADMAP.md)
- [Automatic Java](docs/AUTOMATIC_JAVA_RUNTIME_2026-11-01.md) · [Launch readiness](docs/FIRST_USE_LAUNCH_READINESS_2026-11-01.md)
- [Translation and Java changes](docs/PACK_AUTO_TRANSLATION_AND_JAVA_2026-11-01.md) · [Plugin management](docs/PLUGIN_MANAGEMENT_2026-11-01.md)
- [Plugin API](docs/PLUGIN_API.md) · [Runtime notices](docs/THIRD_PARTY_NOTICES.md) · [Native notices](docs/NATIVE_THIRD_PARTY_NOTICES.txt)

Most detailed implementation records are currently in Simplified Chinese.
