# ui-server

[![Publish Docker image](https://github.com/temporalio/ui-server/actions/workflows/docker.yml/badge.svg)](https://github.com/temporalio/ui-server/actions/workflows/docker.yml)

## Development

https://github.com/temporalio/ui-server is automatically updated to mirror
changes to https://github.com/temporalio/ui/tree/main/server; commits should be
made to the UI repository.

For contributions follow UI's development guide https://github.com/temporalio/ui

### Hot Reloading

The development server uses [Air](https://github.com/air-verse/air) for automatic hot reloading when Go source files change. Air will be automatically installed on first run in development mode, which may take a moment.

## Configuration

### Environment banner

Set `TEMPORAL_UI_BANNER_TEXT=PRODUCTION` and `TEMPORAL_UI_BANNER_COLOR=info`
when running the Docker image to show a persistent banner and prefix browser page titles
with `PRODUCTION | `. The banner also appears on the login screen and cannot
be dismissed. Fullscreen tables and payloads cover the banner until they are closed.

Set `TEMPORAL_UI_BANNER_COLOR` to choose a color preset:

```bash
export TEMPORAL_UI_BANNER_TEXT="Test"
export TEMPORAL_UI_BANNER_COLOR="Warning"
```

For a custom YAML configuration or `server/config/development.yaml`, set:

```yaml
banner:
  text: "Test"
  color: "Warning"
```

Supported colors are `neutral` (greyscale), `info` (blue), `warning` (amber),
`success` (green), `danger` (red), `error` (orange), and `accent` (purple).
Values are case-insensitive and surrounding whitespace is ignored.
Both text and color are required. Missing, empty, or invalid values disable
the banner and page-title prefix without causing an error. Presets use the UI's existing
background, border, and text colors, adapting to light and dark themes. Custom colors
are not supported.

The development configuration uses literal strings. To read environment
variables instead, use the following in a configuration with `# enable-template`
at the top, as in the Docker configuration:

```yaml
banner:
  text: {{ env "TEMPORAL_UI_BANNER_TEXT" | yamlString }}
  color: {{ env "TEMPORAL_UI_BANNER_COLOR" | yamlString }}
```

Use a single-line plain-text label. Quotes, ampersands, colons, newlines, and
control characters are not supported; labels containing them disable the banner.
The `yamlString` template helper safely quotes environment values so invalid
banner values cannot break YAML parsing.

Restart the UI server after changing the environment variable and reload
open browser tabs.

### CORS Settings

The server supports flexible CORS configuration through YAML config files:

```yaml
cors:
  allowOrigins:
    - "https://example.com"
    - "https://app.example.com"
  unsafeAllowAllOrigins: false  # Default: false
  cookieInsecure: false
```

**Configuration Options:**

- `allowOrigins`: List of explicitly allowed origins for CORS requests
- `unsafeAllowAllOrigins`: **⚠️ UNSAFE** - When `true`, allows any origin that makes a request. Only enable for development/testing environments
- `cookieInsecure`: Allow CSRF cookies over insecure connections (useful for VPN scenarios)

**Security Note:** The `unsafeAllowAllOrigins` setting bypasses CORS security and should never be enabled in production. It dynamically allows the requesting origin, which can expose your API to cross-origin attacks.

## To View gRPC routes:
[Temporal API Workflowservice](https://github.com/temporalio/api/blob/master/temporal/api/workflowservice/v1/service.proto)

## Drasi gateway

The UI server registers the vendored WatchService and PluginService HTTP gateways
on its existing Temporal gRPC connection, before the WorkflowService wildcard
route. The standalone contract at `../vendor/watch-contract` must be present when
building the server; `go.mod` uses a relative module replacement.

Namespace Sources, Queries, Watches, and deliveries use
`/api/v1/namespaces/{namespace}/drasi/...`; the cluster Plugin catalog and
installations use `/api/v1/drasi/plugins/...`. Configured `publicPath` prefixes
are handled by the existing routing middleware. Responses use standard protobuf
JSON (flattened oneofs, full enum names, base64 bytes, and string uint64 values),
not Temporal's custom JSON marshaler, and are marked `Cache-Control: no-store`.

The gateway preserves per-request API middleware and credential forwarding,
including Authorization, authorization-extras, and Caller-Type. The backend must
implement both services and enforce each method's namespace read/write or cluster
read/admin authorization using the contract policy. Local UI token checks and
capability responses are not authorization substitutes; every call goes to the
backend, including when UI authentication is disabled. A backend without these
services returns the ordinary gRPC Unimplemented HTTP error.

`disableWriteActions` uses the contract method policy to block all mutations,
including Plugin install/load. Read-only POST ValidateQuery and PreviewQuery
remain available. Existing global CSRF rules also apply to these POSTs. HTTP
bodies are limited to the contract's 1 MiB maximum before JSON decoding; decoded
Watch/Plugin requests are structurally validated and size-limited before gRPC
dispatch. WorkflowService's existing request limits and marshaler are unchanged.

To run only the gateway against a local backend using the existing Docker
configuration, run from `server/`:

```bash
TEMPORAL_ADDRESS=127.0.0.1:7233 \
TEMPORAL_UI_PORT=8081 \
TEMPORAL_UI_PUBLIC_PATH=/temporal \
TEMPORAL_DISABLE_WRITE_ACTIONS=false \
TEMPORAL_UI_ENABLED=false \
TEMPORAL_AUTH_ENABLED=false \
TEMPORAL_CSRF_COOKIE_INSECURE=true \
go run ./cmd/server --env docker start
```

Use the backend's gRPC address in `TEMPORAL_ADDRESS`; URLs in this example begin
with `http://localhost:8081/temporal/api/v1/`. For a separate UI origin, set
`TEMPORAL_CORS_ORIGINS` to that exact origin. Insecure CSRF cookies are for local
HTTP development only. Enabling UI authentication requires the existing OIDC
provider configuration; disabling it does not bypass backend authorization.
The existing embedded UI assets must be generated before compiling the server,
even when `TEMPORAL_UI_ENABLED=false`.
