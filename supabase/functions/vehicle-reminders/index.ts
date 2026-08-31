// Supabase Edge Function: vehicle-reminders
// Run on a daily schedule via Supabase Dashboard → Edge Functions → Schedule
// Sends push notifications to assigned employees when vehicle docs are expiring
//
// Default alert days: 30, 15, 5, 4, 2, 1 — configurable in settings.vehicle_alert_days

import webpush from 'npm:web-push';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VAPID_PUBLIC_KEY = 'BOljcP9J1CV8sjWGJ8C8QJ8E-GbgtBwy8wWGjm-DyePQSWamoCf4PdJlQz1ZIQ3hLU79FpjeKs-HL2IgWbQ2h3o';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
webpush.setVapidDetails('mailto:mandeepdynamics@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const DEFAULT_ALERT_DAYS = [30, 15, 5, 4, 2, 1];

Deno.serve(async (_req) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Read configurable alert days from settings
  const { data: cfg } = await sb.from('settings').select('vehicle_alert_days').eq('id', 1).single();
  const alertDays: number[] = (cfg?.vehicle_alert_days as number[]) || DEFAULT_ALERT_DAYS;

  // Load all vehicles and all push subscriptions in parallel
  const [{ data: vehicles }, { data: allSubs }] = await Promise.all([
    sb.from('vehicles').select('id, reg, make, model, mot_expiry, tax_expiry, insurance_expiry, assigned_employee_ids'),
    sb.from('push_subscriptions').select('id, employee_id, endpoint, p256dh, auth'),
  ]);

  if (!vehicles?.length || !allSubs?.length) {
    return new Response(JSON.stringify({ sent: 0, reason: 'no vehicles or no subscriptions' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const staleIds: number[] = [];
  let totalSent = 0;

  const checks = [
    { key: 'mot_expiry',        emoji: '🔧', name: 'MOT' },
    { key: 'tax_expiry',        emoji: '📋', name: 'Road Tax' },
    { key: 'insurance_expiry',  emoji: '🛡️', name: 'Insurance' },
  ] as const;

  for (const vehicle of vehicles) {
    const assignedIds: string[] = (vehicle.assigned_employee_ids as string[]) || [];
    if (!assignedIds.length) continue;

    const subs = allSubs.filter(s => assignedIds.includes(s.employee_id));
    if (!subs.length) continue;

    const vehicleLabel = [vehicle.make, vehicle.model, vehicle.reg ? `(${vehicle.reg})` : ''].filter(Boolean).join(' ');

    for (const check of checks) {
      const expiryStr = vehicle[check.key] as string | null;
      if (!expiryStr) continue;

      const expiry = new Date(expiryStr);
      expiry.setHours(0, 0, 0, 0);
      const daysLeft = Math.round((expiry.getTime() - today.getTime()) / 86_400_000);

      if (!alertDays.includes(daysLeft)) continue;

      const urgent = daysLeft <= 5;
      const title = `${check.emoji} ${check.name} expiring in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
      const body = vehicleLabel;
      const tag = `veh-${vehicle.id}-${check.key}-${daysLeft}`;
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
  }

  if (staleIds.length) await sb.from('push_subscriptions').delete().in('id', staleIds);

  return new Response(JSON.stringify({ sent: totalSent }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
