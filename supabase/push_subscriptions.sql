-- Run this once in Supabase Dashboard → SQL Editor
-- Creates the table that stores each engineer's Web Push subscription

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  endpoint  text NOT NULL,
  p256dh    text NOT NULL,
  auth      text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (employee_id, endpoint)
);

-- No RLS needed — the anon key inserts, the service role (Edge Function) reads.
-- If you need to lock it down later, add policies here.
