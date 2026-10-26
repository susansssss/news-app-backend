import Anthropic from '@anthropic-ai/sdk';
import { TOPICS, type Topic } from './topics';

const MODEL = 'claude-opus-5-5';
const ARTICLES_PER_TOPIC = 5;
const MAX_ARTICLES_PER_TOPIC_STORED = 20;
const LOOKBACK_DAYS = 7;
const MAX_PAUSE_RESUMES = 4;

export interface CandidateArticle {
	headline: string;
	source: string;
	published_at: string | null;
	url: string;
	summary: string;
	relevance_score: number;
}

export interface TopicResult {
	topic: string;
	total_returned: number;
	inserted: number;
	skipped: number;
	invalid: number;
	removed_by_cap: number;
	error?: string;
}

export interface AgentResult {
	inserted: number;
	skipped: number;
	total_returned: number;
	invalid: number;
	removed_by_cap: number;
	duration_ms: number;
	topics: TopicResult[];
}

const SYSTEM_PROMPT = `You are a news research analyst. Use web search to find recent, significant news articles on the topic you are given, then report them as JSON.

Rules:
- Only include articles published within the date window you are given. Use the article's own publication date.
- Every URL must be the direct URL of a specific article that appeared in your search results. Never invent or guess URLs, and never use a homepage or search page.
- Prefer primary and reputable sources. Do not include two articles about the same event; pick the best one.
- If fewer articles qualify than requested, return fewer. An empty array is acceptable.

Your final message must be only a JSON array, with no prose or code fences. Each element has exactly these keys:
- "headline": the article's headline
- "source": the publication or organisation name (e.g. "Reuters", "Anthropic", "NEJM")
- "published_date": publication date as "YYYY-MM-DD"
- "url": the article URL
- "summary": 2-3 sentences on what happened and why it matters
- "relevance_score": integer 1-10 - how significant and on-topic the article is (10 = major, squarely on-topic development; 5 = moderately relevant; 1 = barely relevant)`;

function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function userPrompt(topic: Topic, today: Date): string {
	const from = new Date(today.getTime() - LOOKBACK_DAYS * 86_400_000);
	return `Topic: ${topic.name}
What counts as on-topic: ${topic.brief}

Today is ${isoDate(today)}. Find the ${ARTICLES_PER_TOPIC} most recent and significant articles on this topic published between ${isoDate(from)} and ${isoDate(today)}, ordered from most to least significant.`;
}

/**
 * Pulls the JSON array out of Claude's reply. With web search the reply is split across
 * several text blocks (one per citation span), so the blocks are concatenated first.
 */
export function extractJsonArray(text: string): unknown[] {
	const cleaned = text.replace(/```(?:json)?/gi, '').trim();
	const start = cleaned.indexOf('[');
	const end = cleaned.lastIndexOf(']');
	if (start === -1 || end < start) throw new Error('No JSON array found in Claude response');
	const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
	if (!Array.isArray(parsed)) throw new Error('Claude response JSON is not an array');
	return parsed;
}

/** Drops fragments and utm_* tracking params so the same article maps to one URL. */
export function normalizeUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	url.hash = '';
	for (const key of [...url.searchParams.keys()]) {
		if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
	}
	return url.toString();
}

function normalizeDate(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
	if (!match || Number.isNaN(Date.parse(match[1]))) return null;
	return match[1];
}

function nonEmptyString(raw: unknown): string | null {
	return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** Validates one element of Claude's array; returns null if it can't be stored. */
export function toCandidate(raw: unknown): CandidateArticle | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const item = raw as Record<string, unknown>;
	const headline = nonEmptyString(item.headline);
	const source = nonEmptyString(item.source);
	const summary = nonEmptyString(item.summary);
	const url = typeof item.url === 'string' ? normalizeUrl(item.url) : null;
	const score = Number(item.relevance_score);
	if (!headline || !source || !summary || !url || !Number.isFinite(score)) return null;
	return {
		headline,
		source,
		published_at: normalizeDate(item.published_date),
		url,
		summary,
		relevance_score: Math.min(10, Math.max(1, Math.round(score))),
	};
}

async function askClaude(client: Anthropic, topic: Topic, today: Date): Promise<unknown[]> {
	const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: userPrompt(topic, today) }];

	for (let attempt = 0; ; attempt++) {
		const response = await client.beta.messages.create({
			model: MODEL,
			max_tokens: 16000,
			thinking: { type: 'adaptive' },
			output_config: { effort: 'medium' },
			betas: ['server-side-fallback-2026-07-01'],
			fallbacks: 'default',
			system: SYSTEM_PROMPT,
			tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
			messages,
		});

		// The server-side search loop hit its iteration limit; resend so it resumes where it stopped.
		if (response.stop_reason === 'pause_turn' && attempt < MAX_PAUSE_RESUMES) {
			messages.push({ role: 'assistant', content: response.content });
			continue;
		}
		if (response.stop_reason === 'refusal') {
			throw new Error(`Claude declined the request (${response.stop_details?.category ?? 'no category'})`);
		}
		if (response.stop_reason !== 'end_turn') {
			throw new Error(`Claude stopped early (stop_reason: ${response.stop_reason})`);
		}

		const text = response.content
			.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
			.map((block) => block.text)
			.join('');
		return extractJsonArray(text);
	}
}

export async function storeArticles(db: D1Database, topic: Topic, articles: CandidateArticle[]) {
	const insert = db.prepare(
		`INSERT INTO articles (topic, headline, source, published_at, url, summary, relevance_score)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (url) DO NOTHING`,
	);
	const results = articles.length
		? await db.batch(
				articles.map((a) => insert.bind(topic.id, a.headline, a.source, a.published_at, a.url, a.summary, a.relevance_score)),
			)
		: [];
	const inserted = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);

	// Keep the newest articles per topic; undated ones are ranked by when they were fetched.
	const cap = await db
		.prepare(
			`DELETE FROM articles
			 WHERE topic = ?1 AND id NOT IN (
				SELECT id FROM articles WHERE topic = ?1
				ORDER BY COALESCE(published_at, substr(fetched_at, 1, 10)) DESC, id DESC
				LIMIT ?2)`,
		)
		.bind(topic.id, MAX_ARTICLES_PER_TOPIC_STORED)
		.run();

	return { inserted, skipped: articles.length - inserted, removed_by_cap: cap.meta.changes ?? 0 };
}

async function runTopic(client: Anthropic, db: D1Database, topic: Topic, today: Date): Promise<TopicResult> {
	const result: TopicResult = { topic: topic.id, total_returned: 0, inserted: 0, skipped: 0, invalid: 0, removed_by_cap: 0 };
	try {
		const raw = await askClaude(client, topic, today);
		result.total_returned = raw.length;
		const candidates = raw.map(toCandidate).filter((a): a is CandidateArticle => a !== null);
		result.invalid = raw.length - candidates.length;
		Object.assign(result, await storeArticles(db, topic, candidates));
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		console.error(`agent: topic ${topic.id} failed`, err);
	}
	return result;
}

export async function runAgent(env: Env): Promise<AgentResult> {
	const started = Date.now();
	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
	const today = new Date();
	const topics = await Promise.all(TOPICS.map((topic) => runTopic(client, env.DB, topic, today)));

	const sum = (key: 'inserted' | 'skipped' | 'total_returned' | 'invalid' | 'removed_by_cap') =>
		topics.reduce((n, t) => n + t[key], 0);
	return {
		inserted: sum('inserted'),
		skipped: sum('skipped'),
		total_returned: sum('total_returned'),
		invalid: sum('invalid'),
		removed_by_cap: sum('removed_by_cap'),
		duration_ms: Date.now() - started,
		topics,
	};
}
