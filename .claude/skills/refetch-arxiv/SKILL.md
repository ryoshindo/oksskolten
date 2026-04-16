---
name: refetch-arxiv
description: Backfill full_text for arxiv, Hugging Face papers, and takara.ai tldr articles by fetching the arxiv html full text (abs fallback for papers without an HTML version)
user_invocable: true
---

The arxiv RSS feeds (`cs.IR`, `cs.CL`, …) only ship the abstract, and
upstream wrappers like `huggingface.co/papers/<id>` and
`tldr.takara.ai/p/<id>` just re-expose the same abstract. All three
pipelines now normalize to arxiv and invoke `fetchFullTextArxivAware`
(`server/fetcher/arxiv.ts`) at ingestion time, so **new articles
already get their html full text automatically** — no manual backfill
needed.

This skill is for the leftover cases:

1. **One-off backfill** for records ingested before the auto-rewrite
   landed.
2. **Retrying transient failures** where the html fetch hit a timeout /
   memory error. The admin endpoint retries html and falls back to abs
   on stub (< 1000 bytes) or error.

Running is always safe: every article ends up with something, worst
case the abstract.

## Modes

Pick one based on `$ARGUMENTS`:

- Empty / a feed_id / `status` / `status <feed_id>` →
  arxiv-feed-scoped backfill. Read `references/arxiv-feeds.md`.
- `hf` / `huggingface` →
  URL-pattern based backfill for Hugging Face papers and takara.ai
  tldr wrappers. Read `references/huggingface-papers.md`.

## Common prerequisites

- Server running at `$OKS_API_URL` (default `http://localhost:13000`)
- `$OKS_TOKEN` set with `read,write` scope (Settings → Security → API Tokens)

Both should already be exported via `.envrc` / `direnv allow`.

The refetch endpoint is `POST /api/admin/refetch-arxiv-html`, which
accepts `arxiv.org/abs/<id>`, `huggingface.co/papers/<id>`, and
`tldr.takara.ai/p/<id>`.

## Large backfills (100+ articles)

Serial processing at 1s/request is ~3 min per 200 articles. Acceptable.

If you want it faster, fan out via the `Agent` tool — spawn 4 sonnet
agents, each with a disjoint ID slice. Pacing stays at 1s/agent to
avoid arxiv throttling. Don't go higher than ~4 parallel: the server's
piscina worker pool is `maxThreads=2`, so extra parallelism just queues
on the server side and risks tripping the 45s worker timeout.

Agent prompt template:

> Call `POST /api/admin/refetch-arxiv-html` with `{"article_id": <id>}`
> for each ID in your batch. Sleep 1s between calls. Report aggregate
> stats at the end: success count, failure count with id+error,
> min/median/max full_text_length. Do not retry failures.

## Notes on excerpt quality

arxiv's html rendering wraps the paper in author/ORCID metadata before
the abstract proper, so the auto-generated `excerpt` (first 200 chars
of `full_text`) sometimes starts with author names. The `full_text`
itself is fine; it's only the preview that looks odd. If this becomes a
problem, add an arxiv-specific cleaner config in `server/lib/cleaner/`
— out of scope for this skill.
