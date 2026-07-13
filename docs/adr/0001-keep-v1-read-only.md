# Keep v1 local-to-cloud and read-only

Dumbridge v1 exposes one served root to a remote agent and never accepts writes to the local machine. This rejects bidirectional sync and host-shell execution so a leaked bridge link grants bounded reads rather than arbitrary local mutation.
