// Supabase Edge Function: reset-employee-pin
// Generates a new random PIN for an employee, updates their auth password,
// and stores the PIN in employees.temp_pin so the office can share it.
//
// POST body: { employee_id: string }
// Returns:   { pin: string } | { error: string }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function randomPin(): string {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: { employee_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  const { employee_id } = body;
  if (!employee_id) return json({ error: 'Missing employee_id' }, 400);

  const { data: emp, error: empErr } = await sb
    .from('employees')
    .select('id, auth_user_id')
    .eq('id', employee_id)
    .single();

  if (empErr || !emp) return json({ error: 'Employee not found' }, 404);

  const newPin = randomPin();

  if (emp.auth_user_id) {
    const { error: updateErr } = await sb.auth.admin.updateUserById(
      emp.auth_user_id,
      { password: newPin }
    );
    if (updateErr) return json({ error: 'Could not update auth password: ' + updateErr.message }, 500);
  }

  const { error: pinErr } = await sb
    .from('employees')
    .update({ temp_pin: newPin, force_pin_change: true })
    .eq('id', employee_id);

  if (pinErr) return json({ error: 'Could not store new PIN' }, 500);

  return json({ pin: newPin });
});
