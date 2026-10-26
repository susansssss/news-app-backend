const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class BadRequestError extends Error {}

function dateParam(params: URLSearchParams, name: string): string | null {
	const value = params.get(name);
	if (value === null || value === '') return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
		throw new BadRequestError(`"${name}" must be a date in YYYY-MM-DD format`);
	}
	return value;
}

function intParam(params: URLSearchParams, name: string, min: number, max: number): number | null {
	const value = params.get(name);
	if (value === null || value === '') return null;
	const n = Number(value);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new BadRequestError(`"${name}" must be an integer from ${min} to ${max}`);
	}
	return n;
}

/**
 * Filters: topic (exact id), from / to (inclusive publication dates), source (case-insensitive
 * substring), min_score (1-10), limit (1-200, default 50). Newest articles first.
 */
export async function queryArticles(db: D1Database, params: URLSearchParams) {
	const where: string[] = [];
	const binds: (string | number)[] = [];

	const topic = params.get('topic');
	if (topic) {
		where.push('topic = ?');
		binds.push(topic);
	}
	const from = dateParam(params, 'from');
	if (from) {
		where.push('published_at >= ?');
		binds.push(from);
	}
	const to = dateParam(params, 'to');
	if (to) {
		where.push('published_at <= ?');
		binds.push(to);
	}
	if (from && to && from > to) throw new BadRequestError('"from" must not be after "to"');
	const source = params.get('source');
	if (source) {
		where.push("source LIKE ? ESCAPE '\\'");
		binds.push(`%${source.replace(/[\\%_]/g, '\\$&')}%`);
	}
	const minScore = intParam(params, 'min_score', 1, 10);
	if (minScore !== null) {
		where.push('relevance_score >= ?');
		binds.push(minScore);
	}
	const limit = intParam(params, 'limit', 1, MAX_LIMIT) ?? DEFAULT_LIMIT;

	const sql =
		'SELECT id, topic, headline, source, published_at, url, summary, relevance_score, fetched_at FROM articles' +
		(where.length ? ` WHERE ${where.join(' AND ')}` : '') +
		' ORDER BY published_at DESC NULLS LAST, id DESC LIMIT ?';
	const { results } = await db
		.prepare(sql)
		.bind(...binds, limit)
		.all();
	return { count: results.length, articles: results };
}
