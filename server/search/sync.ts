import { getSearchClient, ARTICLES_INDEX, ARTICLES_STAGING_INDEX, type MeiliArticleDoc } from './client.js'
import { getDb } from '../db/connection.js'
import { SCORED_ARTICLES_WHERE } from '../db/articles.js'
import { logger } from '../logger.js'

const log = logger.child('search')

// --- State ---

let searchReady = false
let rebuilding = false

export function isSearchReady(): boolean {
  return searchReady
}

/** @internal Test-only helper to control rebuilding flag */
export function _setRebuilding(value: boolean): void {
  rebuilding = value
}

/** @internal Test-only helper to control searchReady flag */
export function _setSearchReadyForTest(value: boolean): void {
  searchReady = value
}

// --- Change log for rebuild consistency ---

// During rebuild we only track *which* ids moved; replay re-fetches the latest
// row from SQLite. This avoids order hazards when multiple concurrent writers
// (upsert / filter update / score batch) touch the same id.
type ChangeEntry =
  | { action: 'touch'; id: number }
  | { action: 'delete'; id: number }

let changeLog: ChangeEntry[] | null = null

/** @internal Test-only helper to seed/reset the rebuild change log */
export function _setChangeLogForTest(value: ChangeEntry[] | null): void {
  changeLog = value
}

// --- Index settings ---

const INDEX_SETTINGS = {
  searchableAttributes: ['title', 'full_text', 'full_text_translated'],
  filterableAttributes: ['feed_id', 'category_id', 'lang', 'published_at', 'is_unread', 'is_liked', 'is_bookmarked'],
  sortableAttributes: ['published_at', 'score'],
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
}

// --- Rebuild ---

const BATCH_SIZE = 1000

// Per-query page size for the id-cursor loop. Kept small so that each Turso
// round-trip stays under a few MB / a couple seconds — `full_text` can reach
// ~280KB per row, and libsql-client's .all() blocks the Node event loop.
let FETCH_BATCH = 50

/** @internal Test-only helper to shrink the per-query page size */
export function _setFetchBatchForTest(value: number): void {
  FETCH_BATCH = value
}

const ARTICLE_DOC_SELECT = `
  SELECT id, feed_id, category_id, title,
         COALESCE(full_text, '') AS full_text,
         COALESCE(full_text_translated, '') AS full_text_translated,
         lang,
         COALESCE(CAST(strftime('%s', published_at) AS INTEGER), 0) AS published_at,
         COALESCE(score, 0) AS score,
         (seen_at IS NULL) AS is_unread,
         (liked_at IS NOT NULL) AS is_liked,
         (bookmarked_at IS NOT NULL) AS is_bookmarked
  FROM active_articles
`

// SQLite returns 0/1 for boolean expressions; Meilisearch needs true/false.
function normalizeBooleans(row: MeiliArticleDoc): MeiliArticleDoc {
  return {
    ...row,
    is_unread: Boolean(row.is_unread),
    is_liked: Boolean(row.is_liked),
    is_bookmarked: Boolean(row.is_bookmarked),
  }
}

/**
 * Startup-only fast path: if the `articles` index already exists in Meili and
 * has documents, mark search ready and skip the full rebuild. The 6h cron
 * continues to refresh the index, so stale data is bounded. Any probe failure
 * (Meili unreachable, schema mismatch, etc.) falls through to a full rebuild.
 */
export async function ensureSearchReady(): Promise<void> {
  try {
    const client = getSearchClient()
    const { results } = await client.getIndexes()
    const hasArticles = results.some((idx: { uid: string }) => idx.uid === ARTICLES_INDEX)
    if (hasArticles) {
      const stats = await client.index(ARTICLES_INDEX).getStats()
      const docs = stats?.numberOfDocuments ?? 0
      if (docs > 0) {
        searchReady = true
        log.info(`Search index ready: ${docs} existing docs, skipping initial rebuild`)
        return
      }
    }
  } catch (err) {
    log.warn('Failed to probe existing search index, falling back to rebuild:', err)
  }
  await rebuildSearchIndex()
}

export async function rebuildSearchIndex(): Promise<void> {
  if (rebuilding) {
    log.info('Rebuild already in progress, skipping')
    return
  }
  rebuilding = true
  changeLog = []

  let totalIndexed = 0

  try {
    const client = getSearchClient()
    const startedAt = Date.now()

    // Collect existing index UIDs to avoid 404 requests
    const { results: existingIndexes } = await client.getIndexes()
    const indexSet = new Set(existingIndexes.map((idx: { uid: string }) => idx.uid))

    // 1. Create or reset staging index
    if (indexSet.has(ARTICLES_STAGING_INDEX)) {
      await client.deleteIndex(ARTICLES_STAGING_INDEX).waitTask({ timeout: 60_000 })
    }
    await client.createIndex(ARTICLES_STAGING_INDEX, { primaryKey: 'id' }).waitTask({ timeout: 60_000 })

    // 2. Apply index settings to staging
    const stagingIndex = client.index(ARTICLES_STAGING_INDEX)
    await stagingIndex.updateSettings(INDEX_SETTINGS).waitTask({ timeout: 60_000 })

    // 3. Paginate SQLite by id cursor. Freeze the upper bound so concurrent
    //    inserts after rebuild start don't make the loop a moving target —
    //    newer rows flow through the change log and replay after swap.
    const maxIdRow = getDb().prepare(
      'SELECT COALESCE(MAX(id), 0) AS max_id FROM active_articles',
    ).get() as { max_id: number }
    const maxId = maxIdRow.max_id
    const totalRow = getDb().prepare(
      'SELECT COUNT(*) AS total FROM active_articles WHERE id <= ?',
    ).get(maxId) as { total: number }
    const totalRows = totalRow.total

    let lastId = 0
    while (true) {
      const rows = getDb().prepare(`
        ${ARTICLE_DOC_SELECT}
        WHERE id > @lastId AND id <= @maxId
        ORDER BY id
        LIMIT @batch
      `).all({ lastId, maxId, batch: FETCH_BATCH }) as MeiliArticleDoc[]

      if (rows.length === 0) break

      const docs = rows.map(normalizeBooleans)
      await stagingIndex.addDocuments(docs).waitTask({ timeout: 60_000 })

      lastId = rows[rows.length - 1].id
      totalIndexed += rows.length
      log.info(
        `Index rebuild: indexed ${rows.length} rows (lastId=${lastId}, progress=${totalIndexed}/${totalRows})`,
      )
    }

    // 4. Promote staging to production
    if (indexSet.has(ARTICLES_INDEX)) {
      await client.swapIndexes([
        { indexes: [ARTICLES_INDEX, ARTICLES_STAGING_INDEX] } as any,
      ]).waitTask({ timeout: 60_000 })
      await client.deleteIndex(ARTICLES_STAGING_INDEX).waitTask({ timeout: 60_000 })
    } else {
      // First run: no existing articles index — create empty one for swap
      await client.createIndex(ARTICLES_INDEX, { primaryKey: 'id' }).waitTask({ timeout: 60_000 })
      await client.swapIndexes([
        { indexes: [ARTICLES_INDEX, ARTICLES_STAGING_INDEX] } as any,
      ]).waitTask({ timeout: 60_000 })
      await client.deleteIndex(ARTICLES_STAGING_INDEX).waitTask({ timeout: 60_000 })
    }

    // 5. Replay change log. Resolve order-independently via set arithmetic —
    //    delete wins over touch — then re-fetch current DB state for each touch
    //    so the new prod index reflects whatever landed during the rebuild.
    if (changeLog && changeLog.length > 0) {
      const prodIndex = client.index(ARTICLES_INDEX)
      const touchedIds = new Set<number>()
      const deletedIds = new Set<number>()
      for (const entry of changeLog) {
        if (entry.action === 'touch') touchedIds.add(entry.id)
        else deletedIds.add(entry.id)
      }
      for (const id of deletedIds) touchedIds.delete(id)

      if (touchedIds.size > 0) {
        const ids = [...touchedIds]
        for (let i = 0; i < ids.length; i += FETCH_BATCH) {
          const slice = ids.slice(i, i + FETCH_BATCH)
          const placeholders = slice.map(() => '?').join(',')
          const refetched = getDb().prepare(
            `${ARTICLE_DOC_SELECT} WHERE id IN (${placeholders})`,
          ).all(...slice) as MeiliArticleDoc[]
          if (refetched.length > 0) {
            await prodIndex.addDocuments(refetched.map(normalizeBooleans)).waitTask({ timeout: 60_000 })
          }
        }
      }
      for (const id of deletedIds) {
        await prodIndex.deleteDocument(id)
      }
      log.info(
        `Index rebuild: replayed ${touchedIds.size} touch, ${deletedIds.size} delete from change log`,
      )
    }

    searchReady = true
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    log.info(`Index rebuild complete: ${totalIndexed} articles in ${elapsed}s`)
  } catch (err) {
    // On failure: keep searchReady as-is (true if previously built, false if first time)
    log.error(`Index rebuild failed after ${totalIndexed} rows:`, err)
  } finally {
    changeLog = null
    rebuilding = false
  }
}

// --- Fire-and-forget sync helpers ---
//
// Each helper records a changeLog entry *before* scheduling the Meili write.
// Ordering rationale: if the write awaits or races with a concurrent rebuild,
// the in-memory touch/delete entry must already be in changeLog so that replay
// can re-fetch the latest DB state and apply it to the new prod index.

export function syncArticleToSearch(doc: MeiliArticleDoc): void {
  try {
    if (changeLog) changeLog.push({ action: 'touch', id: doc.id })
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.addDocuments([doc]).catch((err) => {
      log.error('Failed to sync article:', err)
    })
  } catch (err) {
    log.error('Failed to sync article:', err)
  }
}

export function deleteArticleFromSearch(id: number): void {
  try {
    if (changeLog) changeLog.push({ action: 'delete', id })
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.deleteDocument(id).catch((err) => {
      log.error('Failed to delete article from index:', err)
    })
  } catch (err) {
    log.error('Failed to delete article from index:', err)
  }
}

export function syncArticleScoreToSearch(id: number, score: number): void {
  try {
    if (changeLog) changeLog.push({ action: 'touch', id })
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.updateDocuments([{ id, score }]).catch((err) => {
      log.error('Failed to sync score:', err)
    })
  } catch (err) {
    log.error('Failed to sync score:', err)
  }
}

export function syncArticleFiltersToSearch(updates: { id: number; is_unread?: boolean; is_liked?: boolean; is_bookmarked?: boolean }[]): void {
  if (updates.length === 0) return
  try {
    if (changeLog) {
      for (const { id } of updates) changeLog.push({ action: 'touch', id })
    }
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.updateDocuments(updates).catch((err) => {
      log.error('Failed to sync article filters:', err)
    })
  } catch (err) {
    log.error('Failed to sync article filters:', err)
  }
}

export function deleteArticlesFromSearch(articleIds: number[]): void {
  if (articleIds.length === 0) return
  try {
    if (changeLog) {
      for (const id of articleIds) changeLog.push({ action: 'delete', id })
    }
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.deleteDocuments({ filter: `id IN [${articleIds.join(',')}]` }).catch((err) => {
      log.error('Failed to batch delete articles:', err)
    })
  } catch (err) {
    log.error('Failed to batch delete articles:', err)
  }
}

/**
 * Bulk-sync scores for all articles that have engagement or a non-zero score.
 * Uses the shared SCORED_ARTICLES_WHERE clause from server/db/articles.ts.
 * Called after the score recalculation batch to keep Meilisearch in sync.
 *
 * During a concurrent rebuild we still write to the live prod index (so it
 * stays fresh if rebuild fails) AND stamp touch entries up-front so replay
 * re-fetches the latest scores into the new prod index after swap.
 */
export async function syncAllScoredArticlesToSearch(): Promise<number> {
  const rows = getDb().prepare(`
    SELECT id, score FROM active_articles
    WHERE ${SCORED_ARTICLES_WHERE}
  `).all() as { id: number; score: number }[]

  if (rows.length === 0) return 0

  // Push every touch entry *before* the first await. If rebuild swaps and
  // replays mid-loop, we lose any entries pushed after `finally` nulls
  // changeLog, and those score updates would silently vanish on swap.
  if (changeLog) {
    for (const { id } of rows) changeLog.push({ action: 'touch', id })
  }

  const client = getSearchClient()
  const index = client.index(ARTICLES_INDEX)

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    await index.updateDocuments(batch.map(({ id, score }) => ({ id, score }))).waitTask({ timeout: 60_000 })
  }

  return rows.length
}

export function syncArticlesByFeedToSearch(docs: MeiliArticleDoc[]): void {
  if (docs.length === 0) return
  try {
    if (changeLog) {
      for (const doc of docs) changeLog.push({ action: 'touch', id: doc.id })
    }
    const client = getSearchClient()
    const index = client.index(ARTICLES_INDEX)
    index.addDocuments(docs).catch((err) => {
      log.error('Failed to batch sync articles:', err)
    })
  } catch (err) {
    log.error('Failed to batch sync articles:', err)
  }
}
