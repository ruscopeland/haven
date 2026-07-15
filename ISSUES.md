# Open issues

## Engine release signing and deployment access are not connected

The code and GitHub workflow can build signed Windows and Linux engine packages,
but this workspace has no configured access to the existing protected signing
key or Railway deployment target. The API cannot serve a production release
until the signed files and manifests are deployed with it to Railway.

Next action: connect the existing GitHub protected environments named in
`docs/ENGINE_RELEASE_OPERATIONS.md`, then run the `engine-release` workflow.

Evidence required to close: a protected build produces both signed platform
packages, Railway has the matching public key and four files, and authenticated
downloads succeed for both `platform=windows` and `platform=linux`.
