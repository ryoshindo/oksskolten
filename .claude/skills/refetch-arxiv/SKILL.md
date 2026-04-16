---
name: refetch-arxiv
description: Backfill full_text for arXiv articles by swapping abs/ URL to html/ (abs fallback for papers without an HTML version)
user_invocable: true
---

The arXiv RSS feeds (`cs.IR`, `cs.CL`, …) only ship the abstract. The regular RSS fetch pipeline now invokes `fetchFullTextArxivAware` (`server/fetcher/arxiv.ts`), so **new arXiv articles already get their HTML-version full text at ingestion time** — no manual backfill needed.

This skill is for two remaining cases:

1. **One-off backfill** for arxiv articles that were ingested before the auto-rewrite landed.
2. **Retrying individual failures** where the HTML fetch hit a transient error (timeout / memory). The admin endpoint will retry html/ and fall back to abs/ on stub (< 1000 bytes) or error.

Running the skill is always safe: every article ends up with something, worst case the abstract.

## Arguments

`$ARGUMENTS` can be:

- Empty → refetch every arXiv feed (discover feeds whose `rss_url` matches `rss.arxiv.org`)
- A feed_id (number) → refetch only that feed
- `status` → report current stub/errored counts without mutating anything
- `status <feed_id>` → status for a single feed

## Prerequisites

- Server running at `$OKS_API_URL` (default `http://localhost:13000`)
- `$OKS_TOKEN` set with `read,write` scope (Settings → Security → API Tokens)

Both should already be exported via `.envrc` / `direnv allow`.

## Commands

### 1. Find arxiv feed IDs

```bash
curl -s -H "Authorization: Bearer $OKS_TOKEN" "$OKS_API_URL/api/feeds" \
  | jq '.feeds[] | select(.rss_url | test("rss\\.arxiv\\.org")) | {id, name, article_count}'
```

### 2. Status for a feed

```bash
curl -s -H "Authorization: Bearer $OKS_TOKEN" "$OKS_API_URL/api/admin/arxiv-status?feed_id=$FEED_ID" \
  | jq '{total, stub_count, errored_count, stub_ids, errored_ids}'
```

### 3. Refetch only stub/errored IDs (serial, 1s pace)

For incremental runs on an already-processed feed:

```bash
curl -s -H "Authorization: Bearer $OKS_TOKEN" "$OKS_API_URL/api/admin/arxiv-status?feed_id=$FEED_ID" \
  | jq -r '(.stub_ids + .errored_ids)[]' \
  | while read id; do
    curl -s -X POST "$OKS_API_URL/api/admin/refetch-arxiv-html" \
      -H "Authorization: Bearer $OKS_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"article_id\": $id}"
    echo
    sleep 1
  done
```

### 4. Refetch every article in a feed (initial backfill)

```bash
curl -s -H "Authorization: Bearer $OKS_TOKEN" "$OKS_API_URL/api/articles?feed_id=$FEED_ID&limit=500" \
  | jq -r '.articles[].id'
# → feed the IDs into the same POST loop as step 3
```

### 5. Verify

Re-run step 2 — `stub_count` and `errored_count` should both be `0`.

## Large backfills (100+ articles)

Serial processing at 1s/request is ~3 min per 200 articles. Acceptable.

If you want it faster, fan out via the `Agent` tool — spawn 4 sonnet agents, each with a disjoint ID slice. Pacing stays at 1s/agent to avoid arxiv throttling. Don't go higher than ~4 parallel: the server's piscina worker pool is `maxThreads=2`, so extra parallelism just queues up on the server side and risks tripping the 45s worker timeout.

The agent prompt template:

> Call `POST /api/admin/refetch-arxiv-html` with `{"article_id": <id>}` for each ID in your batch. Sleep 1s between calls. Report aggregate stats at the end: success count, failure count with id+error, min/median/max full_text_length. Do not retry failures.

## Notes on excerpt quality

arxiv's HTML rendering wraps the paper in author/ORCID metadata before the abstract proper, so the auto-generated `excerpt` (first 200 chars of `full_text`) sometimes starts with author names. The `full_text` itself is fine; it's only the preview that looks odd. If this becomes a problem, add an arxiv-specific cleaner config in `server/lib/cleaner/` — out of scope for this skill.
