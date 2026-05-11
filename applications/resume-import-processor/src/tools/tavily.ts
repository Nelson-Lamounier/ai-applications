/**
 * @format
 * Tavily web search tool — used to research job roles during career enrichment.
 *
 * Interface is intentionally narrow: one method, one concern.
 * Swap the implementation (Brave, Serper, etc.) by replacing this file.
 */

import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('resume-import-processor');

export interface SearchResult {
  title:   string;
  url:     string;
  content: string; // Tavily returns LLM-optimised snippets
  score:   number;
}

export interface WebSearchTool {
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}

export class TavilySearchTool implements WebSearchTool {
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.tavily.com/search';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    return tracer.startActiveSpan('resume_import.tavily_search', {
      attributes: { 'tavily.query': query, 'tavily.max_results': maxResults },
    }, async (span) => {
      try {
        const response = await fetch(this.baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key:             this.apiKey,
            query,
            search_depth:        'basic',
            max_results:         maxResults,
            include_answer:      false,
            include_raw_content: false,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Tavily search failed: ${response.status} ${body}`);
        }

        const data = await response.json() as {
          results?: Array<{ title: string; url: string; content: string; score: number }>;
        };

        const results = (data.results ?? []).map((r) => ({
          title: r.title, url: r.url, content: r.content, score: r.score,
        }));
        span.setAttributes({
          'tavily.results_count': results.length,
          'http.status_code':     response.status,
        });
        return results;
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}

/** Null implementation — used when TAVILY_API_KEY is absent (free-tier enrichment skip). */
export class NoOpSearchTool implements WebSearchTool {
  async search(_query: string, _maxResults?: number): Promise<SearchResult[]> {
    return [];
  }
}
