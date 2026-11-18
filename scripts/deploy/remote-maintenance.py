import pathlib,subprocess,json,datetime,sys
root=pathlib.Path('/home/miluzhe/apps/shop-agent-showcase');base=['docker','compose','--project-name','shop-agent-showcase','--project-directory',str(root),'-f',str(root/'compose.yaml')];phase='local-trust';r={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
def run(args,**kwargs):return subprocess.run(args,check=True,cwd=root,**kwargs)
try:
 result=subprocess.check_output(['curl','--noproxy','*','--silent','--show-error','--resolve','47.111.162.237:443:127.0.0.1','--max-time','15','--output','/dev/null','--write-out','%{http_code}','https://47.111.162.237/api/health'],text=True).strip()
 if result!='200':raise RuntimeError('Internal trusted HTTPS failed')
 phase='remove-staging';run(base+['run','--rm','certbot','delete','--cert-name','47.111.162.237-staging','--non-interactive'])
 phase='renewal-dry-run';run(base+['run','--rm','certbot','renew','--dry-run','--webroot','--webroot-path','/var/www/acme','--non-interactive'])
 phase='renewal-wrapper';run(['sh',str(root/'renew-certificate.sh')])
 phase='initial-backup';run(['sh',str(root/'backup-database.sh')])
 phase='cron';old=subprocess.run(['crontab','-l'],capture_output=True,text=True)
 if old.returncode not in [0,1]:raise RuntimeError('Cannot read user cron')
 if not (root/'crontab-before.txt').exists():
  (root/'crontab-before.txt').write_text(old.stdout);(root/'crontab-before.txt').chmod(0o600)
 begin='# BEGIN shop-agent-showcase';end='# END shop-agent-showcase';text=old.stdout
 if begin in text:
  left,remaining=text.split(begin,1);remaining=remaining.split(end,1)[1];text=left+remaining
 block=begin+'\n17 */12 * * * /home/miluzhe/apps/shop-agent-showcase/renew-certificate.sh >> /home/miluzhe/apps/shop-agent-showcase/renewal.log 2>&1\n31 3 * * * /home/miluzhe/apps/shop-agent-showcase/backup-database.sh >> /home/miluzhe/apps/shop-agent-showcase/backup.log 2>&1\n'+end+'\n'
 run(['crontab','-'],input=text.rstrip()+'\n'+block,text=True)
 installed=subprocess.check_output(['crontab','-l'],text=True)
 if begin not in installed or end not in installed:raise RuntimeError('Cron installation failed')
 r.update(passed=True,internalTrustedHttps=200,renewalDryRun=True,renewalWrapperPassed=True,scheduledRenewal='twice daily at minute 17',scheduledBackup='03:31 server timezone',priorUserCronPreserved=True,public443Pending=True,completedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
except Exception as e:r.update(passed=False,phase=phase,errorType=type(e).__name__)
(root/'maintenance-result.json').write_text(json.dumps(r,indent=2));print(json.dumps(r));sys.exit(0 if r['passed']else 1)
