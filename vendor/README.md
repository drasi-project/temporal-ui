# Watch API development contract

`watch-contract.tgz` is the unsigned, unpublished development package supplied by
the Temporal Drasi workstream, not a public release or a trusted native plugin.
SHA256: `5b427db4c7d216a8a5603378a26f94d1fe816e6b4659c04015649200c50dfa9d`.

Run `node scripts/verify-watch-contract.mjs` to verify it. Both languages consume
this same artifact: the npm file dependency exposes generated TypeScript JSON
converters; `watch-contract/` is the archive's `package/` directory, extracted
unchanged for the UI server's relative Go module replacement. Regenerate the
upstream package with `python3 contracts/watch/scripts/package-development.py
--output DESTINATION` in the server fork, then update the archive, extracted
module, checksum, and dependency lock together.

Generated files must not be edited independently. Browser requests use generated
`toJSON` / `fromJSON` converters, not JSON serialization of in-memory protobuf
oneofs. Plugin trust and verification are enforced by the serving backend;
vendoring this API contract grants no plugin execution trust.
