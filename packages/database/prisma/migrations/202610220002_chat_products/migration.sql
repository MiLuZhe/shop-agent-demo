BEGIN;
ALTER TABLE messages ADD COLUMN product_context jsonb;
ALTER TABLE messages ADD CONSTRAINT messages_product_context_check CHECK (
 product_context IS NULL OR (sender_type='buyer' AND jsonb_typeof(product_context)='object')
);
COMMIT;
