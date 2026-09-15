<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project commands

- `npm test` / `npm run test:watch` — Vitest (unit + integration).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — ESLint.
- `npm run format` — Prettier write; `npm run format:check` in check mode.

# Project conventions

- **Locale is a build-time choice**, not per-user: `NEXT_PUBLIC_APP_LOCALE`
  (default `en`) selects `messages/<locale>.json` in `src/i18n/request.ts`.
  Changing it requires a dev-server restart (or a Docker rebuild —
  compose passes it as a build arg). Datasets: `en`, `ko`, `pt-BR`.
- **i18n safety test:** all `messages/*.json` must keep the exact same
  key tree and the same set of ICU-hostile strings as `messages/en.json`
  (`src/i18n/icu-safety.test.ts`).
- **WhatsApp providers:** sending/inbound go through a provider interface
  (`src/lib/whatsapp/providers/`). Add new providers there; keep templates
  Meta-only.
- **WAHA (self-hosted WhatsApp) lives outside this repo:** its env file is
  `C:\Users\wilhi\Documents\Development\Crm_whatsapp\waha-data\.env` and
  the container publishes `3001:3000`. Recreating it requires the same
  `-p 3001:3000`, `-v ...\sessions:/app/.sessions`, and `--env-file`
  flags — see the changelog.
- **Never commit** `supabase/.temp/` (linked-project metadata, gitignored).
- After changing tests/code touched by this work, run `npm test`, `npm run
  typecheck`, and `npm run lint` before finishing.
