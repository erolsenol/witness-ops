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

Open `http://127.0.0.1:3848` on the viewing Mac. Both SSH sessions must remain active. Anyone with access to the SSH host's loopback port can potentially reach the forwarded agent; use trusted accounts and strict host-key checking. Do not expose the remote port publicly.
