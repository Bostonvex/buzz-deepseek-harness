# Security

The bridge accepts only the local Buzz `buzz-dev-mcp` executable configured at
installation time. It rejects alternate executables, non-stdio transports,
arguments, duplicate environment keys, and environment keys outside the Buzz
allowlist. Relay credentials are passed directly to the child process and are
never written by this project.

Please report vulnerabilities privately to the repository owner rather than
opening a public issue containing credentials or exploit details.
