# Backfill arxiv feeds

For arxiv RSS feeds (`cs.IR`, `cs.CL`, …) where articles were ingested
before the auto-rewrite landed, or where the html fetch failed
transiently. Work is scoped by `feed_id` and uses the
`/api/admin/arxiv-status` endpoint to identify stub/errored rows.

## 1. Find arxiv feed IDs

```bash
curl -s -H "Authorization: Bearer $OKS_TOKEN" "$OKS_API_URL/api/feeds" \
  | jq '.feeds[] | select(.rss_url | test("rss\\.arxiv\\.org")) | {id, name, article_count}'
```

## 2. Status for a feed

```bash
curl -s -H "Authorization: Bearer $OKS_TOKEN" "$OKS_API_URL/api/admin/arxiv-status?feed_id=$FEED_ID" \
  | jq '{total, stub_count, errored_count, stub_ids, errored_ids}'
```

If `$ARGUMENTS` was `status` or `status <feed_id>`, stop here and
report without mutating anything.

## 3. Refetch only stub/errored IDs (serial, 1s pace)

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

## 4. Refetch every article in a feed (initial backfill)

```bash
curl -s -H "Authorization: Bearer $OKS_TOKEN" "$OKS_API_URL/api/articles?feed_id=$FEED_ID&limit=500" \
  | jq -r '.articles[].id'
# → feed the IDs into the same POST loop as step 3
```

## 5. Verify

Re-run step 2 — `stub_count` and `errored_count` should both be `0`.
