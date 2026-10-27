'use strict';

// Floating "Ask the news" chat. Uses API_BASE, el(), getJson(), safeUrl() and the password helpers from app.js.

const chatEls = {
	launcher: document.getElementById('chat-launcher'),
	panel: document.getElementById('chat-panel'),
	close: document.getElementById('chat-close'),
	model: document.getElementById('chat-model'),
	log: document.getElementById('chat-log'),
	welcome: document.getElementById('chat-welcome'),
	form: document.getElementById('chat-form'),
	input: document.getElementById('chat-input'),
	send: document.getElementById('chat-send'),
};

const MODEL_LABELS = { haiku: 'Claude Haiku 4.5', opus: 'Claude Opus 5.5', sonnet: 'Claude Sonnet 5' };
const MODEL_STORAGE_KEY = 'newsChatModel';
const numberFormat = new Intl.NumberFormat();
let chatBusy = false;

function setChatOpen(open) {
	chatEls.panel.hidden = !open;
	chatEls.launcher.setAttribute('aria-expanded', String(open));
	chatEls.launcher.classList.toggle('is-open', open);
	if (open) chatEls.input.focus();
	else chatEls.launcher.focus();
}

function scrollChatToEnd() {
	chatEls.log.scrollTop = chatEls.log.scrollHeight;
}

/** Inline Markdown: **bold**, *italic*, `code`, and [n] citations linked to the answer's sources. */
function renderInline(text, sources) {
	const nodes = [];
	const pattern = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[\d+\])/g;
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		if (match.index > last) nodes.push(text.slice(last, match.index));
		const token = match[0];
		if (token.startsWith('**')) nodes.push(el('strong', { textContent: token.slice(2, -2) }));
		else if (token.startsWith('`')) nodes.push(el('code', { textContent: token.slice(1, -1) }));
		else if (token.startsWith('*')) nodes.push(el('em', { textContent: token.slice(1, -1) }));
		else {
			const source = sources.find((s) => s.ref === Number(token.slice(1, -1)));
			const href = source && safeUrl(source.url);
			nodes.push(
				href
					? el('a', { className: 'chat-cite', href, target: '_blank', rel: 'noopener noreferrer', textContent: token, title: `${source.headline} (${source.source})` })
					: token,
			);
		}
		last = match.index + token.length;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

/** Block Markdown: paragraphs, headings, and bulleted/numbered lists (one level of nesting). */
function renderMarkdown(markdown, sources) {
	const root = document.createDocumentFragment();
	let list = null;
	let nested = null;
	let paragraph = [];

	const flushParagraph = () => {
		if (paragraph.length) root.append(el('p', {}, ...renderInline(paragraph.join(' '), sources)));
		paragraph = [];
	};
	const closeLists = () => {
		list = null;
		nested = null;
	};

	for (const rawLine of markdown.split('\n')) {
		const line = rawLine.replace(/\s+$/, '');
		const item = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		if (!line.trim()) {
			flushParagraph();
			closeLists();
		} else if (item) {
			flushParagraph();
			const [, indent, marker, content] = item;
			const ordered = /\d/.test(marker);
			const li = el('li', {}, ...renderInline(content, sources));
			if (indent.length >= 2 && list) {
				if (!nested) {
					nested = el(ordered ? 'ol' : 'ul');
					(list.lastElementChild ?? list).append(nested);
				}
				nested.append(li);
			} else {
				if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) {
					list = el(ordered ? 'ol' : 'ul');
					root.append(list);
				}
				nested = null;
				list.append(li);
			}
		} else if (heading) {
			flushParagraph();
			closeLists();
			root.append(el('p', { className: 'chat-heading' }, ...renderInline(heading[1], sources)));
		} else {
			closeLists();
			paragraph.push(line.trim());
		}
	}
	flushParagraph();
	return root;
}

function addMessage(role, ...children) {
	chatEls.welcome.hidden = true;
	const message = el('div', { className: `chat-message chat-${role}` }, ...children);
	chatEls.log.append(message);
	scrollChatToEnd();
	return message;
}

function renderSources(answer, sources) {
	const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
	const used = sources.filter((s) => cited.has(s.ref));
	if (!used.length) return null;
	const items = used.map((s) => {
		const href = safeUrl(s.url);
		const label = `${s.headline}`;
		return el(
			'li',
			{},
			`[${s.ref}] `,
			href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', textContent: label }) : label,
			el('span', { className: 'chat-source-meta', textContent: ` · ${s.source}${s.published_at ? `, ${s.published_at}` : ''}` }),
		);
	});
	const details = el('details', { className: 'chat-sources' }, el('summary', { textContent: `Sources (${used.length})` }), el('ol', {}, ...items));
	return details;
}

function usageLine(result, seconds) {
	const label = MODEL_LABELS[result.model] ?? result.model_id;
	const { input_tokens: input, output_tokens: output } = result.usage;
	const text = `${label} · ${numberFormat.format(input)} in / ${numberFormat.format(output)} out tokens · ${seconds.toFixed(1)}s`;
	return el('p', { className: 'chat-usage', textContent: result.truncated ? `${text} · answer was cut short` : text });
}

function setChatBusy(busy) {
	chatBusy = busy;
	chatEls.send.disabled = busy;
	chatEls.send.textContent = busy ? 'Sending…' : 'Send';
	chatEls.input.disabled = busy;
}

/** Asks for the password when needed, retrying once per wrong entry; resolves to the result or null if cancelled. */
async function askWithPassword(question, model) {
	let password = savedPassword();
	let remember = Boolean(localStorage.getItem(PASSWORD_STORAGE_KEY));
	let promptError = null;
	for (;;) {
		if (!password) {
			const answer = await askForPassword(promptError);
			if (!answer) return null;
			({ password, remember } = answer);
		}
		try {
			const result = await getJson(`${API_BASE}/chat`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ question, model }),
			});
			rememberPassword(password, remember);
			return result;
		} catch (err) {
			if (err.status !== 401) throw err;
			forgetPassword();
			password = null;
			promptError = 'That password was not accepted. Please try again.';
		}
	}
}

async function sendQuestion(question) {
	question = question.trim();
	if (!question || chatBusy) return;
	const model = chatEls.model.value;
	addMessage('user', el('p', { textContent: question }));
	chatEls.input.value = '';
	resizeInput();
	setChatBusy(true);
	const thinking = addMessage('assistant', el('p', { className: 'chat-typing', textContent: `${MODEL_LABELS[model]} is reading the articles…` }));
	const started = performance.now();
	try {
		const result = await askWithPassword(question, model);
		thinking.remove();
		if (!result) {
			addMessage('notice', el('p', { textContent: 'Chat needs the password. Your question was not sent.' }));
			return;
		}
		const seconds = (performance.now() - started) / 1000;
		addMessage('assistant', renderMarkdown(result.answer, result.sources), renderSources(result.answer, result.sources), usageLine(result, seconds));
	} catch (err) {
		thinking.remove();
		addMessage('error', el('p', { textContent: `Sorry, that didn't work: ${err.message}` }));
	} finally {
		setChatBusy(false);
		chatEls.input.focus();
	}
}

function resizeInput() {
	chatEls.input.style.height = 'auto';
	chatEls.input.style.height = `${Math.min(chatEls.input.scrollHeight, 120)}px`;
}

function initChat() {
	const savedModel = localStorage.getItem(MODEL_STORAGE_KEY);
	if (savedModel && [...chatEls.model.options].some((o) => o.value === savedModel)) chatEls.model.value = savedModel;
	chatEls.model.addEventListener('change', () => localStorage.setItem(MODEL_STORAGE_KEY, chatEls.model.value));

	chatEls.launcher.addEventListener('click', () => setChatOpen(chatEls.panel.hidden));
	chatEls.close.addEventListener('click', () => setChatOpen(false));
	chatEls.panel.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && !document.getElementById('password-dialog').open) setChatOpen(false);
	});
	chatEls.form.addEventListener('submit', (event) => {
		event.preventDefault();
		sendQuestion(chatEls.input.value);
	});
	chatEls.input.addEventListener('keydown', (event) => {
		// Enter sends; Shift+Enter adds a new line.
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			chatEls.form.requestSubmit();
		}
	});
	chatEls.input.addEventListener('input', resizeInput);
	for (const button of document.querySelectorAll('.chat-suggestion')) {
		button.addEventListener('click', () => sendQuestion(button.textContent));
	}
}

initChat();
