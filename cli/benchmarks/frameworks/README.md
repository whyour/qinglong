# CLI framework evaluation

These are evaluation dependencies, not application runtime dependencies. The user removed Node 18 as a selection constraint; this comparison targets modern Node releases. Use Node 24 (measurements use 24.18.0). Commander 15 requires Node >=22.12.0.

From the repository root:

```sh
# Use a saved dist from BEFORE the Commander migration.
export QL_FRAMEWORK_NATIVE_DIST=/absolute/path/to/pre-commander/dist
npm ci --prefix cli/benchmarks/frameworks --ignore-scripts --no-audit --no-fund
QL_FRAMEWORK_DEPS="$PWD/cli/benchmarks/frameworks" node cli/scripts/benchmark-frameworks.cjs
```

Alternatively copy package.json and package-lock.json to an isolated directory, run npm ci there, and point QL_FRAMEWORK_DEPS to it. Evaluation dependencies were installed in `/tmp/ql-framework-eval` for the recorded run; application manifests and lockfiles were not changed.

The prototype registers the existing command specifications for Commander, CAC and Yargs. The native candidate calls the saved pre-Commander parser. The snapshot is required to avoid accidentally measuring Commander as the native baseline. Each measured parse handles `task list --search example --page 2 --size 20 --json`, asserting the normalized result. A shared registry/validation scaffold is loaded by all workers, including the baseline. The baseline is **not an empty Node process**. CAC uses an adapter for two-token command groups. The prototypes do not implement the complete QingLong compatibility/error/help contract.

Fresh-process wall time includes Node startup, module loading, command construction, parsing/validation, JSON serialization and process exit. Each scenario has two warmups and 21 measured processes per candidate, with rotating order. Filesystem caches are warm; this is not a cold-disk benchmark. Peak RSS is reported for the entire child process. P95 uses nearest rank. Help layouts and output lengths differ, so help times are indicative, not byte-equivalent comparisons.

Warm measurements rebuild the command tree on every call (20 warmups, then 200 calls per batch, five batches). They are construction-plus-parse costs, not steady-state throughput of a reused parser. Installed bytes count package files including documentation/types and all transitive dependencies, not compressed npm archive size or physical disk blocks. No network requests to panels, actual maintenance or user script execution occur.

The result is a framework-selection experiment, not a measured replacement of the entire production CLI. The raw JSON records exact versions, dependency trees and all samples. The existing application is unchanged by running it.

## Optional Commander bundle

The recorded bundle uses esbuild 0.28.2 (build-time only), minification, CJS output and a Node 22 target. It exports the entire Commander module, so its 40,575-byte JS size is not based on selecting just one tiny API. This excludes LICENSE and source maps/types/docs; a real release must retain the dependency license.

```sh
npm install --prefix /tmp/ql-framework-build --ignore-scripts --no-audit --no-fund --save-exact esbuild@0.28.2
QL_FRAMEWORK_DEPS="$PWD/cli/benchmarks/frameworks" node cli/scripts/bundle-framework.cjs
QL_FRAMEWORK_DEPS="$PWD/cli/benchmarks/frameworks" QL_FRAMEWORK_INCLUDE_BUNDLE=1 node cli/scripts/benchmark-frameworks.cjs
```

`QL_FRAMEWORK_BUILDER` can override the builder package directory. The optional bundled candidate is measured in the same rotating sample rounds as unbundled candidates. No application source imports the prototypes or benchmark dependencies.
