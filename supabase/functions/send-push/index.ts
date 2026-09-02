// Supabase Edge Function: send-push
// Triggered by Supabase Database Webhooks on:
//   messages, attendance, expense_batches, payment_status, attendance_requests, announcements

import webpush from 'npm:web-push';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VAPID_PUBLIC_KEY = 'BOljcP9J1CV8sjWGJ8C8QJ8E-GbgtBwy8wWGjm-DyePQSWamoCf4PdJlQz1ZIQ3hLU79FpjeKs-HL2IgWbQ2h3o';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
webpush.setVapidDetails('mailto:mandeepdynamics@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const STATUS_LABEL: Record<string, string> = {
  'P': 'Present', 'A': 'Absent', 'L': 'Late', 'EL': 'Left Early',
  'HD': 'Half Day', 'LA': 'Late Arrival', 'H': 'Holiday',
  'S': 'Sick', 'WFH': 'Working from Home', 'DO': 'Day Off',
};

function buildNotif(table: string, type: string, record: Record<string, unknown>, oldRecord: Record<string, unknown> | null) {
  let empId: string | null = null;
  let title = '', body = '', tag = 'ohm', important = false;

  if (table === 'messages' && type === 'INSERT') {
    if (record.sender !== 'office') return null;
    empId = record.employee_id as string;
    title = '💬 New message from Office';
    body = ((record.body as string) || '').slice(0, 100);
    tag = 'message';
  } else if (table === 'attendance' && (type === 'INSERT' || type === 'UPDATE')) {
    if (type === 'UPDATE' && oldRecord?.status === record.status) return null;
    empId = record.employee_id as string;
    const dateStr = (record.date as string) || '';
    const status = (record.status as string) || '';
    const statusText = STATUS_LABEL[status] || status;
    const hours = record.hours as number | null;
    const overtime = record.overtime as number | null;
    const d = dateStr ? new Date(dateStr + 'T12:00:00Z') : new Date();
    const fmt = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    title = type === 'INSERT' ? '📅 Attendance marked' : '📅 Attendance updated';
    const parts = [fmt, '—', statusText];
    if (hours) parts.push(`· ${hours}h worked`);
    if (overtime) parts.push(`· OT: ${overtime}h`);
    body = parts.join(' ');
    tag = 'att-' + dateStr;
  } else if (table === 'expense_batches' && type === 'UPDATE') {
    empId = record.employee_id as string;
    const total = record.total as number | null;
    const period = record.month ? `${record.month} ${record.year}` : '';
    const amt = total ? ` · £${Number(total).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    if (record.status === 'approved') { title = '✅ Expenses approved'; body = `${period}${amt} — approved`; }
    else if (record.status === 'rejected') { title = '❌ Expenses rejected'; body = `${period}${amt} — contact the office`; }
    else return null;
    tag = 'expense';
  } else if (table === 'payment_status') {
    empId = record.employee_id as string;
    const newlyBank = !oldRecord?.bank_paid && record.bank_paid;
    const newlyCash = !oldRecord?.cash_paid && record.cash_paid;
    if (type === 'INSERT' || newlyBank || newlyCash) {
      title = '💷 Payment confirmed';
      body = record.bank_paid ? 'Payment sent to your bank' : 'Cash payment recorded';
      tag = 'payment';
    } else return null;
  } else if (table === 'attendance_requests' && type === 'UPDATE') {
    empId = record.employee_id as string;
    if (record.status === 'approved') { title = '✅ Attendance request approved'; body = (record.date as string) || ''; }
    else if (record.status === 'rejected') { title = '❌ Attendance request rejected'; body = (record.office_note as string) || 'Contact the office'; }
    else return null;
    tag = 'att-req';
  } else if (table === 'announcements' && (type === 'INSERT' || type === 'UPDATE')) {
    if (!record.active) return null;
    important = !!(record.important);
    title = (important ? '⚠️ ' : '📢 ') + ((record.title as string) || 'New announcement');
    body = ((record.body as string) || '').slice(0, 100);
    tag = 'announcement';
    // empId stays null → broadcast to all employees
  } else {
    return null;
  }

  return { empId, title, body, tag, important };
}

async function sendToSubs(subs: Array<{id: number; endpoint: string; p256dh: string; auth: string}>, pushPayload: string) {
  const staleIds: number[] = [];
  await Promise.allSettled(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        pushPayload
      );
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 410 || status === 404) {
        staleIds.push(sub.id);
      } else {
        console.error('Push delivery failed for sub', sub.id, '— status:', status, err);
      }
    }
  }));
  if (staleIds.length) await sb.from('push_subscriptions').delete().in('id', staleIds);
  return subs.length - staleIds.length;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Verify webhook secret so only Supabase can trigger this
  const webhookSecret = Deno.env.get('WEBHOOK_SECRET');
  if (webhookSecret && req.headers.get('x-webhook-secret') !== webhookSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

  const { type, table, record, old_record } = payload as {
    type: string; table: string;
    record: Record<string, unknown>;
    old_record: Record<string, unknown> | null;
  };

  const notif = buildNotif(table, type, record, old_record);
  if (!notif) return new Response('no-op', { status: 200 });

  const { empId, title, body, tag, important } = notif;

  let query = sb.from('push_subscriptions').select('id, endpoint, p256dh, auth');
  if (empId !== null) query = query.eq('employee_id', empId);
  const { data: subs, error } = await query;
  if (error || !subs?.length) return new Response('no subs', { status: 200 });

  const pushPayload = JSON.stringify({ title, body, tag, important });
  const sent = await sendToSubs(subs, pushPayload);
  return new Response(JSON.stringify({ sent }), { headers: { 'Content-Type': 'application/json' } });
});
