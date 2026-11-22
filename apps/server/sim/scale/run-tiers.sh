#!/usr/bin/env bash
# Measures tier A again with fresh statistics, then grows the ledger and measures B and C.
set -uo pipefail
cd "$(dirname "$0")/../.."
export PGPASSWORD=sim SIM_PG_URL=postgres://sim:sim@localhost:5432/simbig
P="psql -h localhost -U sim simbig -q"
measure() { $P -c "analyze" ; TIER=$1 npx vitest run -c sim/vitest.sim.config.ts sim/scale/measure.sim.ts 2>&1 | grep -E "SCALE|passed|failed|rror" | cut -c1-9000 ; }
echo "== tier A (1M movements), fresh statistics"; measure A-analyzed
echo "== loading B (+750k lots)"; time sim/scale/load.sh 750000 B
$P -Atc "select 'movements',count(*) from stock_movements" -c "select pg_size_pretty(pg_database_size('simbig'))"
echo "== tier B"; measure B
echo "== loading C (+2M lots)"; time sim/scale/load.sh 2000000 C
$P -Atc "select 'movements',count(*) from stock_movements" -c "select pg_size_pretty(pg_database_size('simbig'))"
echo "== tier C"; measure C
echo DONE
