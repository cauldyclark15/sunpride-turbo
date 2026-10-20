-- F-611: read-only delivery status replica behind the CALLFLOW/delivery seam.
-- No route/drop/allocation/ePOD engine is created here.
create table mt_delivery_status_replicas (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references orders(id),
  stage text not null check(stage in ('ready_for_delivery','dispatched','delivered','delivery_exception')),
  occurred_at timestamptz not null, source text not null check(source in ('sample','delivery')),
  upstream_key text not null, source_version text not null, received_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(upstream_key,source_version)
);
create index mt_delivery_replica_order on mt_delivery_status_replicas(order_id,occurred_at);
