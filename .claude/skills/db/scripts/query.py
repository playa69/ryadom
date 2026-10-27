#!/usr/bin/env python3
"""SQL against the production PostgreSQL (CNPG cluster ryadom-db) through psql in its primary pod.

    query.py <database> "<SQL>" [--csv] [--write]
    query.py <database> -f query.sql [--csv] [--write]

Databases: app, agent, backend, cognee_db. Read-only by default: the session starts with
default_transaction_read_only, so any write fails. --write lifts that; use it only on an explicit request.
pods/exec in ryadom-db needs the admin kubeconfig: the kubectl command comes from RYADOM_KUBECTL_ADMIN
(default: kubectl). psql runs as postgres over the pod's local socket, so no password is needed or printed.
"""
import os
import shlex
import subprocess
import sys

DATABASES = {'app', 'agent', 'backend', 'cognee_db'}


def kubectl(*args, **kw):
    cmd = shlex.split(os.environ.get('RYADOM_KUBECTL_ADMIN', 'kubectl')) + list(args)
    return subprocess.run(cmd, text=True, **kw)


def primary():
    for selector in ('cnpg.io/cluster=ryadom-db,cnpg.io/instanceRole=primary', 'cnpg.io/cluster=ryadom-db,role=primary'):
        r = kubectl('-n', 'ryadom-db', 'get', 'pod', '-l', selector, '-o', 'jsonpath={.items[0].metadata.name}',
                    capture_output=True)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
        if r.returncode != 0:
            sys.exit(f'kubectl: {r.stderr.strip()[-500:]}')
    sys.exit('No primary pod of ryadom-db found')


def main(argv):
    write = '--write' in argv
    csv = '--csv' in argv
    args = [a for a in argv if a not in ('--write', '--csv')]
    if len(args) == 3 and args[1] == '-f':
        with open(args[2], encoding='utf-8') as f:
            sql = f.read()
    elif len(args) == 2:
        sql = args[1]
    else:
        sys.exit(__doc__)
    db = args[0]
    if db not in DATABASES:
        sys.exit(f'Unknown database {db}: one of {", ".join(sorted(DATABASES))}')
    script = ('' if write else 'SET default_transaction_read_only = on;\n') + sql.rstrip().rstrip(';') + ';\n'
    psql = ['psql', '-U', 'postgres', '-d', db, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off']
    if csv:
        psql.append('--csv')
    r = kubectl('-n', 'ryadom-db', 'exec', '-i', primary(), '-c', 'postgres', '--', *psql, input=script)
    sys.exit(r.returncode)


if __name__ == '__main__':
    main(sys.argv[1:])
