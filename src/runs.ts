import { runAgent, type AgentResult } from './agent';

/** Manual (/agent) runs are refused if any run started within this window, capping Bedrock spend. */
export const COOLDOWN_SECONDS = 10 * 60;

export type RunTrigger = 'http' | 'cron';

export type RunOutcome = { status: 'ran'; result: AgentResult } | { status: 'cooldown'; retryAfterSeconds: number };

/**
 * Records a run in `agent_runs` and executes the pipeline. For HTTP runs the cooldown check and the
 * insert are one statement, so two simultaneous requests can't both start a run.
 */
export async function recordedRun(env: Env, trigger: RunTrigger): Promise<RunOutcome> {
	const cutoff = new Date(Date.now() - COOLDOWN_SECONDS * 1000).toISOString();
	const start = await env.DB.prepare(
		`INSERT INTO agent_runs (trigger)
		 SELECT ?1 WHERE ?1 = 'cron' OR NOT EXISTS (SELECT 1 FROM agent_runs WHERE started_at > ?2)
		 RETURNING id`,
	)
		.bind(trigger, cutoff)
		.first<{ id: number }>();

	if (!start) {
		const last = await env.DB.prepare('SELECT MAX(started_at) AS started_at FROM agent_runs').first<{ started_at: string }>();
		const elapsed = (Date.now() - Date.parse(last!.started_at)) / 1000;
		return { status: 'cooldown', retryAfterSeconds: Math.max(1, Math.ceil(COOLDOWN_SECONDS - elapsed)) };
	}

	let result: AgentResult | undefined;
	let failure: string | undefined;
	try {
		result = await runAgent(env);
		return { status: 'ran', result };
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
		throw err;
	} finally {
		const errors = failure ? [failure] : (result?.topics.flatMap((t) => (t.error ? [`${t.topic}: ${t.error}`] : [])) ?? []);
		await env.DB.prepare(
			`UPDATE agent_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), inserted = ?, skipped = ?, total_returned = ?, errors = ?
			 WHERE id = ?`,
		)
			.bind(result?.inserted ?? 0, result?.skipped ?? 0, result?.total_returned ?? 0, errors.length ? JSON.stringify(errors) : null, start.id)
			.run();
	}
}

/** When the most recent pipeline run finished, or null if none has. */
export async function lastRefreshed(db: D1Database): Promise<string | null> {
	const row = await db.prepare('SELECT MAX(finished_at) AS finished_at FROM agent_runs').first<{ finished_at: string | null }>();
	return row?.finished_at ?? null;
}
