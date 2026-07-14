# dumbridge

dumbridge gives a disposable cloud agent temporary, live, read-only access to one local directory.

## Language

**Served root**:
The one canonical local directory visible through a running bridge.
_Avoid_: Share, mount, host filesystem

**Bridge process**:
The foreground local process that owns access to a served root. Stopping it ends access.
_Avoid_: Daemon, server account

**Bridge key**:
The opaque bearer credential minted by serve, encoding a transport locator plus capability, valid only while serve runs.
_Avoid_: Bridge link, share URL, API key, pairing

**Remote read shell**:
A Bash-shaped interpreter over the served root whose writes are discarded. It is not the host shell.
_Avoid_: Remote shell, SSH

**Run**:
Evaluate one script in the remote read shell and return its bounded output.
_Avoid_: Exec, command endpoint

**Pull**:
Copy one selected file or directory from the served root into the remote working directory.
_Avoid_: Download, sync

**Remote path**:
The canonical, Windows-safe relative path that selects one file or directory below the served root; both bridge sides accept and reject the same remote paths.
_Avoid_: Safe relative path, source path, virtual path

**Skill guide**:
The bundled agent usage instructions that `dumbridge skill` prints without contacting a bridge.
_Avoid_: Docs command, manual
