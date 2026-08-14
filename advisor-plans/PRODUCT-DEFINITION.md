# YAADE Product Definition

**Status:** Product baseline for roadmap creation  
**Date:** 2026-08-15  
**Codebase reviewed at:** `f66c953`  
**Audience:** Product owner, designers, and implementation agents

## Purpose of this document

This document defines what YAADE is, who it serves, which workflow it owns, and which boundaries prevent it from becoming a generic browser IDE. It is the product source from which a separate delivery roadmap should be derived.

It intentionally does not assign milestones or implementation order.

---

## 1. Product definition

### One-sentence definition

**YAADE is a task-centric development cockpit for individual power users who coordinate multiple coding agents across multiple projects.**

### Product promise

YAADE provides one durable place to:

1. discover the projects and code involved in a task;
2. launch independent agents with as much or as little context as the user chooses;
3. inspect and guide work across terminals, code, Git, and API requests;
4. verify, combine, and ship the result; and
5. preserve the task and its running processes across ordinary browser lifecycle events.

### Positioning

YAADE replaces the working combination of:

- terminal application;
- tmux-style session and process management;
- coding-agent launcher/manager;
- code search and system-discovery tools;
- Monaco-class code inspection and editing;
- Git client;
- REST client such as Postman.

It does **not** replace these by putting unrelated utilities in one shell. They are supporting instruments around one primary object: an agentic development task.

---

## 2. Target user

### Primary user

A single, experienced software developer who:

- works across many local or remote repositories;
- understands terminals, Git, branches, and worktrees;
- delegates implementation to multiple coding agents;
- frequently needs to discover which service, API, or database owns a behavior;
- values keyboard speed, durable state, and direct control over beginner-oriented guidance;
- is willing to learn a coherent command grammar;
- wants one work surface without adopting a full IDE-centered workflow.

### User maturity

YAADE is keyboard-first and power-user-oriented, but it must remain self-documenting. It should support:

1. **Discovery:** command palette, visible context actions, and a which-key HUD.
2. **Fluency:** a stable tmux-like prefix grammar and fast switching.
3. **Ownership:** configurable Workspaces, projects, tools, layouts, and agent choices.

### Initial market boundary

The first product serves individual developers. Multi-user collaboration, organization administration, permissions between teammates, and team analytics are outside the initial product definition.

---

## 3. Primary job to be done

> When I receive a development task that may cross service boundaries, I want to find the responsible projects and code, delegate independent subproblems to agents, inspect and verify their work, and ship the result without reconstructing context across terminals, tmux, an editor, a Git client, and Postman.

### Common variation

If the developer already knows the relevant project and context, discovery is optional. They must be able to launch an agent immediately without completing a search or setup flow.

---

## 4. Core workflow

```text
Choose Workspace
→ create or resume Task Session
→ search across registered projects, or skip discovery
→ inspect services, API calls, database tables, files, and evidence
→ launch independent agents for distinct projects/subproblems
→ monitor and guide agents
→ inspect code and per-agent Git changes
→ run tests and terminal commands
→ verify REST behavior
→ choose, combine, commit, push, and optionally open a PR
→ archive the Task Session with searchable history
```

### Completion definition

A task is complete when the user has reviewed the relevant agent output, verified the implementation, shipped or intentionally retained the changes, and archived the Session. Agent process exit alone does not mean the task is complete.

---

## 5. Product model

### 5.1 Workspace

A **Workspace** is a named collection of explicitly registered projects.

Examples:

- Snapp Doctor
- Personal
- Open Source

A Workspace defines the default scope for global retrieval. Users may maintain several Workspaces and switch between them.

A Workspace is not a filesystem folder, editor window, or development task. It is an intentional project catalog and search boundary.

### 5.2 Project

A **Project** is an explicitly registered repository with at least:

- stable identity;
- display name;
- local path and/or remote repository identity;
- default branch;
- indexing state and last successful index metadata.

Projects are indexed from their default branches for stable organization-wide retrieval. Live task/worktree overlays may be added later, but must not replace the stable default-branch index.

### 5.3 Task Session

A **Task Session** represents exactly one development task.

A Session:

- may involve multiple projects;
- contains an ordered set of ToolUses;
- records selected search context and task history where available;
- preserves its active tools, layout, and process attachment state;
- can be archived and restored;
- is not itself bound to one project or checkout.

The Session is the primary unit users name, resume, switch, complete, and archive.

### 5.4 ToolUse

A **ToolUse** is a durable invocation or working surface inside a Task Session.

ToolUse kinds include:

- Agent
- Terminal
- Search
- Editor
- Git
- HTTP

Each ToolUse may own its own project and checkout context. This is essential because one task may span several projects.

### 5.5 Agent

An **Agent** is a first-class participant in a task, not an editor feature.

The normal topology is several independent agents, each responsible for a distinct project or subproblem. YAADE should make each agent's responsibility, project, checkout, status, and changes legible.

Implementation agents receive isolated worktrees by default. Read-only investigators may operate against Main when they do not need to mutate code.

### 5.6 Context

Context is optional and user-controlled.

A user may:

- launch an agent with no prepared context;
- select one or more retrieval results;
- inspect context before using it;
- pass selected context to an agent when a supported harness exists.

YAADE must never require a context-building wizard before an agent starts.

With future Pi integration, the intended sequence is:

```text
select optional context
→ create agent with that context
→ ask the user for the prompt
→ start the run
```

The user remains free to pass no context.

---

## 6. Product principles

### 6.1 Agent-first, not IDE-first

Agents are the central actors. Search, Monaco, Git, terminal, layout, and HTTP exist to help users give agents context, observe work, correct it, and verify it.

YAADE must not become a VS Code or Cursor clone where a conventional IDE is built first and agents are added as a sidebar or chat feature.

### 6.2 Task-centric, not project-centric

The product organizes work by task. Projects and checkouts belong to the tools and agents required by that task.

### 6.3 Search is the entry layer

When context is not already known, the first product action is global retrieval across the active Workspace. Search should locate the responsible part of the system before asking the user to pick a repository manually.

### 6.4 Retrieval must remain inspectable

Search returns ranked evidence, not an opaque generated answer. Users must be able to see why a result matched and open its source location.

### 6.5 The user controls delegation

YAADE may suggest context and make handoff fast, but the user chooses:

- which agents to start;
- which projects and worktrees they use;
- what context they receive;
- what prompt they receive;
- which changes are accepted or combined.

### 6.6 Durability is a core feature

A terminal or agent disappearing after a browser refresh is a product failure, not an edge case. Browser lifecycle resilience is part of the product promise.

### 6.7 Keyboard-first must also be discoverable

A coherent prefix grammar is preferable to unreliable browser-reserved shortcuts. The command palette, which-key HUD, and context menus must expose the same command model.

### 6.8 Immediate tools, no setup workflow

Creating a ToolUse mounts its working surface immediately. Project, checkout, provider, and other options belong inside that surface or its context controls. YAADE should not introduce pre-launch forms or staged setup wizards.

### 6.9 Browser constraints must be handled honestly

YAADE should not promise direct shortcuts the browser may consume. It should embrace a prefix-first interaction model and reserve direct shortcuts for combinations browsers reliably deliver.

---

## 7. Workspace intelligence and search

### 7.1 Role in the product

Search is both:

- the default starting surface of a new Task Session; and
- a globally accessible command/surface after work has begun.

Users who already know the context can bypass it and create an Agent or another tool immediately.

### 7.2 Search scope

Search runs across every explicitly registered project in the active Workspace. The stable index represents each project's default branch.

### 7.3 Priority result types

In product priority order:

1. services;
2. inbound and outbound API calls between services;
3. database tables and their relationships;
4. concrete evidence locations in repositories;
5. supporting files, symbols, infrastructure, and documentation where relevant.

### 7.4 Retrieval behavior

The Organization Intelligence model is the reference direction:

- canonical extracted Facts;
- evidence linked to files and locations;
- exact identifier matching;
- lexical full-text matching;
- optional semantic retrieval;
- fused ranking across retrieval channels;
- cross-project relationships.

YAADE should reuse or integrate this model rather than reducing organization search to embeddings over arbitrary file chunks.

### 7.5 Search output

Every result should identify:

- what was found;
- its type;
- owning project/service;
- relevant relationship, such as caller → callee or service → table;
- evidence file and location when available;
- why it matched;
- index freshness.

Search is retrieval, not question answering. Generated prose answers are outside the initial product definition.

### 7.6 Indexing behavior

Indexing must be asynchronous and must never block terminal input or active task work. The UI must expose useful states:

- not indexed;
- indexing;
- ready;
- stale;
- failed with an actionable retry.

---

## 8. Agent experience

### 8.1 Initial agent support

Existing terminal-based coding agents remain valid:

- Codex
- Claude
- OpenCode
- Cursor Agent
- Grok
- Pi

The terminal remains available as the compatibility and escape-hatch interface.

### 8.2 Independent-agent model

One Task Session may contain several agents. The expected pattern is not several agents racing on the same change. It is independent agents handling distinct projects or subproblems within the same task.

Each agent should have visible:

- role or user-assigned title;
- project;
- checkout/worktree;
- provider;
- lifecycle and attention state;
- associated changes.

### 8.3 Future structured harness

Pi is the preferred candidate for deeper integration. A structured harness should eventually expose:

- submitted prompt and task role;
- running/waiting/permission state;
- plan or current activity;
- commands and tests;
- files changed and diff;
- questions requiring user input;
- completion summary;
- context passed to the agent.

This is progressive enhancement. Unsupported agents must remain usable through their PTYs.

### 8.4 Agent change ownership

The product must make it easy to answer:

- Which agent changed this file?
- Which worktree contains the change?
- What did that agent run or verify?
- Can I review, accept, combine, or discard the result?

Isolated worktrees are the primary mechanism for reliable attribution and parallelism.

---

## 9. Terminal experience and durability

### 9.1 Terminal role

Terminal is both a standalone tool and the runtime substrate for terminal-based agents. It must feel at least as trustworthy as the terminal/tmux workflow it replaces.

### 9.2 Required durability contract

1. Switching ToolUses or Sessions never resets a terminal.
2. Browser refresh reattaches to the same live process and restores recent output.
3. Closing and reopening the browser reattaches while the host runtime remains alive.
4. Disconnect/reconnect does not duplicate or silently drop replayed output.
5. Focus, sizing, title, and input behavior recover correctly after reattachment.
6. A future durable terminal daemon should allow processes to survive a host-server restart.
7. After a machine reboot, Session and ToolUse metadata return, but dead processes are explicitly shown as stopped rather than presented as live.

### 9.3 Failure behavior

When reattachment is impossible, YAADE must show:

- what was lost;
- why attachment failed when known;
- whether replay is available;
- a clear restart action;
- preserved task metadata and surrounding tools.

It must not silently replace the old terminal with a new shell.

---

## 10. Editor experience

YAADE includes Monaco with LSP and Monaco/LSP-native capabilities, including the features needed for serious code navigation and corrective editing.

Expected capabilities include:

- multi-file buffers;
- syntax highlighting;
- diagnostics;
- completion;
- go to definition;
- references;
- symbols;
- rename and other supported language actions;
- save and dirty-state handling;
- LSP restart/reconnection;
- file tree and quick open.

The editor supports inspection, navigation, and manual intervention around agent work. It is not the product center, and YAADE does not aim to reproduce VS Code's extension marketplace, debugger ecosystem, or complete settings surface.

---

## 11. Git experience

Git is a first-class task and agent review surface.

The product should support:

- uncommitted changes and history;
- diffs scoped to project, worktree, and agent;
- file and hunk inspection;
- stage and unstage;
- discard with explicit confirmation;
- commit;
- fetch, pull, and push;
- opening changed files in Monaco;
- comparing or combining independent agent results when needed;
- preserving the relationship between an agent and its changes.

The normal review loop is Agent + Git, eventually shown side by side through the column layout.

---

## 12. HTTP client

### 12.1 Purpose

The HTTP client closes the implementation-verification loop without requiring Postman or a separate terminal command history.

### 12.2 First-version scope

The first useful version includes:

- REST methods and URL editing;
- headers;
- query parameters;
- request body editors;
- common authentication helpers;
- environments and secret values;
- project-scoped request collections;
- request/response history tied to the Task Session;
- cURL import;
- OpenAPI import;
- Postman import;
- readable response body, headers, status, timing, and size;
- repeat and edit-and-resend workflows.

### 12.3 Explicit first-version exclusions

The first version does not include:

- GraphQL-specific tooling;
- gRPC;
- WebSocket clients;
- user-authored test/assertion scripts;
- launching a request directly from an indexed API Fact.

These exclusions prevent the HTTP client from becoming a separate automation platform before the basic task-verification loop is excellent.

---

## 13. Layout and navigation

### 13.1 Column model

A Task Session initially supports one active ToolUse. The intended evolution is a stable two- or three-column composition model.

Each column independently displays any ToolUse. Examples:

```text
Agent | Git diff
Agent | Terminal | Git
Agent A | Agent B | Git
Search | Editor
HTTP request | Terminal logs
```

Columns should preserve ToolUse identity and runtime state when the visible composition changes.

### 13.2 Navigation hierarchy

The user navigates four levels:

```text
Workspace
→ Task Session
→ Column
→ ToolUse
```

Project and checkout are ToolUse context, not navigation levels above the Session.

### 13.3 Spatial continuity

YAADE should preserve:

- Session order;
- ToolUse order;
- column assignment;
- active ToolUse per Session;
- editor buffers and positions where practical;
- terminal runtime attachment;
- user-selected layout.

Tools must not move between columns or steal focus because of background status changes.

---

## 14. Commands, keyboard, and feature discovery

### 14.1 Command model

Every meaningful action should have one stable command identity. Buttons, context menus, the command palette, keyboard bindings, automation hooks, and tests should invoke the same commands.

### 14.2 Discovery priority

The product's discovery surfaces, in priority order, are:

1. **Universal command palette** — search every available command with context-aware ranking.
2. **Which-key HUD** — show valid continuations immediately after the prefix.
3. **Context menus** — expose actions for the selected Session, ToolUse, search result, file, diff, request, or agent.

The tool launcher remains a visible creation surface, but the three mechanisms above define the primary discovery system.

### 14.3 Keyboard grammar

- Default prefix: `Ctrl-a`.
- Pressing the prefix twice inside a terminal sends literal `^A`.
- Prefix commands are grouped mnemonically.
- Direct shortcuts are used only when reliably deliverable by browsers.
- The prefix should eventually be configurable.
- Matching global commands must prevent browser-page propagation so they do not leak into terminals.
- Bare Escape is never globally swallowed from a focused terminal.

### 14.4 Browser limitation policy

A shortcut that browsers reserve is not a supported shortcut, even if automated browser input can simulate it. The product should solve browser conflicts through command discovery and prefix grammar rather than maintaining bindings that work only in tests.

---

## 15. Local and remote operation

YAADE remains a browser-only product backed by a TypeScript host. It does not require Electron, Tauri, or a Rust desktop shell.

The same product should work with:

- a host on the developer's local machine; or
- a host on a remote development machine.

Remote operation is not shippable until HTTP and WebSocket access share a real authentication mechanism. Loopback-only binding is a valid local safety measure but not remote security.

The initial remote security model may remain single-user, but it must authenticate every request and connection before exposing terminals or filesystem access.

---

## 16. Quality attributes

### 16.1 Responsiveness targets

Initial product budgets:

| Interaction | Target |
| --- | ---: |
| Terminal input echo | Immediate; no app-introduced visible lag |
| ToolUse switch with warm state | Under 100 ms |
| Session switch with warm state | Under 100 ms |
| Command palette open | Under 50 ms |
| Palette filtering | Under 30 ms per keystroke |
| Which-key HUD | Visible in the next frame |
| Search input feedback | Immediate while retrieval continues asynchronously |

Indexing, semantic retrieval preparation, LSP startup, Git operations, and remote requests must not block terminal input or basic navigation.

### 16.2 Robustness targets

- No PTY death from Session or ToolUse switching.
- No PTY death from ordinary browser refresh while the host remains alive.
- No silent output loss or duplication during replay.
- No stale search results presented as belonging to a newer query.
- No agent project/provider change that leaves UI metadata and runtime silently disagreeing.
- No background operation silently changes the active Session, column, ToolUse, project, or checkout.

### 16.3 Recoverability

Task metadata, search context, request history, and Git review state should remain useful even when an external process crashes. Restarting a failed process must be explicit and should not erase surrounding task history.

---

## 17. Non-goals

YAADE is not:

- a VS Code or Cursor clone;
- an IDE with an agent chat added as a feature;
- a general-purpose team collaboration suite;
- an issue tracker or project-management board;
- a no-code visual agent workflow builder;
- an autonomous system that chooses and merges agent changes without user review;
- a question-answering product that hides retrieval evidence;
- a full API automation/testing platform in the first HTTP release;
- a replacement for every VS Code extension or debugger;
- a reason to add a native desktop wrapper solely to capture reserved browser shortcuts.

---

## 18. Success criteria

### North-star criterion

> YAADE succeeds when at least 90% of the target user's development tasks can move from discovery through parallel agents, review, verification, and commit without opening a separate terminal, tmux, editor, Git client, or Postman. Core task and terminal state must survive ordinary browser reloads and reconnections without loss.

### Supporting indicators

- Percentage of tasks started from Workspace search or direct agent launch.
- Percentage of completed tasks that remain entirely inside YAADE.
- Successful terminal reattachment rate after browser refresh/reopen.
- Frequency of fallback to an external terminal, editor, Git client, or REST client, categorized by missing capability.
- Time from task creation to first useful agent launch.
- Time from agent completion to reviewed/verified changes.
- Command usage discovered through palette, which-key, and context menus.
- Search result success: user opens or selects a useful service/API/table result without switching tools.

---

## 19. Current product assessment

### Existing strengths to preserve

The current application already has meaningful parts of the product foundation:

- durable Session and ToolUse persistence;
- host-owned PTYs with attach replay and flow control;
- independent per-ToolUse project and checkout context;
- managed worktree creation;
- terminal-based Agent and Terminal tools;
- Monaco/LSP Editor and Search editing surfaces;
- a substantial native Git workspace;
- a tmux-like `Ctrl-a` prefix and which-key HUD;
- archived Session restoration;
- browser deep links to Sessions and ToolUses;
- explicit local-host path boundaries.

These are not prototypes to discard. They are the substrate for the task-centric product.

### Product gaps between current state and definition

#### 1. Session entry does not match the intended workflow

New Sessions currently begin with Editor and Git History. The defined workflow begins with global Workspace retrieval, while still permitting immediate agent launch when context is known.

#### 2. Search is scoped too narrowly

The current Search Tool is project content search. The product requires Workspace-wide retrieval across default branches, prioritizing services, cross-service API calls, and database tables with evidence.

#### 3. Workspace is not yet the search boundary

Projects can be listed and selected, but the primary product needs named Workspaces containing explicitly registered project collections and their indexing state.

#### 4. Agents are not yet first-class beyond their PTYs

Agent and Terminal currently share the same renderer and differ mostly by launch input. The product eventually needs explicit agent role, attention state, context, activity, and change ownership, preferably through Pi while preserving PTY compatibility.

#### 5. The layout only exposes one ToolUse at a time

The product direction requires two- and three-column compositions where each column can show any ToolUse without unmounting durable runtimes.

#### 6. Terminal durability ends at the host process

Browser reload attachment exists while the host remains alive, but a host restart invalidates PTYs. Replacing tmux fully requires a separate durable process boundary in a later version.

#### 7. Discovery is not yet one coherent command system

The prefix HUD is a strong start, but the Session shell still needs a universal command palette and commands shared consistently by keys, buttons, and context menus.

#### 8. The HTTP verification surface does not exist

Without the REST client, API-heavy tasks still require Postman or terminal commands and cannot satisfy the end-to-end product promise.

#### 9. Product documentation has drifted with the pivots

The codebase has moved from Mission Control to mux to project/session IDE to Tool Session shell. User-facing keybinding documentation also disagrees with the signed-off current keymap in places. This document replaces that shifting identity with a stable product definition; implementation docs must be reconciled against it during roadmap execution.

---

## 20. Decisions captured

| Decision | Product rationale |
| --- | --- |
| Target individual power-user developers | Optimize depth, speed, and control before team workflows. |
| Session means one task | The user's unit of work is a task, not an editor window or repository. |
| A task may span multiple projects | Service-oriented work commonly crosses repository boundaries. |
| Named Workspaces contain explicitly registered projects | Search scope should be intentional and understandable. |
| Stable indexing uses default branches | Organization retrieval should not fluctuate with arbitrary local worktrees. |
| Search prioritizes services, API calls, and database tables | These are the highest-value discovery objects in cross-service work. |
| Search is retrieval, not generated answering | Evidence and user judgment remain central. |
| Context is optional | Known-context workflows must stay fast; users control what agents receive. |
| Several agents handle distinct projects/subproblems | Parallelism should decompose the task rather than create undifferentiated races. |
| Implementation agents use isolated worktrees by default | Isolation enables parallel work and reliable change attribution. |
| Monaco + LSP is in scope | Serious navigation and corrective editing are required. |
| Agent-first, not IDE-first | Avoid rebuilding a generic editor product with agents bolted on. |
| Prefix-first keyboard model | Browser-reserved shortcuts cannot be made reliable. |
| Universal palette, which-key, and context menus drive discovery | Power-user speed and feature discoverability must reinforce each other. |
| Columns independently display ToolUses | Side-by-side composition should remain simple and task-oriented. |
| REST client is part of the owned workflow | API verification should not force users into Postman. |
| GraphQL, gRPC, WebSockets, scripts, and indexed-Fact request launch are deferred | Keep the first HTTP client focused on the normal REST verification loop. |
| Browser-only local/remote architecture remains | The browser enables remote access; native wrappers are not required for the product thesis. |

---

## 21. Open questions for roadmap design

These do not block the product definition, but roadmap work must resolve them:

1. How project registration, removal, and Workspace membership changes affect retained indexes.
2. How default branches are fetched and refreshed for local versus remote repositories.
3. Which production embedding provider and model back semantic retrieval.
4. Whether Organization Intelligence runs as an embedded YAADE subsystem, a local companion service, or shared packages behind a YAADE-owned API.
5. How context selections are represented before Pi integration exists.
6. Which exact Monaco/LSP capabilities define the supported baseline per language.
7. How agent worktrees are cleaned up after accept, merge, discard, or Session archival.
8. What process boundary provides host-restart terminal durability.
9. How column layouts are persisted and restored without remounting active PTYs.
10. How HTTP environment secrets are stored securely on local and remote hosts.
11. Which authentication helpers are required in the first REST release.
12. What archival retention and search are needed for old Task Sessions and agent output.
13. What authentication mechanism is required before remote hosts can be exposed safely.

---

## 22. Roadmap derivation constraint

The roadmap should be organized around complete workflow improvements, not isolated tool checklists. Each milestone should make a larger portion of this loop usable end to end:

```text
discover → delegate → observe → review → verify → ship → resume
```

A feature is not complete merely because its panel renders. It must be discoverable through the command system, preserve task context, survive expected lifecycle events, expose actionable failure states, and satisfy the relevant responsiveness and durability targets.
