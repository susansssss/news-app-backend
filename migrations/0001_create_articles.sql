-- News articles collected per topic, summarised and scored by the AI pipeline.
CREATE TABLE articles (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	topic           TEXT    NOT NULL,
	headline        TEXT    NOT NULL,
	source          TEXT    NOT NULL,
	published_at    TEXT,                                   -- ISO-8601; NULL if the feed gives no date
	url             TEXT    NOT NULL UNIQUE,
	summary         TEXT,                                   -- NULL until summarised
	relevance_score INTEGER CHECK (relevance_score BETWEEN 1 AND 10),
	fetched_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_articles_topic_published ON articles (topic, published_at DESC);
CREATE INDEX idx_articles_fetched ON articles (fetched_at DESC);
