import { BadRequestError, queryArticles } from './articles';
import { answerQuestion, CHAT_MODELS, parseChatRequest, UpstreamError } from './chat';
import { lastRefreshed, recordedRun } from './runs';
import { TOPICS } from './topics';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...headers },
	});
}

/** /agent and /chat spend Bedrock credits, so they require `Authorization: Bearer <AGENT_TOKEN>`. */
function isAuthorized(request: Request, env: Env): boolean {
	if (!env.AGENT_TOKEN) return false;
	const supplied = new TextEncoder().encode(request.headers.get('Authorization') ?? '');
	const expected = new TextEncoder().encode(`Bearer ${env.AGENT_TOKEN}`);
	return supplied.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(supplied, expected);
}

function unauthorized(action: string): Response {
	return json({ error: `Unauthorized: a valid password is required to ${action}` }, 401, { 'WWW-Authenticate': 'Bearer realm="news-agent"' });
}

/** Cron runs in UTC, so both 11:00 and 12:00 UTC are scheduled and only the one at 7 AM New York time runs. */
function isSevenAmNewYork(time: number): boolean {
	const hour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(time);
	return Number(hour) === 7;
}

export default {
	async fetch(request, env): Promise<Response> {
		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

		const url = new URL(request.url);
		try {
			switch (url.pathname) {
				case '/health':
					return json({ status: 'ok', service: 'news-app-backend', timestamp: new Date().toISOString() });

				case '/agent':
					if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST, OPTIONS' });
					// Checked before the cooldown so unauthenticated requests can't use it up.
					if (!isAuthorized(request, env)) return unauthorized('run the pipeline');
					const outcome = await recordedRun(env, 'http');
					if (outcome.status === 'cooldown') {
						const retry = outcome.retryAfterSeconds;
						return json({ error: 'The agent ran recently; try again later', retry_after_seconds: retry }, 429, { 'Retry-After': String(retry) });
					}
					return json(outcome.result);

				case '/chat': {
					if (request.method === 'GET') {
						const models = Object.entries(CHAT_MODELS).map(([key, m]) => ({ model: key, id: m.id, name: m.name }));
						return json({ default_model: 'opus', models });
					}
					if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST, OPTIONS' });
					if (!isAuthorized(request, env)) return unauthorized('use chat');
					let body: unknown;
					try {
						body = await request.json();
					} catch {
						throw new BadRequestError('Request body must be valid JSON');
					}
					return json(await answerQuestion(env, parseChatRequest(body)));
				}

				case '/articles':
					if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
					const [articles, refreshed] = await Promise.all([queryArticles(env.DB, url.searchParams), lastRefreshed(env.DB)]);
					return json({ ...articles, last_refreshed: refreshed });

				case '/topics':
					if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
					return json({ topics: TOPICS.map(({ id, name }) => ({ id, name })) });

				default:
					return json({ error: 'Not found', endpoints: ['/health', '/agent', '/chat', '/articles', '/topics'] }, 404);
			}
		} catch (err) {
			if (err instanceof BadRequestError) return json({ error: err.message }, 400);
			if (err instanceof UpstreamError) return json({ error: err.message }, 502);
			console.error('request failed', err);
			return json({ error: 'Internal server error' }, 500);
		}
	},

	async scheduled(controller, env, ctx): Promise<void> {
		if (!isSevenAmNewYork(controller.scheduledTime)) return;
		ctx.waitUntil(recordedRun(env, 'cron').then((outcome) => console.log('scheduled agent run', JSON.stringify(outcome))));
	},
} satisfies ExportedHandler<Env>;
