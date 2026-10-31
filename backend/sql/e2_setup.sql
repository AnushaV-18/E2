-- E2 SETUP FOR YOUR EXISTING ECART DATABASE
-- Safe: it only ADDS tables/columns/data. It never drops or deletes anything. Safe to run twice.
-- Run this ONE file in pgAdmin's Query Tool on your existing ecart database.

-- Safety check: stops with a clear message if you are connected to the wrong database.
DO $$
BEGIN
  IF to_regclass('public.inventory') IS NULL OR to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 'WRONG DATABASE: you are connected to "%" and it has no inventory/orders table. Click your ecart database in the left panel, open a NEW Query Tool, and run this again.', current_database();
  END IF;
END $$;


CREATE TABLE IF NOT EXISTS route (
  route_id        BIGSERIAL PRIMARY KEY,
  from_region_id  BIGINT NOT NULL,
  to_region_id    BIGINT NOT NULL,
  distance_km     NUMERIC(10,2) NOT NULL CHECK (distance_km > 0),
  UNIQUE (from_region_id, to_region_id)
);

CREATE TABLE IF NOT EXISTS order_allocation (
  allocation_id  BIGSERIAL PRIMARY KEY,
  order_id       BIGINT NOT NULL,
  round_no       SMALLINT NOT NULL DEFAULT 1,
  plan_rank      SMALLINT NOT NULL CHECK (plan_rank BETWEEN 1 AND 3),
  warehouse_id   BIGINT NOT NULL,
  product_id     BIGINT NOT NULL,
  quantity       INT NOT NULL CHECK (quantity > 0),
  eta_min        INT NOT NULL,
  score          NUMERIC(8,4),             -- NULL for Plus orders
  status         VARCHAR(10) NOT NULL DEFAULT 'PLANNED'
                 CHECK (status IN ('PLANNED','RESERVED','FAILED','ACTIVE')),
  UNIQUE (order_id, round_no, plan_rank, warehouse_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_order_allocation_order ON order_allocation (order_id);

CREATE TABLE IF NOT EXISTS e2_workload (
  warehouse_id   BIGINT PRIMARY KEY,
  pending_orders INT NOT NULL DEFAULT 0 CHECK (pending_orders >= 0)
);

CREATE TABLE IF NOT EXISTS e2_stage_log (
  log_id       BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL,
  shipment_id  BIGINT,
  warehouse_id BIGINT,
  event        VARCHAR(10) NOT NULL CHECK (event IN ('STAGE','RETRY','FAILED')),
  stage        VARCHAR(10),
  note         TEXT,
  event_time   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_e2_stage_log_order ON e2_stage_log (order_id);
CREATE INDEX IF NOT EXISTS idx_e2_stage_log_ship ON e2_stage_log (shipment_id, event);

-- Warehouses
CREATE TABLE IF NOT EXISTS warehouse (
  warehouse_id        SERIAL PRIMARY KEY,
  name                VARCHAR(100) NOT NULL,
  region_id           INT NOT NULL,
  avg_processing_min  INT NOT NULL DEFAULT 30
);
INSERT INTO warehouse (name, region_id, avg_processing_min)
SELECT * FROM (VALUES ('Hubballi Warehouse',1,20),('Bengaluru Warehouse',2,30),('Pune Warehouse',3,25)) v(name,region_id,avg_processing_min)
WHERE NOT EXISTS (SELECT 1 FROM warehouse);

-- Stock per warehouse (E2 uses this; ecart's own "inventory" table is NOT touched).
CREATE TABLE IF NOT EXISTS warehouse_stock (
  warehouse_id        INT NOT NULL,
  product_id          INT NOT NULL,
  quantity_available  INT NOT NULL CHECK (quantity_available >= 0),
  PRIMARY KEY (warehouse_id, product_id)
);
-- Split each product's current ecart stock across the 3 warehouses (about a third each,
-- remainder to warehouse 1) so big orders have to be split.
INSERT INTO warehouse_stock (warehouse_id, product_id, quantity_available)
SELECT w.warehouse_id, i.product_id,
       (i.stock_quantity / 3) + CASE WHEN w.warehouse_id = 1 THEN i.stock_quantity % 3 ELSE 0 END
FROM inventory i CROSS JOIN warehouse w
ON CONFLICT DO NOTHING;

-- Extra columns on your existing orders table (existing rows get defaults; nothing breaks)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(10) NOT NULL DEFAULT 'REGULAR';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_region_id INT NOT NULL DEFAULT 4;

-- Multi-item order lines (copy existing single-product orders into it)
CREATE TABLE IF NOT EXISTS order_details (
  order_id    INT NOT NULL,
  product_id  INT NOT NULL,
  quantity    INT NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, product_id)
);
INSERT INTO order_details (order_id, product_id, quantity)
SELECT order_id, product_id, quantity FROM orders
ON CONFLICT DO NOTHING;

-- One shipment per warehouse part of an order
CREATE TABLE IF NOT EXISTS shipment (
  shipment_id    SERIAL PRIMARY KEY,
  order_id       INT NOT NULL,
  warehouse_id   INT NOT NULL,
  status         VARCHAR(10) NOT NULL DEFAULT 'ALLOCATED',
  allocation_id  BIGINT,
  ship_date      TIMESTAMPTZ
);

-- Road map (km, one row per direction). Regions 1-3 = warehouses, 4-5 = customer areas.
INSERT INTO route (from_region_id, to_region_id, distance_km) VALUES
  (1,2,410),(2,1,410),(1,3,420),(3,1,420),(2,3,840),(3,2,840),
  (1,4,30),(4,1,30),(2,5,25),(5,2,25),(4,5,440),(5,4,440),(3,4,450),(4,3,450)
ON CONFLICT DO NOTHING;

