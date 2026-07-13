# Use Bun with Iroh as the first transport

Dumbridge uses Bun as both package manager and runtime, with Effect's Bun platform and Iroh's Node-API binding for encrypted connectivity. The bridge modules hide Iroh-specific behavior so a hosted transport can be added later without changing `serve`, `run`, or `pull`; publishing remains unconfigured until a fresh npm setup exists.
