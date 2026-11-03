# Drasi in Temporal UI

The fork's native namespace pages live at
`/namespaces/{namespace}/drasi/sources`, `/queries`, and `/watches` under that
Drasi prefix. Cluster plugin discovery and installation live at `/drasi/plugins`.
Use the Go gateway in `server/`, not the stock Temporal CLI UI server: the
standalone Watch and Plugin API contracts are not part of WorkflowService.

## Availability and access

Namespace and cluster capabilities are fetched independently. Navigation and
controls use the serving backend's caller-filtered `allowedMethods`; descriptor
presence does not imply runtime support. Namespace access does not imply cluster
plugin-read or administrator access. The backend remains the authorization
authority for every request. Browser hiding is not an authorization boundary.

The normal UI auth/CSRF request hooks, deployment base path, Go gateway credential
forwarding, and global write-disable setting apply. Query validation and bounded
preview are read operations despite using POST. Unsupported preview or source
readiness stays disabled rather than returning synthetic data.

## Sources, queries, and watches

The builtin Temporal source covers committed workflow, activity lifecycle, and
timer state without raw payloads or heartbeat streams. It needs no plugin.
External sources and their separate optional bootstrap component are selected
from supported descriptors observed loaded on every reported host. Configuration
uses the descriptor's JSON Schema with local references; external references are
rejected. Only bounded declarative `x-ui` labels/help text are used, rendered as
text, never HTML or executable widgets.

Secret fields use a separate map of immutable `{provider, key, version}`
references. Enter no plaintext credentials. Source updates explicitly rotate
references; source and bootstrap configuration cannot use SDK environment/secret
interpolation forms. References are not stored in browser local storage.
Schema checking combines only a local structural SDK Secret reference for each
top-level immutable reference, verifies that the actual schema accepts that
shape, and rejects configuration/reference key overlap. Only the original
non-secret configuration and separate immutable reference map are transmitted.

Queries pin source IDs and immutable revisions. Language, persistent state store,
preview limit, and validation availability come from actual capabilities.
Preview rows are bounded observations, not atomic cross-source snapshots.

Recurring watches default to ignoring existing rows, with opt-in inclusion and
Enter/Update/Leave triggers. New watches expose native Start, Signal, and
SignalWithStart forms; input arguments use Temporal `json/plain` payloads.
One-shot watches are ENTER-only, require a future deadline and exact owner run,
and signal that same owner. They can satisfy immediately after consistent
bootstrap even when recurring initial results default to Ignore. Editing an
existing watch uses its full generated wire specification to preserve custom
payload encodings, timeouts, and policies without lossy conversion.

Mutations carry expected revisions and request identities. Retrying the same
failed command in the mounted page retains its request identity. Accepted
control-plane intent is displayed separately from observed state and workflow
effects. Deliveries are at least once with scoped deduplication, not exactly
once. Ambiguous retry requires explicit acceptance of duplicate-effect risk.
Reset requires confirmation and an explicit choice of existing-result behavior.

## Trusted plugins

Discovery only searches administrator-configured OCI/local catalog IDs.
Installation uses the catalog's pinned version and digest. Advertised signer,
ABI compatibility, signature verification, desired loading, and observed host
loading are distinct. Unknown or absent host observations never imply success.
Replacement is restart-required; the UI has no upload, arbitrary registry/path,
trust override, browser JavaScript, or unsafe unload control.

The development API contract is unsigned and unpublished; its checksum and
shared Go/TypeScript consumption are documented in `vendor/README.md`. It is not
a signed native plugin release.

## Verification

```sh
node scripts/verify-watch-contract.mjs
pnpm exec vitest run src/lib/drasi src/lib/services/drasi-service.test.ts src/lib/components/drasi/watch-form.svelte.test.ts
pnpm check
pnpm lint
pnpm build:server
```

End-to-end verification must use the parent server fork's CGO build, separate
native Watch role, real SDK worker, and this Go gateway. Do not use the stock
Temporal CLI or mocked API routes as proof. A successful PostgreSQL scenario
additionally requires compatible, trusted signed source and separate bootstrap
plugins. Plugin intent acceptance or a test-only resident native handle does
not satisfy that requirement.

Run the retained real-service browser mode with supported Node, pnpm, Go, and
Playwright Chromium installed:

```sh
DRASI_SERVER_WORKTREE=/absolute/path/to/temporal-drasi pnpm test:drasi
```

This builds the fork's native CGO library, starts its opt-in `TestDrasiUIFixture`
with the real SDK worker, builds/starts this Go gateway, and drives the native
pages. The configured signed test catalog defaults to the server fork's
`native/drasi/tests/postgres-catalog.json`; `DRASI_PLUGIN_CONFIG` can select
another administrator-prepared catalog configuration. Artifacts must still pass
native trust/admission checks.

To reuse a parent-owned live fixture instead, set `DRASI_FIXTURE_MANIFEST` to its
private manifest path:

```sh
DRASI_UI_PORT=8086 \
DRASI_FIXTURE_MANIFEST=/absolute/path/to/private/ui-fixture.json \
pnpm test:drasi
```

The runner never prints the manifest's bearer token or stops a reused fixture.
It stops services it owns on completion. `DRASI_UI_PORT` selects the gateway
port (default 8085). Each browser run scopes its query to a unique real producer
and creates its own exact-run signal owner, so earlier completed workflows do
not satisfy a later run's assertions.

The retained scenarios cover builtin Source/Query readiness, recurring Start
delivery and completed execution, exact-run once Signal with actual history,
and SignalWithStart delivery with a completed target. Trusted catalog discovery
and metadata are checked separately. If metadata already reports incompatibility,
the default negative scenario requires the actual diagnostic, a disabled install
button, no component schemas, and no install/load request. If metadata is
compatible but the binary is not, it exercises install/load intents and requires
an actual per-host refusal. Neither branch fabricates host observations or
accepts `LOADED`. The fixture's external-source readiness must remain false, an explicit
limitation, not a passed PostgreSQL scenario. An accepted install or load
request is never treated as proof that a plugin is loaded.

Sanitized screenshots are retained at workspace-relative paths
`audits/drasi-real-watch-delivery.png` and
`audits/drasi-real-plugin-refusal.png`. They contain observed delivery/refusal
state, not the private control manifest or credentials. Playwright traces are
disabled so authenticated fixture control requests are not captured.

### Opt-in positive PostgreSQL proof

The default browser mode above remains the builtin/refusal proof. A separate
positive PostgreSQL mode requires a parent-owned real fixture with compatible,
trusted signed source and separate bootstrap plugins:

```sh
DRASI_POSTGRES_E2E=1 \
DRASI_FIXTURE_MANIFEST=/absolute/path/to/private/ui-fixture.json \
pnpm test:drasi
```

This selects `playwright.drasi-postgres.config.ts` and only the positive
PostgreSQL scenario. An enabled mode with missing fixture data, incompatible
plugins, absent verified `LOADED` host observations/descriptors, or unavailable
external-source capability fails; it never silently skips or falls back to the
builtin proof. No publication, signing, trust changes, test-only resident
handles, or mocked API responses are performed.

Owned-server mode still starts the same `TestDrasiUIFixture`; the runner maps
this opt-in to `TEMPORAL_DRASI_UI_POSTGRES=1`. For a manually started borrowed
fixture, the parent must set that server-side environment variable itself.
The backend requires an existing explicitly reviewed managed source/bootstrap
pair before launching PostgreSQL mode. Manifest presence means configured, not
loaded. The browser polls live external-source capability only after actual
verified host loading and descriptor checks for both plugins.

The private manifest adds `postgres.source` and `postgres.bootstrap`, each with
`catalogId`, `id`, `version`, `digest`, `component`, `configuration`, and
`secrets`. Configuration is nonsecret JSON; credential values stay in the
parent's provider. Each separate top-level secret reference supplies
`provider`, `key`, and an exact immutable `version`.

The parent implements two bearer-protected, loopback-only test controls:

| Action                   | Request                    | Response                                                               |
| ------------------------ | -------------------------- | ---------------------------------------------------------------------- |
| `POST /postgres/prepare` | `{runId}` (canonical UUID) | `{runId,source,bootstrap,queryText,bootstrapRow,insertRow,updatedRow}` |
| `POST /postgres/mutate`  | `{runId,operation}`        | `{runId,operation}`                                                    |

Paths are relative to the manifest's `controlURL`. Prepare commits a unique
bootstrap seed before Source creation and returns authoritative per-run source
and bootstrap configurations, including isolated replication resources. Their
catalog/version/digest/component pins must still match the manifest. The query
is run-filtered and projects `{item_id,name,amount}`. The bootstrap row is
`bootstrap`/12; insert creates `inserted`/18; update changes the bootstrap amount
to 24; delete removes the inserted row. Operations are ordered
`insert`, `update`, `delete`; replaying an accepted operation must be a no-op,
including after a later phase. Controls accept no arbitrary SQL.

The browser uses native plugin install/load and descriptor-backed external
Source/bootstrap, Query, and Enter/Update/Leave Watch forms. It verifies actual
current resource revisions, verified host loading, preserved separate
configuration/reference maps, and exact delivered action/query/watch identity.
Each SQL phase waits for the real appended `ResultChange` in the exact
execution's history and SDK completion result. Update also delivers to a fresh
exact-run signal receiver. Control acknowledgments are never effect evidence.
No `PreviewQuery` capability is assumed.

The parent must configure a CDC-only source and genuine separate bootstrap;
the seed is committed before streaming starts. The fixture owns SQL,
replication resources, credential lifetime, and final cleanup. The browser
submits revision-fenced deletion of its own Watches, Query, and Source, reports
cleanup errors without losing the primary failure, and never unloads shared
plugins or stops a borrowed fixture. Positive-mode traces, video, and
screenshots are disabled; private control errors are redacted.

**Status:** this is a retained, opt-in acceptance gate, not a passed PostgreSQL
result. Compatible trusted signed artifacts and the actual credential-backed
fixture are still required before a positive run can be claimed.
