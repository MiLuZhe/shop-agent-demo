-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "username" VARCHAR(50) NOT NULL,
    "display_name" VARCHAR(80) NOT NULL,
    "password_hash" TEXT,
    "role" VARCHAR(16) NOT NULL DEFAULT 'buyer',
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" VARCHAR(80) NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category_id" UUID,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "image_urls" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "product_id" UUID NOT NULL,
    "sku_code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "stock_quantity" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" VARCHAR(80) NOT NULL,
    "description" TEXT,
    "group_name" VARCHAR(40),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_tags" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "product_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "product_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_definitions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "data_type" VARCHAR(16) NOT NULL,
    "unit" VARCHAR(24),
    "options" JSONB,
    "is_filterable" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "attribute_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_attribute_values" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sku_id" UUID NOT NULL,
    "attribute_definition_id" UUID NOT NULL,
    "text_value" VARCHAR(255),
    "number_value" DECIMAL(18,4),
    "boolean_value" BOOLEAN,

    CONSTRAINT "sku_attribute_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buyer_id" UUID NOT NULL,
    "title" VARCHAR(120),
    "status" VARCHAR(24) NOT NULL DEFAULT 'agent',
    "assigned_seller_id" UUID,
    "requirement_state" JSONB NOT NULL DEFAULT '{}',
    "last_message_at" TIMESTAMPTZ(6),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversation_id" UUID NOT NULL,
    "sender_type" VARCHAR(16) NOT NULL,
    "sender_user_id" UUID,
    "content" TEXT NOT NULL,
    "product_cards" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiries" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversation_id" UUID NOT NULL,
    "trigger_message_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "assigned_seller_id" UUID,
    "resolution" TEXT,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "order_no" VARCHAR(40) NOT NULL,
    "buyer_id" UUID NOT NULL,
    "checkout_key" UUID NOT NULL,
    "checkout_payload_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'pending_payment',
    "total_amount" DECIMAL(12,2) NOT NULL,
    "recipient_name" VARCHAR(80) NOT NULL,
    "recipient_phone" VARCHAR(32) NOT NULL,
    "recipient_address" VARCHAR(500) NOT NULL,
    "payment_method" VARCHAR(16),
    "paid_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "shipped_at" TIMESTAMPTZ(6),
    "buyer_note" VARCHAR(500),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "order_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "product_name" VARCHAR(160) NOT NULL,
    "sku_name" VARCHAR(120) NOT NULL,
    "sku_code" VARCHAR(64) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE INDEX "products_category_id_status_idx" ON "products"("category_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "skus_sku_code_key" ON "skus"("sku_code");

-- CreateIndex
CREATE INDEX "skus_product_id_is_active_idx" ON "skus"("product_id", "is_active");

-- CreateIndex
CREATE INDEX "product_tags_tag_id_product_id_idx" ON "product_tags"("tag_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_tags_product_id_tag_id_key" ON "product_tags"("product_id", "tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definitions_code_key" ON "attribute_definitions"("code");

-- CreateIndex
CREATE INDEX "sku_attribute_values_attribute_definition_id_number_value_idx" ON "sku_attribute_values"("attribute_definition_id", "number_value");

-- CreateIndex
CREATE INDEX "sku_attribute_values_attribute_definition_id_text_value_idx" ON "sku_attribute_values"("attribute_definition_id", "text_value");

-- CreateIndex
CREATE UNIQUE INDEX "sku_attribute_values_sku_id_attribute_definition_id_key" ON "sku_attribute_values"("sku_id", "attribute_definition_id");

-- CreateIndex
CREATE INDEX "conversations_buyer_id_last_message_at_idx" ON "conversations"("buyer_id", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_status_last_message_at_idx" ON "conversations"("status", "last_message_at");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_id_idx" ON "messages"("conversation_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "inquiries_status_created_at_idx" ON "inquiries"("status", "created_at");

-- CreateIndex
CREATE INDEX "inquiries_assigned_seller_id_status_idx" ON "inquiries"("assigned_seller_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_user_id_sku_id_key" ON "cart_items"("user_id", "sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_no_key" ON "orders"("order_no");

-- CreateIndex
CREATE INDEX "orders_buyer_id_created_at_idx" ON "orders"("buyer_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_buyer_id_checkout_key_key" ON "orders"("buyer_id", "checkout_key");

-- CreateIndex
CREATE INDEX "order_items_sku_id_idx" ON "order_items"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_sku_id_key" ON "order_items"("order_id", "sku_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_tags" ADD CONSTRAINT "product_tags_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_tags" ADD CONSTRAINT "product_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_attribute_values" ADD CONSTRAINT "sku_attribute_values_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_attribute_values" ADD CONSTRAINT "sku_attribute_values_attribute_definition_id_fkey" FOREIGN KEY ("attribute_definition_id") REFERENCES "attribute_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_seller_id_fkey" FOREIGN KEY ("assigned_seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_trigger_message_id_fkey" FOREIGN KEY ("trigger_message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_assigned_seller_id_fkey" FOREIGN KEY ("assigned_seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma does not express CHECK constraints, expression indexes or this partial index.
-- These are part of the initial migration and must remain in future migrations.
ALTER TABLE users ADD CONSTRAINT users_identity_check CHECK (
  username = lower(btrim(username)) AND username ~ '[^[:space:]]'
  AND display_name ~ '[^[:space:]]' AND role IN ('buyer','seller') AND status IN ('active','disabled')
);
ALTER TABLE categories ADD CONSTRAINT categories_name_check CHECK (name = btrim(name) AND name ~ '[^[:space:]]');
ALTER TABLE products ADD CONSTRAINT products_content_check CHECK (
  name ~ '[^[:space:]]' AND status IN ('draft','active','inactive') AND jsonb_typeof(image_urls) = 'array'
);
ALTER TABLE skus ADD CONSTRAINT skus_values_check CHECK (
  name ~ '[^[:space:]]' AND sku_code ~ '[^[:space:]]' AND price >= 0 AND stock_quantity >= 0
);
ALTER TABLE tags ADD CONSTRAINT tags_name_check CHECK (name = btrim(name) AND name ~ '[^[:space:]]');
CREATE UNIQUE INDEX tags_name_lower_key ON tags (lower(name));
ALTER TABLE attribute_definitions ADD CONSTRAINT attribute_definitions_type_check CHECK ((
  code = lower(btrim(code)) AND code ~ '[^[:space:]]' AND name ~ '[^[:space:]]'
  AND data_type IN ('text','number','boolean','enum')
  AND (data_type = 'number' OR unit IS NULL)
  AND ((data_type = 'enum' AND options IS NOT NULL AND jsonb_typeof(options) = 'array' AND jsonb_array_length(options) > 0)
    OR (data_type <> 'enum' AND options IS NULL))
) IS TRUE);
ALTER TABLE sku_attribute_values ADD CONSTRAINT sku_attribute_values_one_value_check CHECK (
  num_nonnulls(text_value, number_value, boolean_value) = 1
);
ALTER TABLE conversations ADD CONSTRAINT conversations_state_check CHECK (
  status IN ('agent','waiting_seller','seller','closed')
  AND (status <> 'seller' OR assigned_seller_id IS NOT NULL)
  AND jsonb_typeof(requirement_state) = 'object'
);
ALTER TABLE messages ADD CONSTRAINT messages_sender_check CHECK (
  content ~ '[^[:space:]]' AND jsonb_typeof(product_cards) = 'array'
  AND ((sender_type IN ('buyer','seller') AND sender_user_id IS NOT NULL)
    OR (sender_type IN ('agent','system') AND sender_user_id IS NULL))
);
ALTER TABLE inquiries ADD CONSTRAINT inquiries_state_check CHECK ((
  question ~ '[^[:space:]]'
  AND reason IN ('user_request','missing_info','agent_failure','unresolved')
  AND status IN ('pending','processing','resolved')
  AND (status = 'pending' OR assigned_seller_id IS NOT NULL)
  AND ((status = 'resolved' AND resolution IS NOT NULL AND resolution ~ '[^[:space:]]' AND resolved_at IS NOT NULL)
    OR (status <> 'resolved' AND resolved_at IS NULL))
) IS TRUE);
CREATE UNIQUE INDEX inquiries_one_active_per_conversation ON inquiries (conversation_id)
  WHERE status IN ('pending','processing');
ALTER TABLE cart_items ADD CONSTRAINT cart_items_quantity_check CHECK (quantity > 0);
ALTER TABLE orders ADD CONSTRAINT orders_content_check CHECK (
  total_amount >= 0 AND recipient_name ~ '[^[:space:]]' AND recipient_phone ~ '[^[:space:]]'
  AND recipient_address ~ '[^[:space:]]' AND checkout_payload_hash ~ '^[0-9a-f]{64}$'
);
ALTER TABLE orders ADD CONSTRAINT orders_state_check CHECK ((
  (status = 'pending_payment' AND payment_method IS NULL AND paid_at IS NULL AND cancelled_at IS NULL AND shipped_at IS NULL)
  OR (status = 'pending_shipment' AND payment_method = 'mock' AND paid_at IS NOT NULL AND cancelled_at IS NULL AND shipped_at IS NULL)
  OR (status = 'shipped' AND payment_method = 'mock' AND paid_at IS NOT NULL AND cancelled_at IS NULL AND shipped_at IS NOT NULL)
  OR (status = 'cancelled' AND payment_method IS NULL AND paid_at IS NULL AND cancelled_at IS NOT NULL AND shipped_at IS NULL)
) IS TRUE);
ALTER TABLE order_items ADD CONSTRAINT order_items_values_check CHECK (
  quantity > 0 AND unit_price >= 0 AND product_name ~ '[^[:space:]]' AND sku_name ~ '[^[:space:]]' AND sku_code ~ '[^[:space:]]'
);
