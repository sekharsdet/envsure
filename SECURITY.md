# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub:
**Security → Report a vulnerability** on https://github.com/sekharsdet/envsure.
Do not open a public issue for a vulnerability.

You can expect an acknowledgement within 3 working days. Fixes are released as a patch version and the
`v1` tag is moved to it.

## Supported versions

The latest `v1.x` release. `uses: sekharsdet/envsure@v1` always points to it.

## What EnvSure guarantees

See [Security model](README.md#security-model) in the README: EnvSure reads names only, a pull request
cannot change its own check, untrusted file names and API responses are handled safely, tokens are only
sent to the platform they belong to, and a broken API cannot hang your CI.
