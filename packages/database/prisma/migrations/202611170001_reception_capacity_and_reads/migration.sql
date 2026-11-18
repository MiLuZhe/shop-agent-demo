ALTER TABLE shops ADD COLUMN chat_capacity integer NOT NULL DEFAULT 3;
ALTER TABLE shops ADD CONSTRAINT shops_chat_capacity_check CHECK (chat_capacity BETWEEN 1 AND 10);

CREATE TABLE chat_read_states (
    channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_sequence integer NOT NULL DEFAULT 0 CHECK (read_sequence >= 0),
    updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX chat_read_states_user_id_idx ON chat_read_states(user_id);
