# Embedded assets

- The static `fonts/Geist-*.ttf` and `fonts/GeistMono-*.ttf` faces are sourced
  from <https://github.com/vercel/geist-font> at the repository's `main` revision on
  2026-08-23. License: SIL Open Font License 1.1; see `fonts/LICENSE-Geist.txt`.
- `icons/*.svg` use Lucide icon geometry matching the web client's
  `lucide-react` set. License: ISC.

Assets are embedded by `src/assets.rs`; the desktop executable does not rely on
runtime paths or a web asset server.
