import subprocess,pathlib,json,socket,sys,datetime,hashlib
root=pathlib.Path('/home/miluzhe/apps/shop-agent-showcase');phase='preflight';report={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
def run(args,**kw):return subprocess.run(args,check=True,cwd=root,**kw)
compose=['docker','compose','--project-name','shop-agent-showcase','--project-directory',str(root),'-f',str(root/'compose.yaml')]
def health(url):return subprocess.check_output(['curl','--noproxy','*','--silent','--max-time','5','--output','/dev/null','--write-out','%{http_code}',url],text=True).strip()
try:
 if health('http://127.0.0.1:5000/v2/')!='200' or health('http://127.0.0.1:8000/')!='200':raise RuntimeError('Original services are not healthy')
 available=int([s for s in pathlib.Path('/proc/meminfo').read_text().splitlines() if s.startswith('MemAvailable:')][0].split()[1])
 if available<850*1024:raise RuntimeError('Insufficient memory headroom for initial deployment')
 existing=subprocess.check_output(['docker','ps','--format','{{.Names}}'],text=True).splitlines()
 for port in [80,443]:
  s=socket.socket();s.settimeout(1);busy=s.connect_ex(('127.0.0.1',port))==0;s.close()
  if busy and 'shop-agent-showcase-web-1' not in existing:raise RuntimeError('Public port already occupied')
 phase='load-images';run(['docker','load','--input',str(root/'images.tar.gz')])
 lock=json.loads((root/'images.lock.json').read_text())
 for entry in lock['images'].values():
  image=json.loads(subprocess.check_output(['docker','image','inspect',entry['tag']],text=True))[0]
  if image['RootFS']['Layers']!=entry['layers']:raise RuntimeError('Loaded image layers do not match verified release')
 phase='database';run(compose+['config','--quiet']);run(compose+['up','-d','--wait','--wait-timeout','90','postgres'])
 count=subprocess.check_output(compose+['exec','-T','postgres','psql','-U','shop_agent','-d','shop_showcase','-Atc',"SELECT count(*) FROM pg_tables WHERE schemaname='public'"],cwd=root,text=True).strip()
 if count=='0':
  with (root/'demo.dump').open('rb')as stream:run(compose+['exec','-T','postgres','sh','-c','exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error'],stdin=stream,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 else:run(['sh',str(root/'backup-database.sh')])
 phase='application';run(compose+['up','-d','--wait','--wait-timeout','120','api']);run(compose+['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','90','web'])
 phase='existing-services';report['registryHttp']=int(health('http://127.0.0.1:5000/v2/'));report['gunicornHttp']=int(health('http://127.0.0.1:8000/'));report['bootstrapHttp']=int(health('http://127.0.0.1/healthz'))
 if report['registryHttp']!=200 or report['gunicornHttp']!=200 or report['bootstrapHttp']!=200:raise RuntimeError('Post-deployment health check failed')
 report.update(passed=True,release=lock['release'],stage='HTTP bootstrap and internal API ready; HTTPS pending',completedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
except Exception as e:report.update(passed=False,phase=phase,errorType=type(e).__name__);sys.exitcode=1
(root/'initial-deployment.json').write_text(json.dumps(report,indent=2));print(json.dumps(report));sys.exit(0 if report['passed']else 1)
