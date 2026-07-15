# Open issues

## Engine release signing and deployment access are not connected

The code and GitHub workflow can build signed Windows and Linux engine packages,
but GitHub has no configured copy of the existing protected private signing key
or Railway project token. Railway has the matching public verification key and
the API deployment target is documented. The API cannot serve a production
release until the signed files and manifests are deployed with it to Railway.

Next action: locate the original private half of Railway's existing engine
release key in its approved secret store (do not paste it in chat), then add it
to the `engine-release` GitHub environment and connect a scoped Railway project
token as documented in `docs/ENGINE_RELEASE_OPERATIONS.md`.

Evidence required to close: a protected build produces both signed platform
packages, Railway has the matching public key and four files, and authenticated
downloads succeed for both `platform=windows` and `platform=linux`.
