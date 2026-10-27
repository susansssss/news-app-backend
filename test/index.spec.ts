import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeUrl, selectCandidates, storeArticles, toArticles } from "../src/agent";
import { buildPrompt, findContextArticles, parseChatRequest, resolveModel, toFtsQuery } from "../src/chat";
import { parseNewsRss } from "../src/sources";
import { TOPICS } from "../src/topics";

async function seed() {
	await env.DB.exec("DELETE FROM articles");
	const rows = [
		["llm-releases", "Model A launched", "Anthropic", "2026-10-20", "https://example.com/a", 9],
		["llm-releases", "Model B update", "OpenAI", "2026-10-24", "https://example.com/b", 6],
		["autoimmune-liver", "PBC trial results", "NEJM", "2026-10-22", "https://example.com/c", 8],
	] as const;
	await env.DB.batch(
		rows.map((r) =>
			env.DB.prepare(
				"INSERT INTO articles (topic, headline, source, published_at, url, summary, relevance_score) VALUES (?, ?, ?, ?, ?, 'Summary.', ?)",
			).bind(...r),
		),
	);
}

describe("/health", () => {
	it("returns ok with a timestamp and CORS headers", async () => {
		const res = await SELF.fetch("https://worker.test/health");
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const body = await res.json<{ status: string; timestamp: string }>();
		expect(body.status).toBe("ok");
		expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
	});

	it("answers CORS preflight", async () => {
		const res = await SELF.fetch("https://worker.test/articles", { method: "OPTIONS" });
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
	});
});

describe("/articles", () => {
	beforeEach(seed);

	it("returns all articles newest first with a count", async () => {
		const body = await (await SELF.fetch("https://worker.test/articles")).json<any>();
		expect(body.count).toBe(3);
		expect(body.articles.map((a: any) => a.url)).toEqual(["https://example.com/b", "https://example.com/c", "https://example.com/a"]);
	});

	it("applies topic, date range, source, min_score and limit filters", async () => {
		const get = async (qs: string) => (await (await SELF.fetch(`https://worker.test/articles?${qs}`)).json<any>()).articles;
		expect(await get("topic=llm-releases")).toHaveLength(2);
		expect(await get("from=2026-10-21&to=2026-10-23")).toHaveLength(1);
		expect((await get("source=anthrop"))[0].source).toBe("Anthropic");
		expect(await get("min_score=8")).toHaveLength(2);
		expect(await get("limit=1")).toHaveLength(1);
	});

	it("rejects invalid filters with 400", async () => {
		for (const qs of ["min_score=11", "limit=0", "from=10/20/2026", "from=2026-10-25&to=2026-10-01"]) {
			const res = await SELF.fetch(`https://worker.test/articles?${qs}`);
			expect(res.status, qs).toBe(400);
		}
	});
});

describe("/agent", () => {
	it("rejects missing or wrong passwords with 401 and WWW-Authenticate, without starting a run", async () => {
		await env.DB.exec("DELETE FROM agent_runs");
		for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: "test-token" }] as Record<string, string>[]) {
			const res = await SELF.fetch("https://worker.test/agent", { method: "POST", headers });
			expect(res.status).toBe(401);
			expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
			expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		}
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_runs").first<any>()).n).toBe(0);
	});

	it("only accepts POST", async () => {
		const res = await SELF.fetch("https://worker.test/agent", { headers: { Authorization: "Bearer test-token" } });
		expect(res.status).toBe(405);
	});
});

describe("/topics", () => {
	it("lists topic ids and names", async () => {
		const body = await (await SELF.fetch("https://worker.test/topics")).json<any>();
		expect(body.topics.map((t: any) => t.id)).toEqual(["llm-releases", "agentic-harnesses", "autoimmune-liver"]);
		expect(body.topics[0].name).toBeTruthy();
	});
});

describe("agent runs", () => {
	beforeEach(() => env.DB.exec("DELETE FROM agent_runs"));

	it("reports the last finished run as last_refreshed", async () => {
		expect((await (await SELF.fetch("https://worker.test/articles")).json<any>()).last_refreshed).toBeNull();
		await env.DB.exec("INSERT INTO agent_runs (trigger, started_at, finished_at) VALUES ('cron', '2026-10-26T11:00:00.000Z', '2026-10-26T11:00:12.000Z')");
		expect((await (await SELF.fetch("https://worker.test/articles")).json<any>()).last_refreshed).toBe("2026-10-26T11:00:12.000Z");
	});

	it("refuses a manual run during the cooldown with 429 and Retry-After", async () => {
		await env.DB.prepare("INSERT INTO agent_runs (trigger, started_at) VALUES ('http', ?)").bind(new Date(Date.now() - 60_000).toISOString()).run();
		const res = await SELF.fetch("https://worker.test/agent", { method: "POST", headers: { Authorization: "Bearer test-token" } });
		expect(res.status).toBe(429);
		const retry = Number(res.headers.get("Retry-After"));
		expect(retry).toBeGreaterThan(500);
		expect(retry).toBeLessThanOrEqual(540);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_runs").first<any>()).n).toBe(1);
	});
});

describe("/chat", () => {
	const auth = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
	const post = (body: unknown, headers: Record<string, string> = auth) =>
		SELF.fetch("https://worker.test/chat", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

	beforeEach(seed);

	it("lists the available models on GET", async () => {
		const body = await (await SELF.fetch("https://worker.test/chat")).json<any>();
		expect(body.default_model).toBe("opus");
		expect(body.models.map((m: any) => m.model)).toEqual(["opus", "sonnet", "haiku"]);
	});

	it("requires the password", async () => {
		const res = await post({ question: "hi" }, { "Content-Type": "application/json" });
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
	});

	it("rejects bad requests with 400", async () => {
		for (const body of ["not json", {}, { question: "  " }, { question: "x".repeat(1001) }, { question: "hi", model: "gpt-9" }, { question: "hi", topic: "sports" }]) {
			expect((await post(body)).status, JSON.stringify(body)).toBe(400);
		}
	});

	it("parses model preferences by short name or Bedrock id", () => {
		expect(resolveModel(undefined)).toBe("opus");
		expect(resolveModel("Sonnet")).toBe("sonnet");
		expect(resolveModel("anthropic.claude-haiku-4-5")).toBe("haiku");
		expect(resolveModel("claude-opus-5-5")).toBe("opus");
		expect(parseChatRequest({ question: " What's new? ", topic: "autoimmune-liver" })).toEqual({ question: "What's new?", model: "opus", topic: "autoimmune-liver" });
	});

	it("builds a full-text query from the question's distinctive words", () => {
		expect(toFtsQuery("What are the latest PBC trial results?")).toBe('"pbc" OR "trial" OR "results"');
		expect(toFtsQuery("What happened this week?")).toBeNull();
	});

	it("ranks matching articles first, then tops up with the newest", async () => {
		const articles = await findContextArticles(env.DB, "Any PBC trial results?", null, 3);
		expect(articles.map((a) => a.headline)).toEqual(["PBC trial results", "Model B update", "Model A launched"]);
	});

	it("falls back to the newest articles for broad questions and honours the topic filter", async () => {
		expect((await findContextArticles(env.DB, "What happened this week?", null, 2)).map((a) => a.headline)).toEqual(["Model B update", "PBC trial results"]);
		expect((await findContextArticles(env.DB, "PBC", "llm-releases", 5)).every((a) => a.topic === "llm-releases")).toBe(true);
	});

	it("keeps the search index in sync when articles are deleted", async () => {
		await env.DB.prepare("DELETE FROM articles WHERE headline = 'PBC trial results'").run();
		const articles = await findContextArticles(env.DB, "PBC trial", null, 5);
		expect(articles.some((a) => a.headline === "PBC trial results")).toBe(false);
	});

	it("numbers the context articles in the prompt", () => {
		const prompt = buildPrompt("Q?", [{ id: 1, topic: "llm-releases", headline: "H", source: "S", published_at: "2026-10-27", url: "https://x.test", summary: "Sum.", relevance_score: 5 }], new Date("2026-10-27T00:00:00Z"));
		expect(prompt).toContain("[1] H\nSource: S | Date: 2026-10-27 | Topic: New frontier LLM model versions\nSum.");
		expect(prompt).toContain("Question: Q?");
	});
});

describe("unknown routes", () => {
	it("returns 404 JSON with CORS headers", async () => {
		const res = await SELF.fetch("https://worker.test/nope");
		expect(res.status).toBe(404);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});

describe("feed parsing", () => {
	const bingXml = `<rss><channel><item><title>Lab ships Model X &amp; tools</title>
<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fnews.test%2fmodel-x%3futm_source%3drss&amp;c=1</link>
<description>Model X is &lt;b&gt;faster&lt;/b&gt;.</description><pubDate>Sun, 25 Oct 2026 16:19:00 GMT</pubDate><News:Source>Tech Daily</News:Source></item></channel></rss>`;

	it("unwraps Bing redirect links and decodes entities", () => {
		expect(parseNewsRss(bingXml)).toEqual([
			{ headline: "Lab ships Model X & tools", url: "https://news.test/model-x?utm_source=rss", source: "Tech Daily", published_at: "2026-10-25", snippet: "Model X is faster ." },
		]);
	});

	it("strips the outlet suffix from Google News titles", () => {
		const xml = `<item><title>Big launch - SiliconANGLE</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate><source url="https://siliconangle.com">SiliconANGLE</source></item>`;
		expect(parseNewsRss(xml)[0]).toMatchObject({ headline: "Big launch", source: "SiliconANGLE" });
	});
});

describe("candidate selection", () => {
	const today = new Date("2026-10-26T12:00:00Z");
	const item = (url: string, headline: string, published_at: string | null) => ({ url, headline, published_at, source: "S", snippet: "" });

	it("keeps the past 7 days, dedupes by URL and headline, newest first", () => {
		const kept = selectCandidates(
			[
				item("https://a.test/1", "One", "2026-10-20"),
				item("https://a.test/1#x", "One again", "2026-10-21"), // same URL once normalized
				item("https://b.test/2", "ONE!", "2026-10-22"), // same headline
				item("https://c.test/3", "Old", "2026-10-10"),
				item("https://d.test/4", "Undated", null),
				item("https://e.test/5", "Newest", "2026-10-26"),
			],
			today,
		);
		expect(kept.map((k) => k.headline)).toEqual(["Newest", "One"]);
	});

	it("normalizes URLs and rejects non-http ones", () => {
		expect(normalizeUrl(" https://x.test/a?utm_source=t&id=1#frag ")).toBe("https://x.test/a?id=1");
		expect(normalizeUrl("javascript:alert(1)")).toBeNull();
		expect(normalizeUrl("not a url")).toBeNull();
	});

	it("maps Claude's picks onto feed items, dropping bad ids and clamping scores", () => {
		const candidates = [item("https://a.test/1", "A", "2026-10-25"), item("https://b.test/2", "B", "2026-10-24")];
		const articles = toArticles(
			[
				{ candidate_id: 1, summary: "About B.", relevance_score: 14 },
				{ candidate_id: 1, summary: "Repeat.", relevance_score: 5 },
				{ candidate_id: 9, summary: "Unknown.", relevance_score: 5 },
				{ candidate_id: 0, summary: " ", relevance_score: 5 },
			],
			candidates,
		);
		expect(articles).toEqual([{ headline: "B", source: "S", published_at: "2026-10-24", url: "https://b.test/2", summary: "About B.", relevance_score: 10 }]);
	});
});

describe("storeArticles", () => {
	it("skips known URLs and caps each topic at the 20 newest articles", async () => {
		await env.DB.exec("DELETE FROM articles");
		const topic = TOPICS[0];
		const article = (day: number) => ({
			headline: `H${day}`,
			source: "S",
			published_at: `2026-09-${String(day).padStart(2, "0")}`,
			url: `https://x.test/${day}`,
			summary: "Sum.",
			relevance_score: 5,
		});

		const first = await storeArticles(env.DB, topic, Array.from({ length: 18 }, (_, i) => article(i + 1)));
		expect(first).toEqual({ inserted: 18, skipped: 0, removed_by_cap: 0 });

		// Days 17-18 already exist; 19-23 are new, pushing the topic to 23 rows.
		const second = await storeArticles(env.DB, topic, [17, 18, 19, 20, 21, 22, 23].map(article));
		expect(second).toEqual({ inserted: 5, skipped: 2, removed_by_cap: 3 });

		const { results } = await env.DB.prepare("SELECT published_at FROM articles WHERE topic = ? ORDER BY published_at").bind(topic.id).all<{ published_at: string }>();
		expect(results).toHaveLength(20);
		expect(results[0].published_at).toBe("2026-09-04");
	});
});
