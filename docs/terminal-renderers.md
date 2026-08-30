# Terminal runtime and renderer policy

## Defaults

YAADE starts the Ghostty parser in a bounded worker pool. Worker startup failure falls back to the main thread. A worker crash creates a new runtime generation and asks the host for authoritative replay before ACK resumes. Operators can force `main` with `yaade:terminal-runtime=main` or `?runtime=main`.

The terminal frame scheduler records four stages: received, posted, parsed, and presented. Host cumulative ACK runs only at parsed. Fixed-size metric rings retain byte counts and timestamps without PTY payloads. Hidden panes keep parsing and ACKing while suppressing rendering.

Renderer selection follows this ladder:

```text
auto or explicit webgl2: WebGL2 -> Canvas 2D
explicit canvas2d:       Canvas 2D
```

WebGPU is not shipped. A capability-gated adapter produced a blank terminal in a real WKWebView run, so the experiment was removed. Reintroducing it requires passing browser and Tauri presentation, loss-recovery, and terminal corpus tests.

## Measurements

Test host: Apple M4, macOS 27, 2026-08-29. Browser: project Chromium 149.0.7827.55.

| Runtime | Stream median | Flood median | Idle typing median | Typing under flood p95 |
| --- | ---: | ---: | ---: | ---: |
| Main, WebGL2, earlier three-run range | 266.5–283.0 ms | 76.4–77.6 ms | 11.7 ms | 14.8–14.9 ms |
| Worker before update coalescing | 428.5 ms | 124.2 ms | 12.0 ms | 15.1 ms |
| Worker after update coalescing, first run | 264.1 ms | 92.8 ms | 11.6 ms | 15.0 ms |
| Worker plus frame scheduler, default validation run | 341.6 ms | 160.7 ms | 11.4 ms | 15.0 ms |

The local results vary enough that they do not justify a performance claim. Project policy enables the worker and scheduler by operator direction so lower-spec and busier systems can keep parsing away from browser input and layout. Existing benchmark budgets remain unchanged.

## Incremental WebGL scene submission

WebGL retains one compact CPU/GPU scene while continuing to clear and redraw the complete default framebuffer on every present. Submission is planned independently for backgrounds, decorations, and glyphs:

- cursor/focus-only frames perform no retained-scene copy or upload;
- dirty rows with stable primitive counts patch exact merged byte ranges;
- a row count change compacts only the affected primitive;
- dimensions, model generation, full repaint, font, DPR, viewport origin, hover geometry, atlas reset, and renderer recovery are full barriers.

Row batches retain typed-array capacity across warm same-shape updates. Cumulative lifecycle diagnostics report actual scene copy/upload bytes and calls, full/partial submissions, compactions, row allocations, overlay uploads, atlas activity, GL capacity, and a bounded 256-sample renderer CPU distribution.

The pre-change Apple M4 / Chromium 149 probe used a 180×44 viewport. A static focused terminal moved 326,384 bytes in 1.25 seconds, and five coalesced presents for ten fixed-width one-row updates moved 855,140 retained-scene bytes. These numbers characterize the removed full-upload path; no latency claim is made until three matched release benchmark runs establish a repeatable CPU distribution.

## Worker render-update ownership ring

Each worker terminal owns exactly three packed render-update slots. Building an
update leases one slot and transfers its eight typed-array buffers to the main
thread. `releaseRenderUpdate` transfers the same generation-scoped slot and
lease token back to the worker, where buffer lengths and alignment are validated
before the slot becomes reusable. Duplicate, stale, detached, or malformed
returns do not free a slot.

When all three slots are in flight, parsing and parsed ACKs continue. Dirty state
is not extracted or consumed; one pending newest update retains any full-frame
requirement and is emitted after a valid slot return. Queue discard, failed
model apply, surface disposal, and worker recovery explicitly release or abandon
the old generation's ownership. Capacity growth is bounded to the three slots,
and warm same-size circulation allocates no replacement backing buffers.

## WebGPU decision

Official references checked on 2026-08-29:

- [Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/)
- [GPUWeb implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
- [MDN WebGPU API](https://developer.mozilla.org/docs/Web/API/WebGPU_API)

Project Chromium exposed `navigator.gpu` but returned no adapter. A newer WKWebView exposed enough API for initialization but rendered an empty black terminal. Capability checks alone therefore do not establish terminal support. YAADE uses WebGL2 on both browser and desktop targets, with Canvas 2D fallback.
