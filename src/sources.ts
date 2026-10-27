/** A candidate article pulled from a news feed or PubMed, before Claude ranks it. */
export interface FeedItem {
	headline: string;
	url: string;
	source: string;
	published_at: string | null; // YYYY-MM-DD
	snippet: string;
}

const USER_AGENT = 'news-app-backend/1.0 (+https://github.com/susansssss/news-app-backend)';
const NCBI = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

export function decodeEntities(text: string): string {
	return text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

function stripTags(text: string): string {
	return decodeEntities(text)
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function tag(block: string, name: string): string | null {
	const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
	return match ? match[1] : null;
}

export function toIsoDate(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const ms = Date.parse(raw.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3'));
	return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

/** Bing wraps the article URL in an apiclick.aspx redirect; the real URL is its `url` parameter. */
function unwrapBingLink(link: string): string {
	try {
		const url = new URL(link);
		if (url.hostname.endsWith('bing.com')) return url.searchParams.get('url') ?? link;
	} catch {}
	return link;
}

/** Parses RSS 2.0 `<item>`s from Bing News or Google News. */
export function parseNewsRss(xml: string): FeedItem[] {
	const items: FeedItem[] = [];
	for (const [, block] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const link = tag(block, 'link');
		let headline = stripTags(tag(block, 'title') ?? '');
		const source = stripTags(tag(block, 'News:Source') ?? tag(block, 'source') ?? '');
		if (!link || !headline) continue;
		// Google News appends " - Outlet" to every title.
		if (source && headline.endsWith(` - ${source}`)) headline = headline.slice(0, -(source.length + 3));
		items.push({
			headline,
			url: unwrapBingLink(decodeEntities(link.trim())),
			source: source || 'Unknown',
			published_at: toIsoDate(tag(block, 'pubDate')),
			snippet: stripTags(tag(block, 'description') ?? '').slice(0, 500),
		});
	}
	return items;
}

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, application/json' } });
	if (!res.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${res.status}`);
	return res.text();
}

/** Bing News for the past week, falling back to Google News when Bing returns nothing for the query. */
export async function searchNews(query: string): Promise<FeedItem[]> {
	const q = encodeURIComponent(query);
	const bing = parseNewsRss(await fetchText(`https://www.bing.com/news/search?q=${q}&format=rss&setmkt=en-US&qft=interval%3d%228%22`));
	if (bing.length) return bing;
	return parseNewsRss(await fetchText(`https://news.google.com/rss/search?q=${q}+when:7d&hl=en-US&gl=US&ceid=US:en`));
}

/** Papers added to PubMed in the past `days` days, with abstracts as snippets. */
export async function searchPubMed(term: string, days: number, max = 15): Promise<FeedItem[]> {
	const common = 'db=pubmed&tool=news-app-backend';
	const search = JSON.parse(
		await fetchText(`${NCBI}/esearch.fcgi?${common}&retmode=json&datetype=edat&reldate=${days}&retmax=${max}&sort=relevance&term=${encodeURIComponent(term)}`),
	) as { esearchresult?: { idlist?: string[] } };
	const ids = search.esearchresult?.idlist ?? [];
	if (!ids.length) return [];

	const xml = await fetchText(`${NCBI}/efetch.fcgi?${common}&retmode=xml&id=${ids.join(',')}`);
	const items: FeedItem[] = [];
	for (const [, article] of xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)) {
		const pmid = stripTags(tag(article, 'PMID') ?? '');
		const headline = stripTags(tag(article, 'ArticleTitle') ?? '');
		if (!pmid || !headline) continue;
		const entrez = /<PubMedPubDate PubStatus="(?:entrez|pubmed)">\s*<Year>(\d{4})<\/Year>\s*<Month>(\d{1,2})<\/Month>\s*<Day>(\d{1,2})<\/Day>/.exec(article);
		const abstract = [...article.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((m) => stripTags(m[1])).join(' ');
		items.push({
			headline,
			url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
			source: stripTags(tag(tag(article, 'Journal') ?? '', 'Title') ?? '') || 'PubMed',
			published_at: entrez ? toIsoDate(`${entrez[1]}-${entrez[2].padStart(2, '0')}-${entrez[3].padStart(2, '0')}`) : null,
			snippet: abstract.slice(0, 900),
		});
	}
	return items;
}
