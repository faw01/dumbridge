# dumbridge

dumbridge gives a disposable cloud agent temporary, live, read-only access to one local directory.

## Language

**Served root**:
The one canonical local directory visible through a running bridge.
_Avoid_: Share, mount, host filesystem

**Bridge process**:
The local process that owns access to a served root, foreground by default. Stopping it ends access.
_Avoid_: Daemon, server account

**Detached serve**:
A bridge process started with `serve --detach` that runs without a terminal until `serve --stop`. Several may run at once, at most one per served root. Its death still revokes the bridge key.
_Avoid_: Daemon, background service

**Bridge key**:
The opaque bearer credential minted by serve, encoding a transport locator, capability, and expiry deadline, valid only while serve runs and before that deadline.
_Avoid_: Bridge link, share URL, API key, pairing

**Key TTL**:
The configurable duration a bridge key stays valid after serve mints it; it fixes the expiry deadline the bridge process enforces on every session.
_Avoid_: Session timeout, token expiration, key rotation

**Remote read shell**:
A Bash-shaped interpreter over the served root whose writes are discarded. It is not the host shell.
_Avoid_: Remote shell, SSH

**Run**:
Evaluate one script in the remote read shell and return its bounded output.
_Avoid_: Exec, command endpoint

**Pull**:
Copy one selected file or directory from the served root into the remote working directory.
_Avoid_: Download, sync

**Connection path**:
The route a session's bytes travel: direct (peer-to-peer) or via relay. Run and pull report the path selected at connect time in one stderr line; a relayed session may later upgrade to direct without a new report.
_Avoid_: Route, network path, transport mode

**Dial sequence**:
The connect-time attempt behind one run or pull: the paths attempted, the relay used, and each outcome. Logged on stderr at debug level; a failed dial is reported by its observed cause.
_Avoid_: Connection log, handshake trace, dial log

**Remote path**:
The canonical, Windows-safe relative path that selects one file or directory below the served root; both bridge sides accept and reject the same remote paths.
_Avoid_: Safe relative path, source path, virtual path

**Sanitized root display**:
The bounded, control-character-free final component of the served root's path; the only fragment of the host path any message crossing the bridge may show. Local serve messages may name full roots: they are the stop selectors.
_Avoid_: Root name, host path, display path

**Root banner**:
The one-line notice the first run against a bridge prints, naming the served root by its sanitized root display.
_Avoid_: Welcome message, MOTD, header

**Doctor**:
The no-key, no-session environment diagnosis `dumbridge doctor` prints, exiting non-zero when any diagnosis check fails.
_Avoid_: Health check, preflight, connectivity test

**Diagnosis check**:
One self-descriptive doctor result carrying a name, an ok/warn/fail status, and a detail; warn marks a degraded-but-workable path, fail an environment that cannot reach a bridge.
_Avoid_: Probe result, status code, health status

**Skill guide**:
The bundled agent usage instructions that `dumbridge skill` prints without contacting a bridge.
_Avoid_: Docs command, manual
