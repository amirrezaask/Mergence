# Terminal durability testing

The terminal durability suite is failure-oriented. It uses real Node processes,
real local sockets, real WebSockets, and `node-pty`; mocks are reserved for
pure queue, codec, and lease state-machine tests.

## Required scenarios

* host restart leaves the child PID alive and reconnectable;
* client reload restores the current terminal state;
* output larger than the raw compatibility ring does not prevent recovery in
  the semantic runtime;
* alternate-screen, cursor, mode, title, Unicode, and query-response behavior
  are deterministic;
* a blocked client never pauses a PTY and cannot delay another terminal;
* stale writer input, resize, and lifecycle commands are fenced;
* legacy and current supervisor generations coexist during an upgrade;
* draining owners exit only after their final terminal closes;
* recovery snapshots are atomic, bounded, privacy-configurable, and visibly
  historical when the owner is gone;
* Linux, macOS, and Windows process cleanup paths are tested without relying on
  optional user-installed programs.

## Harness rules

Every test owns a temporary data directory and records all child processes it
starts. Cleanup is attempted in this order: graceful terminal disposal,
graceful supervisor shutdown, process-identity-checked escalation, then
recursive temporary-directory removal. A test must not call a global
`stopAll()` when it is exercising host restart or generation coexistence.

Queue assertions use byte/count bounds and observable markers rather than exact
CPU or wall-clock timings. Slow-consumer tests deliberately stop reading from
one socket while a fast consumer and the child continue operating.

## Baseline versus release gates

Baseline tests document current degraded raw replay behavior and are allowed to
name that limitation. Release tests assert the replacement behavior and must
not be weakened to match the old recorder. A skipped test needs a platform or
runtime reason and a linked follow-up; it must not hide a deterministic failure.
