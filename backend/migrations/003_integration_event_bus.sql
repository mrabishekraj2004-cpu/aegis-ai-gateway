CREATE TABLE integration_events (
  event_key TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX integration_events_published_idx ON integration_events(published_at,event_key);

CREATE TABLE integration_event_deliveries (
  consumer_name TEXT NOT NULL,
  event_key TEXT NOT NULL REFERENCES integration_events(event_key) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','in_progress','retry','processed','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  PRIMARY KEY (consumer_name,event_key)
);
CREATE INDEX integration_delivery_due_idx ON integration_event_deliveries(consumer_name,available_at,event_key)
  WHERE state IN ('pending','retry','in_progress');
