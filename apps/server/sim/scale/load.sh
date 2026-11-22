#!/usr/bin/env bash
# usage: load.sh <lots> <tier-tag>   (DB: simbig, base data from sim/out/scale-base.json)
set -euo pipefail
cd "$(dirname "$0")/../.."
B=sim/out/scale-base.json
arr() { python3 -c "import json,sys; d=json.load(open('$B')); print('{'+','.join($1)+'}')"; }
PGPASSWORD=sim psql -h localhost -U sim simbig -q \
  -v ws="$(python3 -c "import json;print(json.load(open('$B'))['workspaceId'])")" \
  -v actor="$(python3 -c "import json;print(json.load(open('$B'))['actorId'])")" \
  -v lots="$1" -v tier="$2" \
  -v ing="$(arr "d['ingredientIds']" )" -v prod="$(arr "d['productIds']")" \
  -v loc="$(arr "d['locations'].values()")" -v sup="$(arr "d['supplierIds']")" \
  -f sim/scale/load.sql
