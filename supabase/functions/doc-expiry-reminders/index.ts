// Supabase Edge Function: doc-expiry-reminders
// Scheduled daily via pg_cron — sends push notifications to employees
// when their documents are approaching expiry.
//
// Alert schedule per document:
//   • reminder_days before expiry  (set per-doc, default 30)
//   • 7, 3, 1 days before — always, regardless of reminder_days
//   • 0 = the expiry day itself

import webpush from 'npm:web-push';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VAPID_PUBLIC_KEY = 'BOljcP9J1CV8sjWGJ8C8QJ8E-GbgtBwy8wWGjm-DyePQSWamoCf4PdJlQz1ZIQ3hLU79FpjeKs-HL2IgWbQ2h3o';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
webpush.setVapidDetails('mailto:mandeepdynamics@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const URGENT_DAYS = [7, 3, 1, 0];

Deno.serve(async (_req) => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const [{ data: docs }, { data: allSubs }] = await Promise.all([
    sb.from('employee_documents')
      .select('id, employee_id, name, doc_type, expiry_date, reminder_days')
      .not('expiry_date', 'is', null),
    sb.from('push_subscriptions')
      .select('id, employee_id, endpoint, p256dh, auth'),
  ]);

  if (!docs?.length || !allSubs?.length) {
    return new Response(JSON.stringify({ sent: 0, reason: 'no docs or no subscriptions' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const staleIds: number[] = [];
  let totalSent = 0;

  for (const doc of docs) {
    const expiry = new Date(doc.expiry_date + 'T12:00:00Z');
    const daysLeft = Math.round((expiry.getTime() - today.getTime()) / 86_400_000);

    const remindDay: number = doc.reminder_days ?? 30;
    const alertDays = new Set([remindDay, ...URGENT_DAYS]);
    if (!alertDays.has(daysLeft)) continue;

    const subs = allSubs.filter(s => s.employee_id === doc.employee_id);
    if (!subs.length) continue;

    const label = doc.name + (doc.doc_type ? ` (${doc.doc_type})` : '');
    const urgent = daysLeft <= 3;
    const title = daysLeft === 0
      ? '⚠️ Document expires TODAY'
      : `📄 Document expiring in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    const body = label;
    const tag = `doc-${doc.id}-d${daysLeft}`;
    const pushPayload = JSON.stringify({ title, body, tag, important: urgent });

    await Promise.allSettled(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          pushPayload
        );
        totalSent++;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 410 || status === 404) staleIds.push(sub.id);
      }
    }));
  }

  if (staleIds.length) await sb.from('push_subscriptions').delete().in('id', staleIds);

  return new Response(JSON.stringify({ sent: totalSent }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
