# Dumbridge

Dumbridge gives a disposable cloud agent temporary, live, read-only access to one local directory.

## Language

**Served root**:
The one canonical local directory visible through a running bridge.
_Avoid_: Share, mount, host filesystem

**Bridge process**:
The foreground local process that owns access to a served root. Stopping it ends access.
_Avoid_: Daemon, server account

**Bridge link**:
A secret, short-lived bearer value that tells a remote Dumbridge client how to reach and authenticate to a bridge process.
_Avoid_: Share URL, API key, pairing

**Remote read shell**:
A Bash-shaped interpreter over the served root whose writes are discarded. It is not the host shell.
_Avoid_: Remote shell, SSH

**Run**:
Evaluate one script in the remote read shell and return its bounded output.
_Avoid_: Exec, command endpoint

**Pull**:
Copy one selected file or directory from the served root into the remote working directory.
_Avoid_: Download, sync
