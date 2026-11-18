BEGIN;
ALTER TABLE users ADD COLUMN account_kind varchar(16) NOT NULL DEFAULT 'customer';
ALTER TABLE users ADD CONSTRAINT users_account_kind_check CHECK (account_kind IN ('customer', 'work'));
-- Preserve every pre-existing value and business record; classify all historical
-- members, including disabled memberships, as dedicated work accounts.
UPDATE users SET account_kind='work'
WHERE platform_role='admin' OR EXISTS (SELECT 1 FROM shop_members WHERE user_id=users.id);

CREATE FUNCTION preserve_work_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND OLD.account_kind='work' AND NEW.account_kind<>'work' THEN
  RAISE EXCEPTION 'work account cannot become a customer account' USING ERRCODE='23514';
 END IF;
 IF NEW.platform_role='admin' THEN NEW.account_kind := 'work'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER users_work_account BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION preserve_work_account();

-- Trusted database provisioning/seed code may attach a new member directly.
-- Public member APIs only accept already dedicated work accounts.
CREATE FUNCTION classify_shop_work_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE users SET account_kind='work' WHERE id=NEW.user_id AND account_kind<>'work';
 RETURN NEW;
END $$;
CREATE TRIGGER shop_members_work_account BEFORE INSERT OR UPDATE OF user_id ON shop_members
FOR EACH ROW EXECUTE FUNCTION classify_shop_work_account();
COMMIT;
