# Backfill Hugging Face papers

For `huggingface.co/papers/<id>` articles ingested before HF→arxiv URL
rewriting landed in `server/fetcher/arxiv.ts`. The HF papers page just
wraps the arxiv abstract, so the extracted `full_text` was effectively
the abstract only.

The rewrite changes the ingestion pipeline, but **existing rows are not
migrated automatically** — this document covers the one-off refetch.

The `/api/admin/refetch-arxiv-html` endpoint accepts HF papers URLs
directly; no URL munging needed from the client.

## 1. List candidate articles

Using the local SQLite directly (reads are safe with WAL):

```bash
sqlite3 ./data/rss.db \
  "SELECT id, LENGTH(full_text) AS len, url \
   FROM active_articles \
   WHERE url LIKE 'https://huggingface.co/papers/%' \
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
   WHERE url LIKE 'https://huggingface.co/papers/%' \
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

To refetch every HF paper regardless of length, drop the
`LENGTH(full_text) < 3000` clause.

## 3. Verify

Re-run step 1 and confirm `len` grew for most rows. HF papers whose
arxiv paper has an html version should end up > 5k chars. For papers
without html, the response will report `"source": "abs"` and `len`
will remain around the abstract size — that's the best we can get.

Spot-check a sample by opening the article in the UI and confirming
the body now shows sections (Introduction / Method / Results …)
rather than just the abstract paragraph.
