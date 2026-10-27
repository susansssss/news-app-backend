-- Full-text index over articles for /chat retrieval. External-content table: rows live in `articles`,
-- and the triggers below keep the index in step with inserts, cap deletions and updates.
CREATE VIRTUAL TABLE articles_fts USING fts5(
	headline,
	summary,
	source,
	content = 'articles',
	content_rowid = 'id',
	tokenize = 'porter unicode61'
);

CREATE TRIGGER articles_fts_insert AFTER INSERT ON articles BEGIN
	INSERT INTO articles_fts (rowid, headline, summary, source) VALUES (new.id, new.headline, new.summary, new.source);
END;

CREATE TRIGGER articles_fts_delete AFTER DELETE ON articles BEGIN
	INSERT INTO articles_fts (articles_fts, rowid, headline, summary, source) VALUES ('delete', old.id, old.headline, old.summary, old.source);
END;

CREATE TRIGGER articles_fts_update AFTER UPDATE ON articles BEGIN
	INSERT INTO articles_fts (articles_fts, rowid, headline, summary, source) VALUES ('delete', old.id, old.headline, old.summary, old.source);
	INSERT INTO articles_fts (rowid, headline, summary, source) VALUES (new.id, new.headline, new.summary, new.source);
END;

-- Index the articles that already exist.
INSERT INTO articles_fts (articles_fts) VALUES ('rebuild');
