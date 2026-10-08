# Security Policy

## Reporting a vulnerability

Please do not file public issues for suspected security vulnerabilities. Use GitHub's private vulnerability reporting for this repository. Include a minimal reproduction and the affected version; do not include live provider tokens or customer data.

## Security boundaries

DeployWitness is designed to observe deployments using read-only provider credentials. It does not deploy or mutate provider resources. Every Vercel API call uses `GET`; use a Vercel token scoped to the required account/team and a read-only role such as Viewer where available. Limit token lifetime and access to the project being checked. Treat provider tokens as secrets and scope them to the smallest read-only permissions available. Do not run workflows that expose deployment secrets on untrusted pull requests.

The project does not claim that a successful check is a signed attestation or a guarantee of application correctness.

HTTP probes resolve all IPv4/IPv6 addresses before connecting and pin the socket to a validated address. Private, loopback, link-local, multicast, and special-use addresses are rejected by default. Localhost HTTP can be enabled per probe for development only. Keep untrusted pull requests from changing probe configuration in workflows that hold provider secrets; use runner/network egress rules as an additional boundary.
