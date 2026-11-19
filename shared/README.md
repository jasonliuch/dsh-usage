# shared — build preset copied from the upstream monorepo

These two files are **not** original to this repository. They are the shared
client-bundle build preset from the DeepSeek Harness web plugin monorepo, copied
here so the package can build and typecheck without that monorepo.

| File | Origin |
|---|---|
| `tsdown.client.ts` | `zhu1090093659/dsh-web` → `shared/tsdown.client.ts` |
| `web-platform.ts` | `zhu1090093659/dsh-web` → `shared/web-platform.ts` |

**Copied from commit:** `d665f58d8ff3758f92b757c709792edc7e290b3b`
(`jasonliuch/dsh-web`, branch `feat/vnc-platform-auth`)

**Licence:** Apache-2.0, see the repository `LICENSE`.

## Why they live here

Upstream keeps one preset for every plugin in the monorepo, and each package's
`tsdown.config.ts` imports it through a relative path
(`../../shared/tsdown.client.ts`). Extracting one package into its own
repository means that path no longer resolves, so the two files travel with the
package and `tsdown.config.ts` imports `./shared/tsdown.client.ts` instead.

`web-platform.ts` is reached by `tsdown.client.ts` through `./web-platform.ts`,
so it has to sit beside it.

## Keeping them current

Upstream changes these rarely, and only for build mechanics (the browser
platform module list, the CSS-module inliner, the bundle purity gate). When
upstream moves:

1. Diff upstream `shared/tsdown.client.ts` and `shared/web-platform.ts` against
   these copies.
2. Copy the new versions over.
3. Rebuild and re-run the test suite: `pnpm build && pnpm test`.

Do not edit these two files to fix a package problem — a local divergence means
the bundle no longer matches what the host expects.
