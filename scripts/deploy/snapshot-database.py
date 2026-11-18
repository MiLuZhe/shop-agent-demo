import json
import subprocess

base = ['docker', 'compose', '--project-name', 'shop-agent-showcase', '--project-directory', '/home/miluzhe/apps/shop-agent-showcase', '-f', '/home/miluzhe/apps/shop-agent-showcase/compose.yaml', 'exec', '-T', 'postgres', 'psql', '-U', 'shop_agent', '-d', 'shop_showcase', '-Atc']
tables = subprocess.check_output(base + ["SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename"], text=True).splitlines()
result = {}
for table in tables:
    if not table.replace('_', '').isalpha():
        raise RuntimeError('Unexpected table name')
    query = f'''SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM "{table}" t'''
    result[table] = subprocess.check_output(base + [query], text=True).strip()
print(json.dumps(result))
