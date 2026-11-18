ALTER TABLE conversations
  ADD COLUMN waiting_buyer_since timestamptz(6),
  ADD COLUMN assigned_offline_at timestamptz(6),
  ADD COLUMN auto_requeue_count integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD CONSTRAINT conversations_auto_requeue_count_check CHECK (auto_requeue_count BETWEEN 0 AND 3);
ALTER TABLE conversations ADD CONSTRAINT conversations_waiting_buyer_check CHECK (waiting_buyer_since IS NULL OR status = 'seller');
ALTER TABLE conversations ADD CONSTRAINT conversations_assigned_offline_check CHECK (assigned_offline_at IS NULL OR (status = 'seller' AND assigned_seller_id IS NOT NULL));
