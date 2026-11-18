-- Replace mutually exclusive buyer/seller identity. Existing selling authority
-- remains in shop_members; nobody is promoted to platform admin by migration.
BEGIN;
ALTER TABLE users DROP CONSTRAINT users_identity_check;
ALTER TABLE users RENAME COLUMN role TO platform_role;
UPDATE users SET platform_role='user';
ALTER TABLE users ALTER COLUMN platform_role SET DEFAULT 'user';
ALTER TABLE users ADD CONSTRAINT users_identity_check CHECK (
 username=lower(btrim(username)) AND username ~ '[^[:space:]]'
 AND display_name ~ '[^[:space:]]' AND platform_role IN ('user','admin') AND status IN ('active','disabled')
);
ALTER TABLE shop_members DROP CONSTRAINT shop_members_content_check;
ALTER TABLE shop_members ADD CONSTRAINT shop_members_content_check CHECK (
 role IN ('owner','manager','staff') AND status IN ('active','disabled')
);
COMMIT;
