# Upstream provenance

- Repository: https://github.com/NdoleStudio/httpsms
- Revision: `b4527e8a572eb0d12ca1b75ad5ee2f25a94808ca`
- Adaptation date: 2026-10-12
- License: AGPL-3.0, retained in the root `LICENSE`.

The new gateway in `src/gateway/` and `netlify/functions/` adapts the outbound flow and Android contracts into TypeScript, Firebase Admin SDK, and Firestore. The upstream Go/SQL/Redis backend is not deployed by the root Netlify configuration.

All Android files, including application logic, resources, build files, and Firebase configuration, are preserved byte-for-byte. No APK was rebuilt or configured as part of this milestone. The Go API, web app, Android app, and original integration suite remain for reference and future development. The original README is preserved in `docs/UPSTREAM_README.md`.

New gateway code and documentation use AGPL-3.0-only. Publish the corresponding source of the deployed fork and supply its URL through `SOURCE_CODE_URL`.
