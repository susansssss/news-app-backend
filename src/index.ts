import { runAgent } from './agent';
import { BadRequestError, queryArticles } from './articles';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
	});
}

/** /agent spends Anthropic credits, so it requires `Authorization: Bearer <AGENT_TOKEN>`. */
function isAuthorized(request: Request, env: Env): boolean {
	if (!env.AGENT_TOKEN) return false;
	const supplied = new TextEncoder().encode(request.headers.get('Authorization') ?? '');
	const expected = new TextEncoder().encode(`Bearer ${env.AGENT_TOKEN}`);
	return supplied.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(supplied, expected);
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
					if (request.method !== 'POST' && request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
					if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
					return json(await runAgent(env));

				case '/articles':
					if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
					return json(await queryArticles(env.DB, url.searchParams));

				default:
					return json({ error: 'Not found', endpoints: ['/health', '/agent', '/articles'] }, 404);
			}
		} catch (err) {
			if (err instanceof BadRequestError) return json({ error: err.message }, 400);
			console.error('request failed', err);
			return json({ error: 'Internal server error' }, 500);
		}
	},

	async scheduled(controller, env, ctx): Promise<void> {
		if (!isSevenAmNewYork(controller.scheduledTime)) return;
		ctx.waitUntil(runAgent(env).then((result) => console.log('scheduled agent run', JSON.stringify(result))));
	},
} satisfies ExportedHandler<Env>;
