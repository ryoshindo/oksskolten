import { fetchFullText, type FetchFullTextOptions } from './content.js'
import type { ParseHtmlResult } from './contentWorker.js'

const ARXIV_ABS_RE = /^https?:\/\/arxiv\.org\/abs\/([^/?#]+)/i
// Hugging Face papers pages (huggingface.co/papers/<arxiv-id>) wrap the arxiv
// abstract with extra HF metadata, so the extracted body is effectively the
// abstract only. The path segment is the arxiv paper ID, so we rewrite to
// arxiv.org/abs/<id> and let the arxiv pipeline pick the html full text.
const HF_PAPERS_RE = /^https?:\/\/huggingface\.co\/papers\/([^/?#]+)/i

// arXiv HTML pages for papers without a rendered HTML version return a near-empty
// stub (~300 bytes after Readability). Anything under this is treated as "no HTML
// version" and the caller falls back to the abstract page.
export const ARXIV_HTML_STUB_THRESHOLD = 1000

export type ArxivFetchSource = 'html' | 'abs' | 'other'

export type FetchFullTextArxivAwareResult = ParseHtmlResult & {
  source: ArxivFetchSource
  sourceUrl: string
}

export function arxivHtmlUrl(absUrl: string): string | null {
  const m = ARXIV_ABS_RE.exec(absUrl)
  return m ? `https://arxiv.org/html/${m[1]}` : null
}

export function huggingFaceToArxivAbsUrl(url: string): string | null {
  const m = HF_PAPERS_RE.exec(url)
  return m ? `https://arxiv.org/abs/${m[1]}` : null
}

export async function fetchFullTextArxivAware(
  url: string,
  options?: FetchFullTextOptions,
): Promise<FetchFullTextArxivAwareResult> {
  const absUrl = huggingFaceToArxivAbsUrl(url) ?? url
  const htmlUrl = arxivHtmlUrl(absUrl)
  if (!htmlUrl) {
    const r = await fetchFullText(url, options)
    return { ...r, source: 'other', sourceUrl: url }
  }

  let htmlResult: ParseHtmlResult | null = null
  let htmlError: unknown = null
  try {
    htmlResult = await fetchFullText(htmlUrl, options)
  } catch (err) {
    htmlError = err
  }

  const htmlLen = htmlResult?.fullText.length ?? 0
  if (htmlResult && htmlLen >= ARXIV_HTML_STUB_THRESHOLD) {
    return { ...htmlResult, source: 'html', sourceUrl: htmlUrl }
  }

  try {
    const absResult = await fetchFullText(absUrl, options)
    if (htmlResult && absResult.fullText.length <= htmlLen) {
      return { ...htmlResult, source: 'html', sourceUrl: htmlUrl }
    }
    return { ...absResult, source: 'abs', sourceUrl: absUrl }
  } catch (err) {
    if (htmlResult) return { ...htmlResult, source: 'html', sourceUrl: htmlUrl }
    throw htmlError ?? err
  }
}
