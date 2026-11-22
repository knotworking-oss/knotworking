-- Bulk-load synthetic stock history. Variables: ws, actor, lots (count), tier (tag), ing, prod, loc, sup.
\set ON_ERROR_STOP on
set synchronous_commit = off;
begin;
create temp table gen on commit drop as
select gen_random_uuid() as lot_id, g,
  random() < 0.03 as live,
  random() < 0.7 as is_ing,
  (:'loc'::uuid[])[1 + floor(random() * array_length(:'loc'::uuid[], 1))::int] as loc_id,
  (:'sup'::uuid[])[1 + floor(random() * array_length(:'sup'::uuid[], 1))::int] as sup_id,
  random() as r_item, random() as r_f, random() as r_status, random() as r_date, random() as r_life,
  3 * (1 + floor(random() * 33333)) as q
from generate_series(1, :lots) g;
alter table gen add column item_id uuid, add column received date, add column expires date, add column status text, add column cons numeric;
update gen set
  item_id = case when is_ing then (:'ing'::uuid[])[1 + floor(r_item * array_length(:'ing'::uuid[], 1))::int]
                 else (:'prod'::uuid[])[1 + floor(r_item * array_length(:'prod'::uuid[], 1))::int] end,
  received = case when live then date '2026-11-13' - floor(r_date * 40)::int
                  else date '2026-11-13' - 60 - floor(r_date * 3650)::int end,
  status = case when live and r_status < 0.03 then 'quarantine' when live and r_status < 0.05 then 'rejected' else 'available' end,
  cons = case when live then round((q * (0.2 + 0.6 * r_f) / 3)::numeric, 4) else q / 3.0 end;
update gen set expires = received + 5 + floor(r_life * 300)::int;

insert into stock_lots (id, workspace_id, item_id, lot_code, supplier_id, received_on, expires_on, expiry_type, status)
select lot_id, :'ws', item_id, 'SYN' || :'tier' || '-' || g, case when is_ing then sup_id end, received, expires, 'best_before', status
from gen;

create temp table mv on commit drop as
select gen_random_uuid() as id, lot_id, item_id, loc_id, j,
  case when j = 0 then q else -cons end as quantity,
  case when j = 0 then (case when is_ing then 'receipt' else 'production' end)
       else (case when is_ing then 'consumption' else 'despatch' end) end as type,
  received + j as occurred
from gen cross join generate_series(0, 3) j;

insert into stock_movements (id, workspace_id, lot_id, item_id, location_id, quantity, type, reference, actor_id, occurred_at)
select id, :'ws', lot_id, item_id, loc_id, quantity, type, 'SYN-' || :'tier', :'actor', occurred::timestamptz + interval '9 hours'
from mv;

insert into sync_changes (workspace_id, entity, entity_id, action, data, actor_id)
select :'ws', 'stock_lot', lot_id, 'upsert',
  jsonb_build_object('id', lot_id, 'workspaceId', :'ws', 'itemId', item_id, 'lotCode', 'SYN' || :'tier' || '-' || g, 'status', status, 'receivedOn', received, 'expiresOn', expires, 'expiryType', 'best_before'),
  :'actor' from gen;
insert into sync_changes (workspace_id, entity, entity_id, action, data, actor_id)
select :'ws', 'stock_movement', id, 'upsert',
  jsonb_build_object('id', id, 'workspaceId', :'ws', 'lotId', lot_id, 'itemId', item_id, 'locationId', loc_id, 'quantity', quantity, 'type', type, 'reference', 'SYN-' || :'tier', 'occurredAt', occurred),
  :'actor' from mv order by lot_id, j;
commit;
analyze stock_lots; analyze stock_movements; analyze sync_changes;
