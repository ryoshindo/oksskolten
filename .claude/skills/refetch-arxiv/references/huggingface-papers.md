# Backfill HF / takara.ai wrapper articles

For `huggingface.co/papers/<id>` and `tldr.takara.ai/p/<id>` articles
ingested before the URL rewriter in `server/fetcher/arxiv.ts` learned
to resolve them to `arxiv.org/abs/<id>`. Both wrappers expose only the
arxiv abstract, so the extracted `full_text` was effectively the
abstract only.

The rewrite changes the ingestion pipeline, but **existing rows are not
migrated automatically** — this document covers the one-off refetch.

The `/api/admin/refetch-arxiv-html` endpoint accepts both wrapper URL
shapes directly; no URL munging needed from the client.

## 1. List candidate articles

Using the local SQLite directly (reads are safe with WAL):

```bash
sqlite3 ./data/rss.db \
  "SELECT id, LENGTH(full_text) AS len, url \
   FROM active_articles \
   WHERE url LIKE 'https://huggingface.co/papers/%' \
      OR url LIKE 'https://tldr.takara.ai/p/%' \
   ORDER BY len;"
```

Short `len` values (~1000–2000 chars) are the abstract-only rows to
target. Larger values are probably already backfilled or had long
comments/discussion picked up by Readability.

## 2. Refetch the abstract-only ones (serial, 1s pace)

Pick a threshold (e.g. `< 3000` chars for anything that still smells
like an abstract) and loop:

```bash
sqlite3 ./data/rss.db \
  "SELECT id FROM active_articles \
   WHERE (url LIKE 'https://huggingface.co/papers/%' \
          OR url LIKE 'https://tldr.takara.ai/p/%') \
     AND LENGTH(full_text) < 3000;" \
  | while read id; do
    curl -s -X POST "$OKS_API_URL/api/admin/refetch-arxiv-html" \
      -H "Authorization: Bearer $OKS_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"article_id\": $id}"
    echo
    sleep 1
  done
```

To refetch every wrapper article regardless of length, drop the
`LENGTH(full_text) < 3000` clause.

If you cannot reach the SQLite file directly (e.g. the server holds an
exclusive handle, or the process runs against a remote libSQL), pull
the IDs from the admin status endpoint instead — feed 24 is the
takara.ai HF Daily Papers feed in this deployment:

```bash
curl -s "$OKS_API_URL/api/admin/arxiv-status?feed_id=24" \
  -H "Authorization: Bearer $OKS_TOKEN" \
  | jq '.articles[] | select(.full_text_length < 3000) | .id'
```

## 3. Verify

Re-run step 1 and confirm `len` grew for most rows. Wrappers whose
arxiv paper has an html version should end up > 5k chars. For papers
without html, the response will report `"source": "abs"` and `len`
will remain around the abstract size — that's the best we can get.

Spot-check a sample by opening the article in the UI and confirming
the body now shows sections (Introduction / Method / Results …)
rather than just the abstract paragraph.
