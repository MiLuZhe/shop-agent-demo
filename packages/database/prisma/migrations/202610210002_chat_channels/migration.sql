BEGIN;
-- Never silently close competing legacy rounds or drop their messages.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM conversations WHERE status <> 'closed' GROUP BY shop_id,buyer_id HAVING count(*) > 1) THEN
  RAISE EXCEPTION 'Multiple active legacy conversations for the same shop and buyer; reconcile explicitly before migration';
 END IF;
END $$;
CREATE TABLE chat_channels (
 id uuid NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 shop_id uuid NOT NULL, buyer_id uuid NOT NULL, last_message_at timestamptz(6), next_sequence integer NOT NULL DEFAULT 0,
 CONSTRAINT chat_channels_pkey PRIMARY KEY(id),
 CONSTRAINT chat_channels_shop_id_fkey FOREIGN KEY(shop_id) REFERENCES shops(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT chat_channels_buyer_id_fkey FOREIGN KEY(buyer_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT chat_channels_sequence_check CHECK(next_sequence >= 0)
);
CREATE UNIQUE INDEX chat_channels_shop_id_buyer_id_key ON chat_channels(shop_id,buyer_id);
CREATE UNIQUE INDEX chat_channels_id_shop_id_buyer_id_key ON chat_channels(id,shop_id,buyer_id);
CREATE INDEX chat_channels_buyer_id_last_message_at_idx ON chat_channels(buyer_id,last_message_at);
CREATE INDEX chat_channels_shop_id_last_message_at_idx ON chat_channels(shop_id,last_message_at);
INSERT INTO chat_channels(id,shop_id,buyer_id,created_at,updated_at,last_message_at)
 SELECT gen_random_uuid(),shop_id,buyer_id,min(created_at),max(updated_at),max(last_message_at) FROM conversations GROUP BY shop_id,buyer_id;
ALTER TABLE conversations ADD COLUMN channel_id uuid, ADD COLUMN ended_at timestamptz(6);
UPDATE conversations c SET channel_id=h.id, ended_at=CASE WHEN c.status='closed' THEN c.updated_at ELSE NULL END
 FROM chat_channels h WHERE h.shop_id=c.shop_id AND h.buyer_id=c.buyer_id;
ALTER TABLE conversations ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_id_shop_id_buyer_id_fkey
 FOREIGN KEY(channel_id,shop_id,buyer_id) REFERENCES chat_channels(id,shop_id,buyer_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE conversations ADD CONSTRAINT conversations_ended_check CHECK((status='closed') = (ended_at IS NOT NULL));
CREATE UNIQUE INDEX conversations_id_channel_id_key ON conversations(id,channel_id);
CREATE UNIQUE INDEX conversations_one_active_per_channel ON conversations(channel_id) WHERE status<>'closed';
CREATE INDEX conversations_channel_id_created_at_id_idx ON conversations(channel_id,created_at,id);
ALTER TABLE messages ADD COLUMN channel_id uuid, ADD COLUMN sequence integer, ADD COLUMN client_message_id uuid, ADD COLUMN event_data jsonb;
WITH numbered AS (
 SELECT m.id,c.channel_id,row_number() OVER (PARTITION BY c.channel_id ORDER BY m.created_at,m.id)::integer AS seq
 FROM messages m JOIN conversations c ON c.id=m.conversation_id
) UPDATE messages m SET channel_id=n.channel_id, sequence=n.seq FROM numbered n WHERE n.id=m.id;
UPDATE chat_channels h SET next_sequence=(SELECT COALESCE(max(sequence),0) FROM messages WHERE channel_id=h.id);
ALTER TABLE messages ALTER COLUMN channel_id SET NOT NULL, ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE messages DROP CONSTRAINT messages_conversation_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_conversation_id_channel_id_fkey FOREIGN KEY(conversation_id,channel_id) REFERENCES conversations(id,channel_id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE messages ADD CONSTRAINT messages_channel_id_fkey FOREIGN KEY(channel_id) REFERENCES chat_channels(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE messages ADD CONSTRAINT messages_sequence_check CHECK(sequence>0);
ALTER TABLE messages ADD CONSTRAINT messages_client_id_check CHECK(client_message_id IS NULL OR sender_type IN ('buyer','seller'));
ALTER TABLE messages ADD CONSTRAINT messages_event_check CHECK(event_data IS NULL OR (sender_type='system' AND jsonb_typeof(event_data)='object'));
CREATE UNIQUE INDEX messages_channel_id_sequence_key ON messages(channel_id,sequence);
CREATE UNIQUE INDEX messages_client_dedup_key ON messages(channel_id,sender_user_id,sender_type,client_message_id);
-- An established channel/round/message cannot move into another buyer's history.
CREATE FUNCTION enforce_chat_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='chat_channels' THEN
  IF NEW.shop_id<>OLD.shop_id OR NEW.buyer_id<>OLD.buyer_id THEN
   RAISE EXCEPTION 'chat channel ownership is immutable' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='conversations' THEN
  IF NEW.channel_id<>OLD.channel_id OR NEW.buyer_id<>OLD.buyer_id THEN
   RAISE EXCEPTION 'conversation channel and buyer are immutable' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='messages' THEN
  RAISE EXCEPTION 'chat messages are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER chat_channels_stable_identity BEFORE UPDATE ON chat_channels FOR EACH ROW EXECUTE FUNCTION enforce_chat_identity();
CREATE TRIGGER conversations_stable_identity BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION enforce_chat_identity();
CREATE TRIGGER messages_stable_identity BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION enforce_chat_identity();
CREATE FUNCTION enforce_chat_buyer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.sender_type='buyer' AND NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND buyer_id=NEW.sender_user_id) THEN
  RAISE EXCEPTION 'message buyer must own the conversation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER messages_buyer_reference BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION enforce_chat_buyer();
COMMIT;
