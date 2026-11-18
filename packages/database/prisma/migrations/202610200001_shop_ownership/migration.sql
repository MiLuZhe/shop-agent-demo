-- Preserve all existing business rows and their timestamps. No application-facing
-- default on shop_id: every new write must explicitly choose its owning shop.
BEGIN;
CREATE TABLE shops (
  id uuid NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  slug varchar(64) NOT NULL, name varchar(80) NOT NULL, status varchar(16) NOT NULL DEFAULT 'active',
  CONSTRAINT shops_pkey PRIMARY KEY (id),
  CONSTRAINT shops_content_check CHECK (slug = lower(btrim(slug)) AND slug ~ '^[a-z][a-z0-9_-]*$' AND name ~ '[^[:space:]]' AND status IN ('active','disabled'))
);
CREATE UNIQUE INDEX shops_slug_key ON shops(slug);
CREATE TABLE shop_members (
  id uuid NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  shop_id uuid NOT NULL, user_id uuid NOT NULL,
  role varchar(16) NOT NULL DEFAULT 'manager', status varchar(16) NOT NULL DEFAULT 'active',
  CONSTRAINT shop_members_pkey PRIMARY KEY(id),
  CONSTRAINT shop_members_content_check CHECK (role IN ('owner','manager') AND status IN ('active','disabled')),
  CONSTRAINT shop_members_shop_id_fkey FOREIGN KEY(shop_id) REFERENCES shops(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT shop_members_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX shop_members_shop_id_user_id_key ON shop_members(shop_id,user_id);
CREATE INDEX shop_members_user_id_status_idx ON shop_members(user_id,status);
INSERT INTO shops(id,slug,name) VALUES ('00000000-0000-4000-8000-000000000003','shiwu','拾物');
INSERT INTO shop_members(id,shop_id,user_id,role)
 SELECT gen_random_uuid(),'00000000-0000-4000-8000-000000000003',id,CASE WHEN username='seller_demo' THEN 'owner' ELSE 'manager' END FROM users WHERE role='seller';
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['categories','products','tags','attribute_definitions','conversations','orders'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN shop_id uuid',tab);
  EXECUTE format('UPDATE %I SET shop_id = %L::uuid',tab,'00000000-0000-4000-8000-000000000003');
  EXECUTE format('ALTER TABLE %I ALTER COLUMN shop_id SET NOT NULL',tab);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(shop_id) REFERENCES shops(id) ON DELETE RESTRICT ON UPDATE CASCADE',tab,tab||'_shop_id_fkey');
 END LOOP;
END $$;
ALTER TABLE orders ADD COLUMN shop_name varchar(80);
UPDATE orders SET shop_name = '拾物';
ALTER TABLE orders ALTER COLUMN shop_name SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_shop_name_check CHECK (shop_name ~ '[^[:space:]]');
DROP INDEX categories_name_key;
CREATE UNIQUE INDEX categories_shop_id_name_key ON categories(shop_id,name);
DROP INDEX attribute_definitions_code_key;
CREATE UNIQUE INDEX attribute_definitions_shop_id_code_key ON attribute_definitions(shop_id,code);
DROP INDEX tags_name_lower_key;
CREATE UNIQUE INDEX tags_name_lower_key ON tags(shop_id,lower(name));
CREATE INDEX categories_shop_id_idx ON categories(shop_id);
CREATE INDEX products_shop_id_status_idx ON products(shop_id,status);
CREATE INDEX tags_shop_id_idx ON tags(shop_id);
CREATE INDEX attribute_definitions_shop_id_idx ON attribute_definitions(shop_id);
CREATE INDEX conversations_shop_id_idx ON conversations(shop_id);
CREATE INDEX orders_shop_id_status_created_at_idx ON orders(shop_id,status,created_at);

-- Ownership is stable. Moving an existing product/SKU or order would invalidate
-- historical references and must use a separately designed migration, not UPDATE.
CREATE FUNCTION enforce_stable_shop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.shop_id IS DISTINCT FROM OLD.shop_id THEN
  RAISE EXCEPTION 'shop ownership cannot be reassigned' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['categories','products','tags','attribute_definitions','conversations','orders'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF shop_id ON %I FOR EACH ROW EXECUTE FUNCTION enforce_stable_shop()',tab||'_stable_shop',tab);
 END LOOP;
END $$;
CREATE FUNCTION enforce_stable_sku_product() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN RAISE EXCEPTION 'SKU product cannot be reassigned' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER skus_stable_product BEFORE UPDATE OF product_id ON skus FOR EACH ROW EXECUTE FUNCTION enforce_stable_sku_product();

-- Cross-table ownership constraints remain in SQL because Prisma cannot express
-- these joins. Stable parent ownership prevents write skew between the checks.
CREATE FUNCTION enforce_shop_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shop_a uuid; shop_b uuid; conversation_ref uuid;
BEGIN
 IF TG_TABLE_NAME='products' THEN
  IF NEW.category_id IS NULL THEN RETURN NEW; END IF;
  shop_a := NEW.shop_id;
  SELECT shop_id INTO shop_b FROM categories WHERE id=NEW.category_id;
 ELSIF TG_TABLE_NAME='product_tags' THEN
  SELECT shop_id INTO shop_a FROM products WHERE id=NEW.product_id;
  SELECT shop_id INTO shop_b FROM tags WHERE id=NEW.tag_id;
 ELSIF TG_TABLE_NAME='sku_attribute_values' THEN
  SELECT p.shop_id INTO shop_a FROM skus s JOIN products p ON p.id=s.product_id WHERE s.id=NEW.sku_id;
  SELECT shop_id INTO shop_b FROM attribute_definitions WHERE id=NEW.attribute_definition_id;
 ELSIF TG_TABLE_NAME='order_items' THEN
  SELECT shop_id INTO shop_a FROM orders WHERE id=NEW.order_id;
  SELECT p.shop_id INTO shop_b FROM skus s JOIN products p ON p.id=s.product_id WHERE s.id=NEW.sku_id;
 ELSIF TG_TABLE_NAME='conversations' THEN
  IF NEW.assigned_seller_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM shop_members WHERE shop_id=NEW.shop_id AND user_id=NEW.assigned_seller_id) THEN
   RAISE EXCEPTION 'seller is not a member of the conversation shop' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='inquiries' THEN
  SELECT shop_id INTO shop_a FROM conversations WHERE id=NEW.conversation_id;
  SELECT conversation_id INTO conversation_ref FROM messages WHERE id=NEW.trigger_message_id;
  IF conversation_ref IS DISTINCT FROM NEW.conversation_id THEN RAISE EXCEPTION 'inquiry message must belong to its conversation' USING ERRCODE='23514'; END IF;
  IF NEW.assigned_seller_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shop_members WHERE shop_id=shop_a AND user_id=NEW.assigned_seller_id) THEN
   RAISE EXCEPTION 'inquiry seller is not a shop member' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='messages' THEN
  IF NEW.sender_type<>'seller' THEN RETURN NEW; END IF;
  SELECT shop_id INTO shop_a FROM conversations WHERE id=NEW.conversation_id;
  IF NOT EXISTS(SELECT 1 FROM shop_members WHERE shop_id=shop_a AND user_id=NEW.sender_user_id) THEN
   RAISE EXCEPTION 'message seller is not a shop member' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF shop_a IS NULL OR shop_b IS NULL OR shop_a<>shop_b THEN RAISE EXCEPTION 'cross-shop reference is not allowed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['products','product_tags','sku_attribute_values','order_items','conversations','inquiries','messages'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_shop_reference()',tab||'_shop_reference',tab);
 END LOOP;
END $$;
COMMIT;
