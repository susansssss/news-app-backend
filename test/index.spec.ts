import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { extractJsonArray, normalizeUrl, storeArticles, toCandidate } from "../src/agent";
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
	it("requires the bearer token", async () => {
		expect((await SELF.fetch("https://worker.test/agent", { method: "POST" })).status).toBe(401);
		const wrong = await SELF.fetch("https://worker.test/agent", { method: "POST", headers: { Authorization: "Bearer nope" } });
		expect(wrong.status).toBe(401);
	});
});

describe("unknown routes", () => {
	it("returns 404 JSON with CORS headers", async () => {
		const res = await SELF.fetch("https://worker.test/nope");
		expect(res.status).toBe(404);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});

describe("Claude response parsing", () => {
	it("extracts the JSON array from concatenated text blocks with surrounding prose", () => {
		const blocks = ['Here are the results:\n```json\n[{"headline": "A", ', '"url": "https://x.test/a"}', "]\n```"];
		expect(extractJsonArray(blocks.join(""))).toEqual([{ headline: "A", url: "https://x.test/a" }]);
	});

	it("throws when no array is present", () => {
		expect(() => extractJsonArray("I could not find anything.")).toThrow();
	});

	it("normalizes URLs and rejects non-http ones", () => {
		expect(normalizeUrl(" https://x.test/a?utm_source=t&id=1#frag ")).toBe("https://x.test/a?id=1");
		expect(normalizeUrl("javascript:alert(1)")).toBeNull();
		expect(normalizeUrl("not a url")).toBeNull();
	});

	it("validates and clamps candidate articles", () => {
		const good = toCandidate({
			headline: " H ",
			source: "S",
			published_date: "2026-10-25T10:00:00Z",
			url: "https://x.test/a",
			summary: "Sum.",
			relevance_score: 14,
		});
		expect(good).toMatchObject({ headline: "H", published_at: "2026-10-25", relevance_score: 10 });
		expect(toCandidate({ headline: "H", source: "S", url: "https://x.test", summary: "", relevance_score: 5 })).toBeNull();
		expect(toCandidate("nope")).toBeNull();
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
