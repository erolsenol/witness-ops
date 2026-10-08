# Private browser access through SSH

The operator Mac runs the WitnessOps agent on loopback. A reverse SSH tunnel forwards it to loopback on a trusted SSH host; a viewer opens a second tunnel. The agent is never bound to a public interface.

On the operator Mac:

```sh
WITNESS_SSH_TARGET=operator@example-host.invalid pnpm remote:tunnel
```

On the viewing Mac:

```sh
ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:3848:127.0.0.1:31847 \
  operator@example-host.invalid
```

Open the operator's `witness app` session URL on the viewing Mac, replacing its `127.0.0.1:3847` address with `127.0.0.1:3848` while retaining the `#token=...` fragment. Both SSH sessions must remain active. Anyone who obtains that token and access to the SSH host's loopback port can reach the agent; use trusted accounts and strict host-key checking. Do not expose the remote port publicly.
