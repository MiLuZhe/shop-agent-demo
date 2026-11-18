BEGIN;
CREATE TABLE account_names (
  username varchar(50) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retired_at timestamptz(6),
  CONSTRAINT account_names_canonical CHECK (username = lower(btrim(username)) AND length(username) > 0)
);
CREATE INDEX account_names_user_id_idx ON account_names(user_id);
CREATE UNIQUE INDEX account_names_current_user_key ON account_names(user_id) WHERE retired_at IS NULL;
ALTER TABLE users ADD CONSTRAINT users_username_canonical CHECK (username = lower(btrim(username)) AND length(username) > 0);
INSERT INTO account_names (username, user_id) SELECT username, id FROM users;

-- Historical names remain reserved, including to their original owner. An
-- INSERT conflict rolls back the username change and retirement atomically.
CREATE FUNCTION maintain_account_names() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF NEW.username IS NOT DISTINCT FROM OLD.username THEN RETURN NEW; END IF;
  UPDATE account_names SET retired_at=clock_timestamp() WHERE username=OLD.username AND user_id=OLD.id;
 END IF;
 INSERT INTO account_names(username,user_id) VALUES(NEW.username,NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER users_account_names AFTER INSERT OR UPDATE OF username ON users FOR EACH ROW EXECUTE FUNCTION maintain_account_names();

CREATE OR REPLACE FUNCTION advance_user_auth_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id THEN
  RAISE EXCEPTION 'user identity is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
  OR NEW.platform_role IS DISTINCT FROM OLD.platform_role
  OR NEW.status IS DISTINCT FROM OLD.status
  OR NEW.username IS DISTINCT FROM OLD.username THEN
  NEW.auth_version := OLD.auth_version+1;
 ELSIF NEW.auth_version IS DISTINCT FROM OLD.auth_version THEN
  RAISE EXCEPTION 'auth version is maintained by the database' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
COMMIT;
