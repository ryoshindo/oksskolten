import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { arxivHtmlUrl, fetchFullTextArxivAware, ARXIV_HTML_STUB_THRESHOLD } from './arxiv.js'
import * as content from './content.js'
import type { ParseHtmlResult } from './contentWorker.js'

function result(fullText: string): ParseHtmlResult {
  return { fullText, excerpt: fullText.slice(0, 200), ogImage: null, title: null }
}

describe('arxivHtmlUrl', () => {
  it('converts abs URL to html URL', () => {
    expect(arxivHtmlUrl('https://arxiv.org/abs/2401.12345')).toBe('https://arxiv.org/html/2401.12345')
  })

  it('preserves version suffix', () => {
    expect(arxivHtmlUrl('https://arxiv.org/abs/2401.12345v2')).toBe('https://arxiv.org/html/2401.12345v2')
  })

  it('strips query and fragment', () => {
    expect(arxivHtmlUrl('https://arxiv.org/abs/2401.12345?foo=bar#sec-1')).toBe('https://arxiv.org/html/2401.12345')
  })

  it('returns null for non-arxiv URLs', () => {
    expect(arxivHtmlUrl('https://example.com/abs/2401.12345')).toBeNull()
    expect(arxivHtmlUrl('https://arxiv.org/pdf/2401.12345')).toBeNull()
  })
})

describe('fetchFullTextArxivAware', () => {
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    spy = vi.spyOn(content, 'fetchFullText')
  })

  afterEach(() => {
    spy.mockRestore()
  })

  it('passes through non-arxiv URLs unchanged', async () => {
    const nonArxiv = 'https://example.com/post'
    spy.mockResolvedValueOnce(result('hello world'))
    const r = await fetchFullTextArxivAware(nonArxiv)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(nonArxiv, undefined)
    expect(r.source).toBe('other')
    expect(r.sourceUrl).toBe(nonArxiv)
  })

  it('prefers html version when it returns enough content', async () => {
    const absUrl = 'https://arxiv.org/abs/2401.12345'
    const htmlUrl = 'https://arxiv.org/html/2401.12345'
    spy.mockResolvedValueOnce(result('x'.repeat(ARXIV_HTML_STUB_THRESHOLD + 100)))
    const r = await fetchFullTextArxivAware(absUrl)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(htmlUrl, undefined)
    expect(r.source).toBe('html')
    expect(r.sourceUrl).toBe(htmlUrl)
  })

  it('falls back to abs when html returns a stub', async () => {
    const absUrl = 'https://arxiv.org/abs/2401.12345'
    spy.mockResolvedValueOnce(result('stub')) // html stub
    spy.mockResolvedValueOnce(result('abstract body that is longer than the stub')) // abs
    const r = await fetchFullTextArxivAware(absUrl)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(r.source).toBe('abs')
    expect(r.sourceUrl).toBe(absUrl)
  })

  it('keeps html result if abs fallback returns less content', async () => {
    const absUrl = 'https://arxiv.org/abs/2401.12345'
    spy.mockResolvedValueOnce(result('stub content a bit longer'))
    spy.mockResolvedValueOnce(result('tiny'))
    const r = await fetchFullTextArxivAware(absUrl)
    expect(r.source).toBe('html')
  })

  it('falls back to abs when html throws', async () => {
    const absUrl = 'https://arxiv.org/abs/2401.12345'
    spy.mockRejectedValueOnce(new Error('boom'))
    spy.mockResolvedValueOnce(result('abstract content body'))
    const r = await fetchFullTextArxivAware(absUrl)
    expect(r.source).toBe('abs')
    expect(r.fullText).toBe('abstract content body')
  })

  it('rethrows html error when abs also throws and no html result was captured', async () => {
    spy.mockRejectedValueOnce(new Error('html fail'))
    spy.mockRejectedValueOnce(new Error('abs fail'))
    await expect(fetchFullTextArxivAware('https://arxiv.org/abs/2401.12345')).rejects.toThrow('html fail')
  })

  it('returns captured html stub when abs throws', async () => {
    spy.mockResolvedValueOnce(result('stub'))
    spy.mockRejectedValueOnce(new Error('abs fail'))
    const r = await fetchFullTextArxivAware('https://arxiv.org/abs/2401.12345')
    expect(r.source).toBe('html')
    expect(r.fullText).toBe('stub')
  })
})
