# gpui-ghostty-terminal

Vendored native Ghostty renderer used by `apps/desktop-gpui`.

The implementation comes from [`Xuanwo/gpui-ghostty`](https://github.com/Xuanwo/gpui-ghostty) at commit `e3025981c6211dd7db2a825dc364ffb5d342f45e`, under Apache-2.0. It is kept local so the application and renderer use the same pinned GPUI revision. Ghostty VT itself remains a pinned package from that upstream repository.

Changes from upstream are intentionally narrow:

- use the YAADE bundled Geist Mono family as the preferred terminal face;
- expose no PTY ownership—the YAADE host remains the only PTY/process owner.
