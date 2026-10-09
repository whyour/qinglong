# Production dependency validation

Date: 2026-10-10. Source baseline: `68ffa106f80a2080ddd9b48affe0d7a7489e4d05` on `develop`.

The baseline frozen production lockfile reported 4 Critical, 48 High, 56 Moderate and 14 Low advisory matches across 410 dependencies. After the targeted updates, `pnpm audit --prod --json` reports zero matches at every severity across 368 dependencies. These counts describe the dependency advisory database at the time of verification; they are not a replacement for application security review.

## Changes

- Update the HTTP parser, compression, upload, YAML, Lodash, Sequelize, gRPC and Undici dependencies to patched versions while retaining their supported release lines. Use Undici 7 for the existing Node 20 runtime, rather than Undici 8's newer Node requirement.
- Upgrade Nodemailer to 10.0.16, including the address parser and OAuth2 TLS fixes. Nodemailer 10 requires Node 20; backend type checking and local message generation are included in validation.
- Pin patched indirect dependencies with scoped pnpm overrides. Keep old path-to-regexp, Joi, brace-expansion, picomatch and Undici consumers on compatible release lines.
- Remove the unused direct `http-proxy-middleware` production dependency. There are no imports or calls in the backend, frontend, CLI or shell sources. This removes its `micromatch -> braces` chain from the production graph; braces 3.0.3 has no upstream patch. Umi's development proxy remains managed by Umi's own development dependencies.
- Upgrade the SQLite installation chain to `@mapbox/node-pre-gyp@2.0.3` and `tar@7.5.22`. Retain the existing `@whyour/sqlite3@1.1.2` binary package and N-API ABI. The SQLite source extractor uses the supported synchronous `tar.extract` API.
- Replace nested UUID 8 with UUID 11.1.1 for Sequelize and SockJS. Database transactions and a real SockJS/WebSocket exchange verify their production use of the UUID API.

No advisory ignore list or risk acceptance exception was added. Development dependencies are outside the production audit claim.

## Local verification

- Independent Node 20.20.2 installation using the frozen lockfile; no shared node_modules.
- SQLite precompiled download and extraction through the upgraded node-pre-gyp/tar chain succeeded on macOS arm64.
- Forced SQLite source compilation using node-gyp 12.4.0 succeeded on macOS arm64, followed by the same production protocol checks. The local SDK required its C++ include directory to be supplied explicitly; no global toolchain setting was changed.
- Complete regression: 497 passed, 7 platform-dependent skips, zero failures.
- Backend TypeScript and frontend production builds passed. The existing frontend bundle-size advisory remains.
- `scripts/verify-production-dependencies.cjs` exercises real SQLite reads, Sequelize transactions and updates, protobuf serialization, a local gRPC request, a local SockJS/WebSocket exchange, the Undici ProxyAgent API, JWT signature verification and Nodemailer message generation. Mail uses an in-memory transport; it does not contact recipients or an SMTP service.

## Release verification

The `Release readiness` workflow builds the same four Dockerfile variants and all 24 variant/architecture combinations used by the release workflow, including both Python 3.10 variants. It uses the candidate source SHA and the candidate static artifact, then loads each amd64 image and runs the production dependency check inside it with external networking disabled.

A separate Linux job tests both precompiled SQLite installation and forced source compilation using the SQLite package's declared node-gyp, rather than pnpm 8's bundled older node-gyp. This distinction matters on Python 3.12 and newer.

The workflow does not push images, tags, npm packages, CDN metadata or static mirrors. It runs when a pull request introduces or changes the readiness workflow; subsequent candidates can invoke it manually. A successful run is required evidence for this dependency update, not evidence that a formal version has already been published.

Linux source compilation and the complete image matrix still require CI confirmation; results will be recorded after the candidate run completes.
