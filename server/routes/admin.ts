import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { fetchAllFeeds, fetchProgress, getFeedState, type FetchProgressEvent } from '../fetcher.js'
import {
  arxivHtmlUrl,
  huggingFaceToArxivAbsUrl,
  fetchFullTextArxivAware,
  ARXIV_HTML_STUB_THRESHOLD,
} from '../fetcher/arxiv.js'
import { getArticleById, updateArticleContent } from '../db/index.js'
import { getDb } from '../db/connection.js'
import { requireJson } from '../auth.js'
import { NumericIdParams, parseOrBadRequest } from '../lib/validation.js'

const RefetchArxivBody = z.object({
  article_id: z.number().int().positive(),
})

const ArxivStatusQuery = z.object({
  feed_id: z.coerce.number().int().positive(),
})

export async function adminRoutes(api: FastifyInstance): Promise<void> {
  api.post(
    '/api/admin/fetch-all',
    async (_request, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      await fetchAllFeeds((event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      })

      reply.raw.end()
    },
  )

  // --- Single feed fetch progress (EventEmitter subscribe) ---

  api.get('/api/feeds/:id/fetch-progress', async (request, reply) => {
    const feedId = NumericIdParams.parse(request.params).id

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    // Late subscriber: replay current state
    const currentState = getFeedState(feedId)
    if (currentState) {
      reply.raw.write(`data: ${JSON.stringify({
        type: 'feed-articles-found', feed_id: feedId, total: currentState.total
      })}\n\n`)
      if (currentState.fetched > 0) {
        reply.raw.write(`data: ${JSON.stringify({
          type: 'article-done', feed_id: feedId,
          fetched: currentState.fetched, total: currentState.total
        })}\n\n`)
      }
      if (currentState.done) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'feed-complete', feed_id: feedId })}\n\n`)
        reply.raw.end()
        return
      }
    }

    const handler = (event: FetchProgressEvent) => {
      if ('feed_id' in event && event.feed_id !== feedId) return
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      if (event.type === 'feed-complete' && event.feed_id === feedId) {
        cleanup()
      }
    }

    function cleanup() {
      fetchProgress.off('event', handler)
      reply.raw.end()
    }

    fetchProgress.on('event', handler)
    request.raw.on('close', cleanup)
  })

  api.post(
    '/api/admin/refetch-arxiv-html',
    { preHandler: [requireJson] },
    async (request, reply) => {
      const body = parseOrBadRequest(RefetchArxivBody, request.body, reply)
      if (!body) return

      const article = getArticleById(body.article_id)
      if (!article) {
        reply.status(404).send({ error: 'Article not found' })
        return
      }

      const absUrl = huggingFaceToArxivAbsUrl(article.url) ?? article.url
      if (!arxivHtmlUrl(absUrl)) {
        reply.status(400).send({
          error: 'Article URL is not an arxiv abs or huggingface papers URL',
          url: article.url,
        })
        return
      }

      try {
        const result = await fetchFullTextArxivAware(article.url)
        updateArticleContent(body.article_id, {
          full_text: result.fullText,
          excerpt: result.excerpt,
          og_image: result.ogImage,
          last_error: null,
        })
        reply.send({
          article_id: body.article_id,
          source: result.source,
          source_url: result.sourceUrl,
          full_text_length: result.fullText.length,
          excerpt_length: result.excerpt?.length ?? 0,
          og_image: result.ogImage,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        request.log.warn({ articleId: body.article_id, absUrl: article.url, err: message }, 'refetch-arxiv-html failed')
        updateArticleContent(body.article_id, { last_error: `arxiv-html refetch: ${message}` })
        reply.status(502).send({ error: 'Failed to fetch arxiv HTML and abs', message, abs_url: article.url })
      }
    },
  )

  api.get('/api/admin/arxiv-status', async (request, reply) => {
    const query = parseOrBadRequest(ArxivStatusQuery, request.query, reply)
    if (!query) return
    const rows = getDb().prepare(`
      SELECT id, url, COALESCE(LENGTH(full_text), 0) AS full_text_length, last_error
      FROM active_articles
      WHERE feed_id = ?
      ORDER BY id
    `).all(query.feed_id) as Array<{ id: number; url: string; full_text_length: number; last_error: string | null }>

    const stub = rows.filter(r => r.full_text_length > 0 && r.full_text_length < ARXIV_HTML_STUB_THRESHOLD)
    const empty = rows.filter(r => r.full_text_length === 0)
    const errored = rows.filter(r => r.last_error != null)
    reply.send({
      feed_id: query.feed_id,
      total: rows.length,
      stub_count: stub.length,
      empty_count: empty.length,
      errored_count: errored.length,
      stub_ids: stub.map(r => r.id),
      empty_ids: empty.map(r => r.id),
      errored_ids: errored.map(r => r.id),
      articles: rows,
    })
  })
}
