# Security

Use **Security → Report a vulnerability** on GitHub to submit a private report.
Include the affected version or commit, the impact, and enough detail for the
maintainers to diagnose the issue. Use synthetic data and redact credentials.
Keep sensitive details in the private report.

Use HTTPS, a unique randomly generated `BETTER_AUTH_SECRET`, and private
database and storage services for any internet-facing instance. Use a fresh
database for real deployments and keep demo accounts on isolated test instances.
See the [self-hosting guide](docs/self-hosting.md) for configuration and backups.

Password changes and completed password resets revoke personal API tokens.
If a member's AI provider key was compromised, revoke it at the provider.
