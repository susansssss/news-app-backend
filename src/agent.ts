import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { searchNews, searchPubMed, type FeedItem } from './sources';
import { TOPICS, type Topic } from './topics';

const MODEL = 'anthropic.claude-opus-5-5';
const ARTICLES_PER_TOPIC = 5;
const MAX_ARTICLES_PER_TOPIC_STORED = 20;
const LOOKBACK_DAYS = 7;
const MAX_CANDIDATES = 45;

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
	candidates: number;
	total_returned: number;
	inserted: number;
	skipped: number;
	invalid: number;
	removed_by_cap: number;
	source_errors?: string[];
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

const Selection = z.object({
	articles: z.array(
		z.object({
			candidate_id: z.number().int(),
			summary: z.string(),
			relevance_score: z.number().int(),
		}),
	),
});

const SYSTEM_PROMPT = `You are a news research analyst. You are given a numbered list of candidate articles gathered from news feeds and PubMed for one topic. Pick the most significant ones and summarise them.

Rules:
- Only pick candidates that are squarely on-topic per the topic description. Skip off-topic, promotional, opinion-only and low-quality items.
- Do not pick two candidates about the same event or paper; pick the best source for it.
- Rank by significance, preferring more recent items when significance is similar.
- If fewer candidates qualify than requested, return fewer. An empty list is acceptable.
- "summary": 2-3 sentences on what happened and why it matters, based only on the candidate's headline and snippet. Do not add facts that are not there.
- "relevance_score": integer 1-10 - how significant and on-topic the article is (10 = major, squarely on-topic development; 5 = moderately relevant; 1 = barely relevant).`;

function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
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

/** Keeps items inside the lookback window, with valid URLs, deduplicated by URL and headline; newest first. */
export function selectCandidates(items: FeedItem[], today: Date): FeedItem[] {
	const from = isoDate(new Date(today.getTime() - LOOKBACK_DAYS * 86_400_000));
	const to = isoDate(new Date(today.getTime() + 86_400_000));
	const seenUrls = new Set<string>();
	const seenHeadlines = new Set<string>();
	const kept: FeedItem[] = [];
	for (const item of items) {
		const url = normalizeUrl(item.url);
		const headlineKey = item.headline.toLowerCase().replace(/\W+/g, ' ').trim();
		if (!url || !item.published_at || item.published_at < from || item.published_at > to) continue;
		if (seenUrls.has(url) || seenHeadlines.has(headlineKey)) continue;
		seenUrls.add(url);
		seenHeadlines.add(headlineKey);
		kept.push({ ...item, url });
	}
	return kept.sort((a, b) => b.published_at!.localeCompare(a.published_at!)).slice(0, MAX_CANDIDATES);
}

async function gatherItems(topic: Topic): Promise<{ items: FeedItem[]; errors: string[] }> {
	const searches = topic.newsQueries.map((q) => searchNews(q));
	if (topic.pubmedQuery) searches.push(searchPubMed(topic.pubmedQuery, LOOKBACK_DAYS));
	const settled = await Promise.allSettled(searches);
	const items = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
	const errors = settled.flatMap((s) => (s.status === 'rejected' ? [String(s.reason instanceof Error ? s.reason.message : s.reason)] : []));
	return { items, errors };
}

function userPrompt(topic: Topic, candidates: FeedItem[], today: Date): string {
	const list = candidates
		.map((c, i) => `[${i}] ${c.headline}\nSource: ${c.source} | Date: ${c.published_at}\n${c.snippet || '(no snippet)'}`)
		.join('\n\n');
	return `Topic: ${topic.name}
What counts as on-topic: ${topic.brief}

Today is ${isoDate(today)}. From the candidates below, pick up to ${ARTICLES_PER_TOPIC} of the most recent and significant articles on this topic, ordered from most to least significant. Refer to each by its number as "candidate_id".

Candidates:

${list}`;
}

async function rankWithClaude(client: AnthropicBedrockMantle, topic: Topic, candidates: FeedItem[], today: Date) {
	const response = await client.messages.parse({
		model: MODEL,
		max_tokens: 16000,
		thinking: { type: 'adaptive' },
		output_config: { effort: 'medium', format: zodOutputFormat(Selection) },
		system: SYSTEM_PROMPT,
		messages: [{ role: 'user', content: userPrompt(topic, candidates, today) }],
	});
	if (response.stop_reason === 'refusal') {
		throw new Error(`Claude declined the request (${response.stop_details?.category ?? 'no category'})`);
	}
	if (response.stop_reason !== 'end_turn' || !response.parsed_output) {
		throw new Error(`Claude returned no usable selection (stop_reason: ${response.stop_reason})`);
	}
	return response.parsed_output.articles;
}

/** Maps Claude's picks back onto the feed items; picks with unknown or repeated ids are dropped. */
export function toArticles(picks: z.infer<typeof Selection>['articles'], candidates: FeedItem[]): CandidateArticle[] {
	const used = new Set<number>();
	const articles: CandidateArticle[] = [];
	for (const pick of picks.slice(0, ARTICLES_PER_TOPIC)) {
		const item = candidates[pick.candidate_id];
		const summary = pick.summary.trim();
		if (!item || used.has(pick.candidate_id) || !summary) continue;
		used.add(pick.candidate_id);
		articles.push({
			headline: item.headline,
			source: item.source,
			published_at: item.published_at,
			url: item.url,
			summary,
			relevance_score: Math.min(10, Math.max(1, Math.round(pick.relevance_score))),
		});
	}
	return articles;
}

export async function storeArticles(db: D1Database, topic: Topic, articles: CandidateArticle[]) {
	const insert = db.prepare(
		`INSERT INTO articles (topic, headline, source, published_at, url, summary, relevance_score)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (url) DO NOTHING
		 RETURNING id`,
	);
	const results = articles.length
		? await db.batch(
				articles.map((a) => insert.bind(topic.id, a.headline, a.source, a.published_at, a.url, a.summary, a.relevance_score)),
			)
		: [];
	// Count RETURNING rows, not meta.changes: the search-index triggers inflate the change count.
	const inserted = results.reduce((n, r) => n + r.results.length, 0);

	// Keep the newest articles per topic; undated ones are ranked by when they were fetched.
	const cap = await db
		.prepare(
			`DELETE FROM articles
			 WHERE topic = ?1 AND id NOT IN (
				SELECT id FROM articles WHERE topic = ?1
				ORDER BY COALESCE(published_at, substr(fetched_at, 1, 10)) DESC, id DESC
				LIMIT ?2)
			 RETURNING id`,
		)
		.bind(topic.id, MAX_ARTICLES_PER_TOPIC_STORED)
		.all();

	return { inserted, skipped: articles.length - inserted, removed_by_cap: cap.results.length };
}

async function runTopic(client: AnthropicBedrockMantle, db: D1Database, topic: Topic, today: Date): Promise<TopicResult> {
	const result: TopicResult = { topic: topic.id, candidates: 0, total_returned: 0, inserted: 0, skipped: 0, invalid: 0, removed_by_cap: 0 };
	try {
		const { items, errors } = await gatherItems(topic);
		if (errors.length) result.source_errors = errors;
		const candidates = selectCandidates(items, today);
		result.candidates = candidates.length;
		if (!candidates.length) throw new Error('No candidate articles found in the past 7 days');

		const picks = await rankWithClaude(client, topic, candidates, today);
		result.total_returned = picks.length;
		const articles = toArticles(picks, candidates);
		result.invalid = Math.min(picks.length, ARTICLES_PER_TOPIC) - articles.length;
		Object.assign(result, await storeArticles(db, topic, articles));
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		console.error(`agent: topic ${topic.id} failed`, err);
	}
	return result;
}

export async function runAgent(env: Env): Promise<AgentResult> {
	const started = Date.now();
	const client = new AnthropicBedrockMantle({ awsRegion: env.AWS_REGION, apiKey: env.BEDROCK_API_KEY });
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
