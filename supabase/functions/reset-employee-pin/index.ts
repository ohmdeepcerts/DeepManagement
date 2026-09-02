import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const ALLOWED_ORIGIN = 'https://ohmdeepcerts.github.io';

const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, content-type, x-admin-secret',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function randomPin(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Verify admin secret — only the office app knows this value
  const adminSecret = Deno.env.get('ADMIN_SECRET');
  if (!adminSecret || req.headers.get('x-admin-secret') !== adminSecret) {
    return json({ error: 'Unauthorized' }, 401);
  }

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
