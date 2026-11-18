import datetime
import json
import pathlib
import subprocess

root = pathlib.Path('/home/miluzhe/apps/shop-agent-showcase')
result = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'release': json.loads((root / 'images.lock.json').read_text())['release'], 'containers': []}
for name in ['shop-agent-showcase-api-1', 'shop-agent-showcase-postgres-1', 'shop-agent-showcase-web-1', 'registry']:
    data = json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]
    result['containers'].append({'name': name, 'state': data['State']['Status'], 'health': data['State'].get('Health', {}).get('Status'), 'restarts': data['RestartCount'], 'oomKilled': data['State']['OOMKilled'], 'memoryLimitMiB': data['HostConfig']['Memory'] / 1048576, 'ports': data['NetworkSettings']['Ports']})
for name, url in [('registry', 'http://127.0.0.1:5000/v2/'), ('gunicorn', 'http://127.0.0.1:8000/')]:
    result[name + 'Http'] = int(subprocess.check_output(['curl', '--noproxy', '*', '--silent', '--max-time', '5', '--output', '/dev/null', '--write-out', '%{http_code}', url], text=True))
result['nodeVersion'] = subprocess.check_output(['docker', 'exec', 'shop-agent-showcase-api-1', 'node', '--version'], text=True).strip()
result['postgresVersion'] = subprocess.check_output(['docker', 'exec', 'shop-agent-showcase-postgres-1', 'psql', '-U', 'shop_agent', '-d', 'shop_showcase', '-Atc', 'SHOW server_version'], text=True).strip()
nginx = subprocess.run(['docker', 'exec', 'shop-agent-showcase-web-1', 'nginx', '-v'], capture_output=True, text=True)
result['nginxVersion'] = (nginx.stdout + nginx.stderr).strip()
result['memory'] = subprocess.check_output(['free', '-m'], text=True).strip()
result['disk'] = subprocess.check_output(['df', '-h', '/'], text=True).strip()
for name in ['certificate-status', 'maintenance-result', 'initial-deployment']:
    result[name] = json.loads((root / (name + '.json')).read_text())
result['maintenance-result']['public443Pending'] = False
result['maintenance-result']['public443OpenedByUser'] = True
result['apiEnvironmentPermissions'] = oct((root / 'api.env').stat().st_mode & 0o777)
result['cronActive'] = subprocess.check_output(['systemctl', 'is-active', 'cron'], text=True).strip()
cron = subprocess.check_output(['crontab', '-l'], text=True)
result['renewalCronPresent'] = '/home/miluzhe/apps/shop-agent-showcase/renew-certificate.sh' in cron
result['backupCronPresent'] = '/home/miluzhe/apps/shop-agent-showcase/backup-database.sh' in cron
query = "SELECT json_build_object('users',(SELECT count(*) FROM users),'savedAddresses',(SELECT count(*) FROM saved_addresses),'products',(SELECT count(*) FROM products WHERE status='active'),'activeSkus',(SELECT count(*) FROM skus s JOIN products p ON p.id=s.product_id WHERE s.is_active AND p.status='active'),'tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'_prisma_migrations'),'migrations',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),'foreignKeys',(SELECT count(*) FROM information_schema.table_constraints WHERE constraint_schema='public' AND constraint_type='FOREIGN KEY'))"
result['database'] = json.loads(subprocess.check_output(['docker', 'exec', 'shop-agent-showcase-postgres-1', 'psql', '-U', 'shop_agent', '-d', 'shop_showcase', '-Atc', query], text=True))
print(json.dumps(result, ensure_ascii=False, indent=2))
