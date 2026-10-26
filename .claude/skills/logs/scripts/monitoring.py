#!/usr/bin/env python3
"""Loki and Prometheus of the cluster through a short-lived port-forward (ns monitoring: admin kubeconfig).

    monitoring.py loki '<LogQL>' <from> [to] [--limit N] [--raw]
    monitoring.py prom '<PromQL>' [<from> [to] [--step 60]] [--raw]

<from>/<to>: 30m, 2h, 1d (back from now) or RFC3339 (2026-10-14T10:00:00Z). Without <from> prom asks for the
current value. The kubectl command comes from RYADOM_KUBECTL_ADMIN (default: kubectl), e.g. a wrapper that brings
the admin kubeconfig. Only reads; nothing is changed in the cluster.
"""
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

SERVICES = {'loki': ('svc/loki', 3100), 'prom': ('svc/prometheus-kube-prometheus-prometheus', 9090)}


def moment(value):
    m = re.fullmatch(r'(\d+)([smhd])', value)
    if m:
        unit = {'s': 'seconds', 'm': 'minutes', 'h': 'hours', 'd': 'days'}[m.group(2)]
        return datetime.now(timezone.utc) - timedelta(**{unit: int(m.group(1))})
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def forward(kind):
    service, remote = SERVICES[kind]
    port = free_port()
    kubectl = shlex.split(os.environ.get('RYADOM_KUBECTL_ADMIN', 'kubectl'))
    proc = subprocess.Popen(kubectl + ['-n', 'monitoring', 'port-forward', service, f'{port}:{remote}'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    for _ in range(60):
        if proc.poll() is not None:
            sys.exit(f'port-forward failed: {proc.stderr.read().strip()[-500:]}')
        try:
            socket.create_connection(('127.0.0.1', port), timeout=1).close()
            return proc, port
        except OSError:
            time.sleep(0.5)
    proc.kill()
    sys.exit('port-forward did not come up in 30 s')


def get(port, path, params):
    url = f'http://127.0.0.1:{port}{path}?{urllib.parse.urlencode(params)}'
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f'HTTP {e.code}: {e.read().decode(errors="replace")[:500]}')


def labels(metric):
    return ','.join(f'{k}={v}' for k, v in sorted(metric.items())) or '{}'


def stamp(seconds):
    return datetime.fromtimestamp(float(seconds), timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def print_result(data, raw):
    if raw:
        json.dump(data, sys.stdout, ensure_ascii=False, indent=1)
        print()
        return
    result = data.get('data', {})
    kind = result.get('resultType')
    rows = result.get('result', [])
    if kind == 'streams':
        lines = [(int(ts), s['stream'].get('pod', ''), line) for s in rows for ts, line in s['values']]
        for ts, pod, line in sorted(lines):
            print(f'{stamp(ts / 1e9)}\t{pod}\t{line}')
        print(f'# {len(lines)} lines', file=sys.stderr)
    elif kind == 'matrix':
        for s in rows:
            print(labels(s['metric']))
            for ts, value in s['values']:
                print(f'  {stamp(ts)}\t{value}')
    elif kind == 'vector':
        for s in rows:
            print(f'{labels(s["metric"])}\t{s["value"][1]}')
    else:
        json.dump(data, sys.stdout, ensure_ascii=False)
        print()


def main(argv):
    args, opts = [], {'--limit': '5000', '--step': '60'}
    raw = False
    it = iter(argv)
    for a in it:
        if a == '--raw':
            raw = True
        elif a in opts:
            opts[a] = next(it)
        else:
            args.append(a)
    if len(args) < 2 or args[0] not in SERVICES or (args[0] == 'loki' and len(args) < 3):
        sys.exit(__doc__)
    kind, query, rest = args[0], args[1], args[2:]
    end = moment(rest[1]) if len(rest) > 1 else datetime.now(timezone.utc)
    proc, port = forward(kind)
    try:
        if kind == 'loki':
            start = moment(rest[0])
            data = get(port, '/loki/api/v1/query_range', {
                'query': query, 'start': int(start.timestamp() * 1e9), 'end': int(end.timestamp() * 1e9),
                'limit': opts['--limit'], 'direction': 'forward'})
        elif rest:
            data = get(port, '/api/v1/query_range', {
                'query': query, 'start': moment(rest[0]).timestamp(), 'end': end.timestamp(), 'step': opts['--step']})
        else:
            data = get(port, '/api/v1/query', {'query': query})
        print_result(data, raw)
    finally:
        proc.terminate()


if __name__ == '__main__':
    main(sys.argv[1:])
