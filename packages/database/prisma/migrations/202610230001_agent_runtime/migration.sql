BEGIN;
ALTER TABLE conversations
 ADD COLUMN agent_generation integer NOT NULL DEFAULT 0,
 ADD COLUMN agent_trigger_sequence integer NOT NULL DEFAULT 0,
 ADD COLUMN agent_covered_sequence integer NOT NULL DEFAULT 0,
 ADD COLUMN agent_run_id uuid,
 ADD COLUMN agent_run_status varchar(16) NOT NULL DEFAULT 'idle',
 ADD COLUMN agent_deadline timestamptz(6);
ALTER TABLE conversations ADD CONSTRAINT conversations_agent_runtime_check CHECK (
 agent_generation >= 0 AND agent_trigger_sequence >= agent_covered_sequence AND agent_covered_sequence >= 0
 AND agent_run_status IN ('idle','queued','running','completed','failed','cancelled')
 AND (agent_run_status NOT IN ('queued','running') OR (status='agent' AND agent_run_id IS NOT NULL AND agent_deadline IS NOT NULL))
);
CREATE INDEX conversations_agent_run_status_agent_deadline_idx ON conversations(agent_run_status,agent_deadline);
COMMIT;
