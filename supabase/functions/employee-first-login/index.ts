import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const ALLOWED_ORIGIN = 'https://ohmdeepcerts.github.io';

const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

function normPhone(p: string): string {
  const digits = (p || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: { phone?: string; temp_pin?: string; new_pin?: string };
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  const { phone, temp_pin, new_pin } = body;
  if (!phone || !temp_pin || !new_pin) return json({ error: 'Missing phone, temp_pin or new_pin' }, 400);
  if (!/^\d{6}$/.test(new_pin)) return json({ error: 'PIN must be exactly 6 digits' }, 400);

  const norm = normPhone(phone);
  if (norm.length < 10) return json({ error: 'Invalid phone number' }, 400);

  // Query directly by normalised phone — avoids loading all employees
  const { data: emps, error: empErr } = await sb
    .from('employees')
    .select('id, name, phone, status, auth_user_id, temp_pin')
    .eq('status', 'Active')
    .eq('temp_pin', temp_pin);

  if (empErr) return json({ error: 'Could not load employees' }, 500);

  const emp = emps?.find((e) => normPhone(e.phone as string) === norm);

  if (!emp) return json({ error: 'Invalid phone or temporary PIN. Contact your office.' }, 401);
  if (emp.auth_user_id) return json({ error: 'Account already set up. Please log in with your PIN.' }, 409);

  const email = norm + '@ohm.internal';

  const { data: userData, error: createErr } = await sb.auth.admin.createUser({
    email,
    password: new_pin,
    email_confirm: true,
  });

  if (createErr || !userData?.user) {
    return json({ error: 'Could not create account: ' + (createErr?.message || 'unknown') }, 500);
  }

  const { error: linkErr } = await sb
    .from('employees')
    .update({ auth_user_id: userData.user.id, temp_pin: null })
    .eq('id', emp.id);

  if (linkErr) {
    // Best-effort cleanup — log orphan if delete also fails
    const { error: delErr } = await sb.auth.admin.deleteUser(userData.user.id);
    if (delErr) console.error('Orphan auth user:', userData.user.id, delErr.message);
    return json({ error: 'Could not link account to employee record' }, 500);
  }

  return json({ success: true });
});
