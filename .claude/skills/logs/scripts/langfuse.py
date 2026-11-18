#!/usr/bin/env python3
"""Read the Langfuse public API of the cluster. Read-only by construction: only GET under /api/public/.

    langfuse.py get <path> [key=value ...]    e.g. get /api/public/traces fromTimestamp=2026-11-03T21:00:00Z limit=50
    langfuse.py metrics '<query JSON>'         GET /api/public/metrics?query=... (aggregates only)
    langfuse.py prompts                        prompt names with their production version and labels

The request runs inside the agent pod (kubectl exec, admin kubeconfig) with the pod's own project keys, so the keys
never leave the pod. The kubectl command comes from RYADOM_KUBECTL_ADMIN (default: kubectl). The fields input and
output are removed from every answer: traces may hold conversation text, and it must not reach reports or tasks.
Writes (prompt versions, labels, scores, deletion) are not possible here on purpose.
"""
import json
import os
import shlex
import subprocess
import sys
import urllib.parse

# Runs in the agent pod: stdlib only, request and fields arrive as a JSON literal.
INNER = r'''
import base64, json, os, sys, urllib.error, urllib.parse, urllib.request
reqs = json.loads(%(reqs)r)
host = os.environ.get("LANGFUSE_HOST", "http://langfuse-web.infra.svc.cluster.local:3000").rstrip("/")
pk, sk = os.environ.get("LANGFUSE_PUBLIC_KEY"), os.environ.get("LANGFUSE_SECRET_KEY")
if not pk or not sk:
    sys.exit("no Langfuse keys in the agent pod")
auth = base64.b64encode(f"{pk}:{sk}".encode()).decode()
def strip(x):
    if isinstance(x, dict):
        return {k: ("[removed]" if k in ("input", "output") and v is not None else strip(v)) for k, v in x.items()}
    if isinstance(x, list):
        return [strip(v) for v in x]
    return x
out = []
for req in reqs:
    url = host + req["path"] + ("?" + urllib.parse.urlencode(req["params"]) if req["params"] else "")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Basic " + auth}), timeout=120) as r:
            out.append(strip(json.loads(r.read())))
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} on {req['path']}: {e.read().decode(errors='replace')[:500]}")
print(json.dumps(out, ensure_ascii=False))
'''


def call_many(requests):
    """One kubectl exec for several GET requests; answers in the same order."""
    for path, _ in requests:
        if not path.startswith('/api/public/') or '..' in path:
            sys.exit('only paths under /api/public/ are allowed')
    script = INNER % {'reqs': json.dumps([{'path': p, 'params': q} for p, q in requests])}
    kubectl = shlex.split(os.environ.get('RYADOM_KUBECTL_ADMIN', 'kubectl'))
    proc = subprocess.run(kubectl + ['exec', '-i', '-n', 'agent', 'deploy/agent', '-c', 'agent', '--', 'python', '-'],
                          input=script, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit((proc.stderr or proc.stdout).strip()[-800:] or f'kubectl exit {proc.returncode}')
    return json.loads(proc.stdout)


def call(path, params):
    return call_many([(path, params)])[0]


def prompts():
    rows, page = [], 1
    while True:
        body = call('/api/public/v2/prompts', {'page': page, 'limit': 100})
        rows += body.get('data', [])
        if page >= body.get('meta', {}).get('totalPages', 1):
            break
        page += 1
    names = [p['name'] for p in rows if 'production' in (p.get('labels') or [])]
    production = call_many([(f"/api/public/v2/prompts/{urllib.parse.quote(n, safe='')}", {'label': 'production'})
                            for n in names]) if names else []
    live = {p['name']: p for p in production}
    return [{'name': p.get('name'), 'type': p.get('type'), 'latest': max(p.get('versions') or [0]) or None,
             'production': live.get(p['name'], {}).get('version'), 'labels': p.get('labels') or [],
             'productionUpdatedAt': live.get(p['name'], {}).get('updatedAt'), 'lastUpdatedAt': p.get('lastUpdatedAt')}
            for p in rows]


def main(argv):
    if len(argv) >= 2 and argv[0] == 'get':
        params = dict(a.split('=', 1) for a in argv[2:])
        result = call(argv[1], params)
    elif len(argv) == 2 and argv[0] == 'metrics':
        json.loads(argv[1])  # fail early on a broken query
        result = call('/api/public/metrics', {'query': argv[1]})
    elif argv == ['prompts']:
        result = prompts()
    else:
        sys.exit(__doc__)
    print(json.dumps(result, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main(sys.argv[1:])
