# Oksskolten

See `README.md` for project overview and `docs/spec/` for detailed specs.

## Database

SQLite (libsql, WAL mode) at `./data/rss.db`.

- **Reads:** `sqlite3 ./data/rss.db` works fine while the server is running (WAL allows concurrent readers).
- **Writes:** Direct sqlite3 CLI writes do not work while the server is running. WAL mode causes the server process to hold the DB connection, so external writes are silently lost. Use API endpoints instead, or add a temporary admin endpoint in `server/routes/admin.ts` for one-off data injection.
- **API keys:** Create from Settings → Security → API Tokens. Use `read,write` scope for mutation endpoints. Example: `curl -H "Authorization: Bearer ok_..." http://localhost:3000/api/...`

## Language

- **Chat:** Respond in the same language the user speaks.
- **Issues, PRs, and commit messages:** Always use English.

## Fork workflow

This repo is a fork of `babarot/oksskolten`. `gh pr create` defaults to the GitHub parent (upstream), **not** this fork. Always pass `--repo ryoshindo/oksskolten` when creating PRs that should land in the fork itself (e.g. upstream sync PRs). Omitting it will open the PR against `babarot/oksskolten`.
