CREATE TABLE "saved_addresses" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "slot" SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 3),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recipient_name" VARCHAR(80) NOT NULL CHECK (length(btrim(recipient_name)) > 0),
  "recipient_phone" VARCHAR(32) NOT NULL CHECK (recipient_phone ~ '^\+?[0-9][0-9 ()-]*[0-9]$' AND length(regexp_replace(recipient_phone, '[^0-9]', '', 'g')) BETWEEN 7 AND 15),
  "recipient_address" VARCHAR(500) NOT NULL CHECK (length(btrim(recipient_address)) >= 5),
  CONSTRAINT "saved_addresses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "saved_addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "saved_addresses_user_id_slot_key" ON "saved_addresses"("user_id", "slot");
