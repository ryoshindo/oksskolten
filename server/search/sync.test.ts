import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setupTestDb } from '../__tests__/helpers/testDb.js'
import { getDb } from '../db/connection.js'

// --- Meilisearch client mock ---
//
// Separate mock functions per logical target (staging vs production) so tests
// can distinguish rebuild-loop writes from mid-rebuild direct writes and from
// post-swap replay writes. All targets share `mockWaitTask` — its call count
// is mostly incidental.

const mockWaitTask = vi.fn().mockResolvedValue({})
const waitTaskResult = () => ({ waitTask: mockWaitTask })

const stagingAddDocuments = vi.fn((_docs: unknown[]) => waitTaskResult())
const stagingUpdateSettings = vi.fn((_settings: unknown) => waitTaskResult())

const prodAddDocuments = vi.fn((_docs: unknown[]) => waitTaskResult())
const prodUpdateDocuments = vi.fn((_docs: unknown[]) => waitTaskResult())
const prodDeleteDocument = vi.fn((_id: number) => Promise.resolve({}))
const prodDeleteDocuments = vi.fn((_arg: unknown) => waitTaskResult())

const mockGetIndexes = vi.fn().mockResolvedValue({ results: [] as { uid: string }[] })
const mockCreateIndex = vi.fn((_name: string, _opts?: unknown) => waitTaskResult())
const mockDeleteIndex = vi.fn((_name: string) => waitTaskResult())
const mockSwapIndexes = vi.fn((_swaps: unknown) => waitTaskResult())

// Hook fired inside a staging addDocuments call — used by tests to simulate
// concurrent DB mutations mid-rebuild. Cleared automatically after firing.
let onStagingAddDocuments: (() => void) | null = null

stagingAddDocuments.mockImplementation(() => {
  if (onStagingAddDocuments) {
    const cb = onStagingAddDocuments
    onStagingAddDocuments = null
    cb()
  }
  return { waitTask: mockWaitTask }
})

vi.mock('./client.js', () => ({
  getSearchClient: () => ({
    index: (name: string) => {
      if (name === 'articles_staging') {
        return {
          addDocuments: stagingAddDocuments,
          updateSettings: stagingUpdateSettings,
          updateDocuments: prodUpdateDocuments,
          deleteDocument: prodDeleteDocument,
          deleteDocuments: prodDeleteDocuments,
        }
      }
      return {
        addDocuments: prodAddDocuments,
        updateDocuments: prodUpdateDocuments,
        deleteDocument: prodDeleteDocument,
        deleteDocuments: prodDeleteDocuments,
        updateSettings: stagingUpdateSettings,
      }
    },
    getIndexes: mockGetIndexes,
    createIndex: mockCreateIndex,
    deleteIndex: mockDeleteIndex,
    swapIndexes: mockSwapIndexes,
  }),
  ARTICLES_INDEX: 'articles',
  ARTICLES_STAGING_INDEX: 'articles_staging',
}))

import {
  syncAllScoredArticlesToSearch,
  rebuildSearchIndex,
  syncArticleFiltersToSearch,
  _setRebuilding,
  _setChangeLogForTest,
  _setFetchBatchForTest,
} from './sync.js'
import { insertArticle, markArticleLiked } from '../db/articles.js'

function seedFeed(): number {
  return getDb().prepare(
    "INSERT INTO feeds (name, url) VALUES ('Test', 'https://example.com/feed')",
  ).run().lastInsertRowid as number
}

function seedArticle(feedId: number, opts: { url: string; published_at?: string; title?: string }): number {
  return getDb().prepare(
    'INSERT INTO articles (feed_id, title, url, published_at) VALUES (?, ?, ?, ?)',
  ).run(
    feedId,
    opts.title ?? 'Test Article',
    opts.url,
    opts.published_at ?? new Date().toISOString(),
  ).lastInsertRowid as number
}

function resetAllMocks(): void {
  mockWaitTask.mockClear()
  stagingAddDocuments.mockClear()
  stagingUpdateSettings.mockClear()
  prodAddDocuments.mockClear()
  prodUpdateDocuments.mockClear()
  prodDeleteDocument.mockClear()
  prodDeleteDocuments.mockClear()
  mockGetIndexes.mockClear()
  mockCreateIndex.mockClear()
  mockDeleteIndex.mockClear()
  mockSwapIndexes.mockClear()
  mockGetIndexes.mockResolvedValue({ results: [] })
  onStagingAddDocuments = null
}

function allCallsOf<T extends { mock: { calls: unknown[][] } }>(fn: T): { id: number }[][] {
  return fn.mock.calls.map((call) => call[0] as { id: number }[])
}

describe('syncAllScoredArticlesToSearch', () => {
  beforeEach(() => {
    setupTestDb()
    resetAllMocks()
    _setRebuilding(false)
    _setChangeLogForTest(null)
  })

  it('syncs articles with engagement to Meilisearch and returns count', async () => {
    const feedId = seedFeed()
    const id1 = seedArticle(feedId, { url: 'https://example.com/1' })
    seedArticle(feedId, { url: 'https://example.com/2' })

    getDb().prepare("UPDATE articles SET liked_at = datetime('now'), score = 10.0 WHERE id = ?").run(id1)

    const synced = await syncAllScoredArticlesToSearch()

    expect(synced).toBe(1)
    expect(prodUpdateDocuments).toHaveBeenCalledTimes(1)
    const docs = prodUpdateDocuments.mock.calls[0][0] as { id: number; score: number }[]
    expect(docs).toHaveLength(1)
    expect(docs[0].id).toBe(id1)
    expect(docs[0].score).toBeGreaterThan(0)
    expect(mockWaitTask).toHaveBeenCalledTimes(1)
  })

  it('returns 0 when no articles qualify', async () => {
    const feedId = seedFeed()
    seedArticle(feedId, { url: 'https://example.com/no-engagement' })

    const synced = await syncAllScoredArticlesToSearch()

    expect(synced).toBe(0)
    expect(prodUpdateDocuments).not.toHaveBeenCalled()
  })

  it('includes articles with score > 0 but no engagement flags', async () => {
    const feedId = seedFeed()
    const id1 = seedArticle(feedId, { url: 'https://example.com/residual' })

    getDb().prepare('UPDATE articles SET score = 5.0 WHERE id = ?').run(id1)

    await syncAllScoredArticlesToSearch()

    expect(prodUpdateDocuments).toHaveBeenCalledTimes(1)
    const docs = prodUpdateDocuments.mock.calls[0][0] as { id: number; score: number }[]
    expect(docs).toHaveLength(1)
    expect(docs[0].id).toBe(id1)
  })

  it('syncs multiple qualifying articles in one call', async () => {
    const feedId = seedFeed()
    const id1 = seedArticle(feedId, { url: 'https://example.com/a' })
    const id2 = seedArticle(feedId, { url: 'https://example.com/b' })
    const id3 = seedArticle(feedId, { url: 'https://example.com/c' })

    getDb().prepare("UPDATE articles SET liked_at = datetime('now'), score = 10.0 WHERE id = ?").run(id1)
    getDb().prepare("UPDATE articles SET bookmarked_at = datetime('now'), score = 5.0 WHERE id = ?").run(id2)
    getDb().prepare("UPDATE articles SET read_at = datetime('now'), score = 2.0 WHERE id = ?").run(id3)

    await syncAllScoredArticlesToSearch()

    expect(prodUpdateDocuments).toHaveBeenCalledTimes(1)
    const docs = prodUpdateDocuments.mock.calls[0][0] as { id: number; score: number }[]
    expect(docs).toHaveLength(3)
    const ids = docs.map(d => d.id).sort()
    expect(ids).toEqual([id1, id2, id3].sort())
  })

  it('continues syncing during a rebuild and records touch entries up front', async () => {
    const feedId = seedFeed()
    const id1 = seedArticle(feedId, { url: 'https://example.com/rebuilding' })
    getDb().prepare("UPDATE articles SET liked_at = datetime('now'), score = 10.0 WHERE id = ?").run(id1)

    _setRebuilding(true)
    const log: { action: 'touch' | 'delete'; id: number }[] = []
    _setChangeLogForTest(log)

    const synced = await syncAllScoredArticlesToSearch()

    expect(synced).toBe(1)
    expect(prodUpdateDocuments).toHaveBeenCalledTimes(1)
    expect(log).toEqual([{ action: 'touch', id: id1 }])
  })

  it('sends only id and score fields to Meilisearch', async () => {
    const feedId = seedFeed()
    const id1 = seedArticle(feedId, { url: 'https://example.com/fields' })
    getDb().prepare("UPDATE articles SET liked_at = datetime('now'), score = 7.5 WHERE id = ?").run(id1)

    await syncAllScoredArticlesToSearch()

    const docs = prodUpdateDocuments.mock.calls[0][0] as Record<string, unknown>[]
    expect(Object.keys(docs[0]).sort()).toEqual(['id', 'score'])
  })
})

describe('syncArticleFiltersToSearch', () => {
  beforeEach(() => {
    setupTestDb()
    resetAllMocks()
    _setRebuilding(false)
    _setChangeLogForTest(null)
  })

  it('records a touch per update when rebuild is running', () => {
    const log: { action: 'touch' | 'delete'; id: number }[] = []
    _setChangeLogForTest(log)

    syncArticleFiltersToSearch([
      { id: 10, is_unread: false },
      { id: 11, is_liked: true },
    ])

    expect(log).toEqual([
      { action: 'touch', id: 10 },
      { action: 'touch', id: 11 },
    ])
    expect(prodUpdateDocuments).toHaveBeenCalledTimes(1)
  })

  it('does not touch change log when no rebuild is running', () => {
    syncArticleFiltersToSearch([{ id: 1, is_unread: false }])
    expect(prodUpdateDocuments).toHaveBeenCalledTimes(1)
  })
})

describe('rebuildSearchIndex', () => {
  const ORIGINAL_FETCH_BATCH = 50

  beforeEach(() => {
    setupTestDb()
    resetAllMocks()
    _setRebuilding(false)
    _setChangeLogForTest(null)
    _setFetchBatchForTest(ORIGINAL_FETCH_BATCH)
  })

  afterEach(() => {
    _setFetchBatchForTest(ORIGINAL_FETCH_BATCH)
  })

  it('indexes every article across multiple fetch batches', async () => {
    _setFetchBatchForTest(3)
    const feedId = seedFeed()
    const ids: number[] = []
    for (let i = 0; i < 7; i++) {
      ids.push(seedArticle(feedId, { url: `https://example.com/${i}`, title: `Article ${i}` }))
    }

    await rebuildSearchIndex()

    const stagedIds = new Set<number>()
    for (const batch of allCallsOf(stagingAddDocuments)) {
      for (const doc of batch) stagedIds.add(doc.id)
    }
    expect([...stagedIds].sort((a, b) => a - b)).toEqual(ids.sort((a, b) => a - b))
    // 7 rows / batch 3 = 3 staging calls (3 + 3 + 1), no replay expected.
    expect(stagingAddDocuments).toHaveBeenCalledTimes(3)
    expect(prodAddDocuments).not.toHaveBeenCalled()
  })

  it('normalizes SQLite 0/1 booleans before writing to the index', async () => {
    const feedId = seedFeed()
    const id = seedArticle(feedId, { url: 'https://example.com/booleans' })
    getDb().prepare("UPDATE articles SET liked_at = datetime('now') WHERE id = ?").run(id)

    await rebuildSearchIndex()

    const doc = stagingAddDocuments.mock.calls[0][0][0] as unknown as {
      id: number; is_unread: unknown; is_liked: unknown; is_bookmarked: unknown
    }
    expect(doc.id).toBe(id)
    expect(doc.is_unread).toBe(true)
    expect(doc.is_liked).toBe(true)
    expect(doc.is_bookmarked).toBe(false)
  })

  it('skips purged rows (active_articles view excludes them)', async () => {
    const feedId = seedFeed()
    const keep = seedArticle(feedId, { url: 'https://example.com/keep' })
    const drop = seedArticle(feedId, { url: 'https://example.com/drop' })
    getDb().prepare("UPDATE articles SET purged_at = datetime('now') WHERE id = ?").run(drop)

    await rebuildSearchIndex()

    const ids = allCallsOf(stagingAddDocuments).flat().map(d => d.id)
    expect(ids).toContain(keep)
    expect(ids).not.toContain(drop)
  })

  it('freezes the upper bound at maxId and captures concurrent inserts via replay', async () => {
    _setFetchBatchForTest(2)
    const feedId = seedFeed()
    for (let i = 0; i < 5; i++) {
      seedArticle(feedId, { url: `https://example.com/${i}` })
    }

    let newId = 0
    onStagingAddDocuments = () => {
      // Simulate a feed fetch landing mid-rebuild: inserts a row beyond maxId
      // and syncs it to search. During rebuild that becomes a change-log touch.
      newId = insertArticle({
        feed_id: feedId,
        title: 'inserted during rebuild',
        url: 'https://example.com/new',
        published_at: new Date().toISOString(),
      })
    }

    await rebuildSearchIndex()

    expect(newId).toBeGreaterThan(0)

    // The staging loop must not include the new id — maxId was frozen before
    // it appeared.
    for (const batch of allCallsOf(stagingAddDocuments)) {
      expect(batch.some(d => d.id === newId)).toBe(false)
    }

    // Replay (prodAddDocuments *after* swap) should pick it up. The mid-rebuild
    // direct write from syncArticleToSearch also lands in prod, so we assert on
    // the union: at least one prod-index write contains the new id.
    const prodBatches = allCallsOf(prodAddDocuments)
    const includesNew = prodBatches.some(batch => batch.some(d => d.id === newId))
    expect(includesNew).toBe(true)
  })

  it('replays filter updates that land during rebuild', async () => {
    _setFetchBatchForTest(2)
    const feedId = seedFeed()
    const target = seedArticle(feedId, { url: 'https://example.com/target' })
    seedArticle(feedId, { url: 'https://example.com/other1' })
    seedArticle(feedId, { url: 'https://example.com/other2' })

    onStagingAddDocuments = () => {
      // The first staging batch has already written the un-liked target doc.
      // markArticleLiked writes to the (still-live) prod index directly AND
      // stamps a touch into the change log — replay must re-fetch the fresh
      // row post-swap and add it to the new prod index.
      markArticleLiked(target, true)
    }

    await rebuildSearchIndex()

    const replayDocs = allCallsOf(prodAddDocuments).flat() as (
      { id: number; is_liked?: boolean }
    )[]
    const liked = replayDocs.find(d => d.id === target && d.is_liked === true)
    expect(liked).toBeDefined()
  })

  it('prefers delete over touch during replay', async () => {
    const feedId = seedFeed()
    const id = seedArticle(feedId, { url: 'https://example.com/1' })

    onStagingAddDocuments = () => {
      // Simulate two concurrent writers during rebuild: a score sync stamps
      // touch, then a purge stamps delete. Replay must pick delete.
      _setChangeLogForTest([
        { action: 'touch', id },
        { action: 'delete', id },
      ])
    }

    await rebuildSearchIndex()

    expect(prodDeleteDocument).toHaveBeenCalledWith(id)
    // Touch must not re-add the doc to the new prod index.
    for (const batch of allCallsOf(prodAddDocuments)) {
      expect(batch.some(d => d.id === id)).toBe(false)
    }
  })
})
