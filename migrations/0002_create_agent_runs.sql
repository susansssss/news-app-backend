-- One row per pipeline run; drives the dashboard's "last refreshed" time and the /agent cooldown.
CREATE TABLE agent_runs (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	trigger        TEXT    NOT NULL CHECK (trigger IN ('http', 'cron')),
	started_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	finished_at    TEXT,
	inserted       INTEGER,
	skipped        INTEGER,
	total_returned INTEGER,
	errors         TEXT                                    -- JSON array of per-topic errors; NULL if none
);

CREATE INDEX idx_agent_runs_started ON agent_runs (started_at DESC);
