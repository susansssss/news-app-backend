'use strict';

const API_BASE = 'https://news-app-backend.jiayins506.workers.dev';
// Running the pipeline needs the owner's password; it's sent as a Bearer token and never stored server-side here.
const PASSWORD_STORAGE_KEY = 'newsAgentPassword';

const els = {
	articles: document.getElementById('articles'),
	status: document.getElementById('status'),
	lastRefreshed: document.getElementById('last-refreshed'),
	refreshButton: document.getElementById('refresh-button'),
	resultCount: document.getElementById('result-count'),
	filters: document.getElementById('filters'),
	topic: document.getElementById('filter-topic'),
	score: document.getElementById('filter-score'),
	limit: document.getElementById('filter-limit'),
	forgetPassword: document.getElementById('forget-password'),
	passwordDialog: document.getElementById('password-dialog'),
	passwordForm: document.getElementById('password-form'),
	passwordInput: document.getElementById('password-input'),
	passwordRemember: document.getElementById('password-remember'),
	passwordError: document.getElementById('password-error'),
	passwordCancel: document.getElementById('password-cancel'),
};

/** Topic id -> display name, in the order topics are shown. */
let topicNames = new Map();
let lastRefreshedAt = null;

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	Object.assign(node, props);
	for (const child of children) if (child != null) node.append(child);
	return node;
}

function scoreClass(score) {
	if (score >= 9) return 'score-high';
	if (score >= 7) return 'score-good';
	if (score >= 5) return 'score-mid';
	return 'score-low';
}

function safeUrl(raw) {
	try {
		const url = new URL(raw);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
}

function relativeTime(iso) {
	const seconds = (Date.parse(iso) - Date.now()) / 1000;
	const units = [
		['day', 86400],
		['hour', 3600],
		['minute', 60],
	];
	for (const [unit, size] of units) {
		if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
	}
	return 'just now';
}

function renderLastRefreshed() {
	if (!lastRefreshedAt) {
		els.lastRefreshed.textContent = 'Last refreshed: not yet';
		els.lastRefreshed.title = '';
		return;
	}
	els.lastRefreshed.textContent = `Last refreshed: ${relativeTime(lastRefreshedAt)}`;
	els.lastRefreshed.title = dateTimeFormat.format(new Date(lastRefreshedAt));
}

function showStatus(message, kind = 'info') {
	els.status.textContent = message;
	els.status.className = `status${kind === 'info' ? '' : ` is-${kind}`}`;
	els.status.hidden = false;
}

function hideStatus() {
	els.status.hidden = true;
}

function renderCard(article) {
	const href = safeUrl(article.url);
	const title = href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', textContent: article.headline }) : article.headline;
	const date = article.published_at ? dateFormat.format(new Date(`${article.published_at}T00:00:00Z`)) : 'Date unknown';
	const badge = el('span', {
		className: `score ${scoreClass(article.relevance_score)}`,
		textContent: String(article.relevance_score),
		title: `Relevance ${article.relevance_score} out of 10`,
	});
	badge.setAttribute('aria-label', `Relevance ${article.relevance_score} out of 10`);

	return el(
		'article',
		{ className: 'card' },
		el('div', { className: 'card-top' }, el('h3', { className: 'card-title' }, title), badge),
		el('p', { className: 'card-meta' }, `${article.source} · `, el('time', { dateTime: article.published_at ?? '', textContent: date })),
		article.summary ? el('p', { className: 'card-summary', textContent: article.summary }) : null,
	);
}

function renderArticles(articles) {
	els.articles.replaceChildren();
	els.articles.setAttribute('aria-busy', 'false');
	els.resultCount.textContent = `Showing ${articles.length} article${articles.length === 1 ? '' : 's'}`;

	if (!articles.length) {
		els.articles.append(el('p', { className: 'placeholder', textContent: 'No articles match these filters.' }));
		return;
	}

	const groups = new Map();
	for (const article of articles) {
		if (!groups.has(article.topic)) groups.set(article.topic, []);
		groups.get(article.topic).push(article);
	}
	// Known topics in their configured order, then anything unexpected.
	const order = [...topicNames.keys(), ...[...groups.keys()].filter((t) => !topicNames.has(t))];
	for (const topic of order) {
		const items = groups.get(topic);
		if (!items) continue;
		const heading = el(
			'h2',
			{ className: 'topic-heading', id: `topic-${topic}` },
			topicNames.get(topic) ?? topic,
			el('span', { className: 'topic-count', textContent: `${items.length} article${items.length === 1 ? '' : 's'}` }),
		);
		const section = el('section', { className: 'topic-group' }, heading, el('div', { className: 'cards' }, ...items.map(renderCard)));
		section.setAttribute('aria-labelledby', heading.id);
		els.articles.append(section);
	}
}

function currentFilters() {
	const params = new URLSearchParams();
	for (const select of [els.topic, els.score, els.limit]) {
		if (select.value) params.set(select.name, select.value);
	}
	return params;
}

/** Restores filters from the page URL so filtered views can be bookmarked. */
function applyFiltersFromUrl() {
	const params = new URLSearchParams(location.search);
	for (const select of [els.topic, els.score, els.limit]) {
		const value = params.get(select.name);
		if (value !== null && [...select.options].some((o) => o.value === value)) select.value = value;
	}
}

async function getJson(url, options) {
	const res = await fetch(url, options);
	let body = null;
	try {
		body = await res.json();
	} catch {}
	if (!res.ok) {
		const error = new Error(body?.error ?? `Request failed (HTTP ${res.status})`);
		error.status = res.status;
		error.body = body;
		throw error;
	}
	return body;
}

async function loadTopics() {
	const { topics } = await getJson(`${API_BASE}/topics`);
	topicNames = new Map(topics.map((t) => [t.id, t.name]));
	for (const t of topics) els.topic.append(el('option', { value: t.id, textContent: t.name }));
}

async function loadArticles() {
	const params = currentFilters();
	history.replaceState(null, '', params.toString() ? `?${params}` : location.pathname);
	els.articles.setAttribute('aria-busy', 'true');
	try {
		const data = await getJson(`${API_BASE}/articles?${params}`);
		lastRefreshedAt = data.last_refreshed;
		renderLastRefreshed();
		renderArticles(data.articles);
	} catch (err) {
		els.articles.setAttribute('aria-busy', 'false');
		els.articles.replaceChildren(el('p', { className: 'placeholder', textContent: `Could not load articles: ${err.message}` }));
		els.resultCount.textContent = '';
	}
}

function setRefreshing(isRefreshing) {
	els.refreshButton.disabled = isRefreshing;
	els.refreshButton.classList.toggle('is-loading', isRefreshing);
	els.refreshButton.querySelector('.button-label').textContent = isRefreshing ? 'Refreshing…' : 'Refresh';
}

/** Password for this tab when the owner chose not to remember it on the device. */
let sessionPassword = null;

function savedPassword() {
	return sessionPassword ?? localStorage.getItem(PASSWORD_STORAGE_KEY);
}

function rememberPassword(password, persist) {
	sessionPassword = password;
	if (persist) localStorage.setItem(PASSWORD_STORAGE_KEY, password);
	updateForgetLink();
}

function forgetPassword() {
	sessionPassword = null;
	localStorage.removeItem(PASSWORD_STORAGE_KEY);
	updateForgetLink();
}

function updateForgetLink() {
	els.forgetPassword.hidden = !localStorage.getItem(PASSWORD_STORAGE_KEY);
}

/** Opens the password dialog; resolves to { password, remember } or null if cancelled. */
function askForPassword(errorMessage) {
	els.passwordError.textContent = errorMessage ?? '';
	els.passwordError.hidden = !errorMessage;
	els.passwordInput.value = '';
	els.passwordDialog.returnValue = ''; // Esc closes without changing it, so clear the previous submit
	els.passwordDialog.showModal();
	els.passwordInput.focus();
	return new Promise((resolve) => {
		els.passwordDialog.addEventListener(
			'close',
			() => {
				const password = els.passwordInput.value;
				els.passwordInput.value = '';
				resolve(els.passwordDialog.returnValue === 'submit' && password ? { password, remember: els.passwordRemember.checked } : null);
			},
			{ once: true },
		);
	});
}

async function runAgent(password) {
	setRefreshing(true);
	showStatus('Gathering the latest news and asking Claude to pick the top stories. This usually takes 10–30 seconds…');
	try {
		return await getJson(`${API_BASE}/agent`, { method: 'POST', headers: { Authorization: `Bearer ${password}` } });
	} finally {
		setRefreshing(false);
	}
}

async function refresh() {
	let password = savedPassword();
	let remember = Boolean(localStorage.getItem(PASSWORD_STORAGE_KEY));
	let promptError = null;
	try {
		for (;;) {
			if (!password) {
				const answer = await askForPassword(promptError);
				if (!answer) return;
				({ password, remember } = answer);
			}
			try {
				const result = await runAgent(password);
				rememberPassword(password, remember);
				const failed = result.topics.filter((t) => t.error);
				const summary = `Refresh complete: ${result.inserted} new article${result.inserted === 1 ? '' : 's'} added, ${result.skipped} already in the feed.`;
				showStatus(failed.length ? `${summary} ${failed.length} topic(s) could not be updated.` : summary, failed.length ? 'error' : 'ok');
				await loadArticles();
				return;
			} catch (err) {
				if (err.status !== 401) throw err;
				hideStatus();
				forgetPassword();
				password = null;
				promptError = 'That password was not accepted. Please try again.';
			}
		}
	} catch (err) {
		if (err.status === 429) {
			rememberPassword(password, remember); // the password was accepted; only the cooldown blocked the run
			const minutes = Math.ceil((err.body?.retry_after_seconds ?? 60) / 60);
			showStatus(`The feed was refreshed moments ago. Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`, 'error');
		} else {
			showStatus(`Refresh failed: ${err.message}`, 'error');
		}
	}
}

async function init() {
	try {
		await loadTopics();
	} catch (err) {
		showStatus(`Could not load topics: ${err.message}`, 'error');
	}
	applyFiltersFromUrl();
	els.filters.addEventListener('change', () => {
		hideStatus();
		loadArticles();
	});
	els.filters.addEventListener('submit', (event) => event.preventDefault());
	els.refreshButton.addEventListener('click', refresh);
	els.passwordCancel.addEventListener('click', () => els.passwordDialog.close('cancel'));
	els.forgetPassword.addEventListener('click', () => {
		forgetPassword();
		showStatus('Saved password removed from this device.', 'ok');
	});
	updateForgetLink();
	setInterval(renderLastRefreshed, 60_000);
	await loadArticles();
}

init();
