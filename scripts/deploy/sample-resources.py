import datetime
import json
import pathlib
import subprocess
import sys

project = sys.argv[1]
if project not in ['shop-showcase-local', 'shop-agent-showcase']:
    raise SystemExit('Unexpected project')
info = pathlib.Path('/proc/meminfo').read_text().splitlines()
report = {'availableMiB': round(int([s for s in info if s.startswith('MemAvailable:')][0].split()[1]) / 1024, 1), 'containers': []}
for service in ['api', 'postgres', 'web']:
    name = project + '-' + service + '-1'
    data = json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]
    command = "cat /sys/fs/cgroup/memory.current; if test -r /sys/fs/cgroup/memory.peak; then cat /sys/fs/cgroup/memory.peak; else echo unavailable; fi; cat /sys/fs/cgroup/memory.events; awk '/VmHWM:/ {print \"pid1_hwm_kib \" $2}' /proc/1/status; cat /sys/fs/cgroup/cpu.stat"
    values = subprocess.check_output(['docker', 'exec', name, 'sh', '-c', command], text=True).splitlines()
    fields = dict(s.split() for s in values[2:])
    memory_events = {k: int(fields.get(k, 0)) for k in ['low', 'high', 'max', 'oom', 'oom_kill', 'oom_group_kill']}
    has_peak = values[1] != 'unavailable'
    report['containers'].append({'name': name, 'memoryMiB': round(int(values[0]) / 1048576, 1),
        'peakMiB': round(int(values[1] if has_peak else values[0]) / 1048576, 1), 'kernelPeakAvailable': has_peak,
        'pid1RssHighWaterMiB': round(int(fields.get('pid1_hwm_kib', 0)) / 1024, 1),
        'memoryEvents': memory_events, 'cpuUsageMicroseconds': int(fields.get('usage_usec', 0)),
        'limitMiB': data['HostConfig']['Memory'] / 1048576, 'cpuLimit': data['HostConfig']['NanoCpus'] / 1e9,
        'restarts': data['RestartCount'], 'oomKilled': data['State']['OOMKilled'], 'health': data['State'].get('Health', {}).get('Status')})
print(json.dumps(report))
