# `@yaade/agent-telemetry`

This package is YAADE's existing **CLI agent telemetry** subsystem. It observes
hooks/plugins from terminal-launched agents and reduces them into activity,
unread, attention, and notification projections.

The legacy `@yaade/agents` package re-exports this package during migration.
It is intentionally not the interactive agent protocol. New bidirectional
agent-control work belongs in `@yaade/agent-protocol`,
`@yaade/agent-driver`, and `@yaade/agent-runtime`. The package name remains for
compatibility while imports and RPC names are migrated incrementally.
