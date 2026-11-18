BEGIN;
ALTER TABLE users ADD COLUMN auth_version integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD CONSTRAINT users_auth_version_check CHECK(auth_version>=1);
-- Increment inside the database, so even a quick disable/re-enable or
-- promotion/demotion with no intervening request invalidates old sessions.
CREATE FUNCTION advance_user_auth_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
  OR NEW.platform_role IS DISTINCT FROM OLD.platform_role
  OR NEW.status IS DISTINCT FROM OLD.status THEN
  NEW.auth_version := OLD.auth_version+1;
 ELSIF NEW.auth_version IS DISTINCT FROM OLD.auth_version THEN
  RAISE EXCEPTION 'auth version is maintained by the database' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER users_auth_version BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION advance_user_auth_version();
COMMIT;
