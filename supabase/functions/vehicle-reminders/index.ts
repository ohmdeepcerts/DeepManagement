// Supabase Edge Function: vehicle-reminders
// Run on a daily schedule via Supabase Dashboard → Edge Functions → Schedule
// 1. Refreshes MOT expiry via DVSA and tax expiry via DVLA VES for vehicles
//    that are expired or expiring within 30 days — so a renewal is picked up
//    automatically the next morning without anyone touching the admin panel.
// 2. Sends push notifications to assigned employees when vehicle docs are expiring.
//
// Default alert days: 30, 15, 5, 4, 2, 1 — configurable in settings.vehicle_alert_days

import webpush from 'npm:web-push';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VAPID_PUBLIC_KEY = 'BOljcP9J1CV8sjWGJ8C8QJ8E-GbgtBwy8wWGjm-DyePQSWamoCf4PdJlQz1ZIQ3hLU79FpjeKs-HL2IgWbQ2h3o';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
webpush.setVapidDetails('mailto:mandeepdynamics@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const DEFAULT_ALERT_DAYS = [30, 15, 5, 4, 2, 1];
// Vehicles expired or expiring within this window are re-checked against the APIs
const REFRESH_WINDOW_DAYS = 30;

// ── DVSA MOT refresh ──────────────────────────────────────────────────────────
async function refreshMOT(
  vehicle: { id: number; reg: string; mot_expiry: string | null },
  dvsaClientId: string,
  dvsaClientSecret: string,
  dvsaApiKey: string,
): Promise<string | null> {
  try {
    const tr = await fetch(
      'https://login.microsoftonline.com/a455b827-244f-4c97-b5b4-ce5d13b4d00c/oauth2/v2.0/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: dvsaClientId,
          client_secret: dvsaClientSecret,
          scope: 'https://tapi.dvsa.gov.uk/.default',
        }),
      },
    );
    const td = await tr.json();
    if (!td.access_token) return null;
    const cleanReg = (vehicle.reg || '').replace(/\s+/g, '').toUpperCase();
    const dr = await fetch(
      'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/' + cleanReg,
      { headers: { Authorization: 'Bearer ' + td.access_token, 'X-API-Key': dvsaApiKey } },
    );
    if (!dr.ok) return null;
    const data = await dr.json();
    if (!data.motTests?.length) return null;
    const passed = data.motTests.find((t: { testResult: string }) => t.testResult === 'PASSED');
    if (!passed?.expiryDate) return null;
    // DVSA returns DD.MM.YYYY — convert to YYYY-MM-DD
    return passed.expiryDate.replace(/(\d{2})\.(\d{2})\.(\d{4})/, '$3-$2-$1');
  } catch {
    return null;
  }
}

// ── DVLA VES tax refresh ──────────────────────────────────────────────────────
async function refreshTax(
  vehicle: { id: number; reg: string },
  vesKey: string,
): Promise<string | null> {
  try {
    const cleanReg = (vehicle.reg || '').replace(/\s+/g, '').toUpperCase();
    const resp = await fetch(
      'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': vesKey },
        body: JSON.stringify({ registrationNumber: cleanReg }),
      },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    // taxDueDate is already YYYY-MM-DD
    return data.taxDueDate || null;
  } catch {
    return null;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (_req) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const daysFrom = (ds: string | null): number | null => {
    if (!ds) return null;
    const d = new Date(ds);
    return isNaN(d.getTime()) ? null : Math.round((d.getTime() - today.getTime()) / 86_400_000);
  };

  // Load settings + vehicles + subscriptions in parallel
  const [{ data: cfg }, { data: vehicles }, { data: allSubs }] = await Promise.all([
    sb.from('settings').select('vehicle_alert_days,dvsa_client_id,dvsa_client_secret,dvsa_api_key,dvla_ves_api_key').eq('id', 1).single(),
    sb.from('vehicles').select('id,reg,make,model,mot_expiry,tax_expiry,insurance_expiry,assigned_employee_ids'),
    sb.from('push_subscriptions').select('id,employee_id,endpoint,p256dh,auth'),
  ]);

  const alertDays: number[] = (cfg?.vehicle_alert_days as number[]) || DEFAULT_ALERT_DAYS;
  const dvsaReady = !!(cfg?.dvsa_client_id && cfg?.dvsa_client_secret && cfg?.dvsa_api_key);
  const vesReady = !!(cfg?.dvla_ves_api_key);

  // ── 1. Refresh dates for vehicles expiring/expired within REFRESH_WINDOW_DAYS ──
  const dateUpdates: Array<{ id: number; changes: Record<string, string> }> = [];

  for (const car of vehicles || []) {
    const motDays = daysFrom(car.mot_expiry);
    const taxDays = daysFrom(car.tax_expiry);
    const changes: Record<string, string> = {};

    // Refresh MOT if within window or expired
    if (dvsaReady && motDays !== null && motDays <= REFRESH_WINDOW_DAYS) {
      const newMot = await refreshMOT(
        car,
        cfg!.dvsa_client_id,
        cfg!.dvsa_client_secret,
        cfg!.dvsa_api_key,
      );
      if (newMot && newMot.length === 10 && newMot !== car.mot_expiry) {
        changes.mot_expiry = newMot;
      }
    }

    // Refresh tax if within window or expired
    if (vesReady && taxDays !== null && taxDays <= REFRESH_WINDOW_DAYS) {
      const newTax = await refreshTax(car, cfg!.dvla_ves_api_key);
      if (newTax && newTax.length === 10 && newTax !== car.tax_expiry) {
        changes.tax_expiry = newTax;
      }
    }

    if (Object.keys(changes).length) {
      dateUpdates.push({ id: car.id, changes });
      // Apply to in-memory record so notification logic below uses fresh dates
      Object.assign(car, changes);
    }
  }

  // Write all date updates
  await Promise.allSettled(
    dateUpdates.map(({ id, changes }) => sb.from('vehicles').update(changes).eq('id', id)),
  );

  // ── 2. Send push notifications ───────────────────────────────────────────────
  if (!vehicles?.length || !allSubs?.length) {
    return new Response(
      JSON.stringify({ refreshed: dateUpdates.length, sent: 0, reason: 'no vehicles or no subscriptions' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  const staleIds: number[] = [];
  let totalSent = 0;

  const checks = [
    { key: 'mot_expiry', emoji: '🔧', name: 'MOT' },
    { key: 'tax_expiry', emoji: '📋', name: 'Road Tax' },
    { key: 'insurance_expiry', emoji: '🛡️', name: 'Insurance' },
  ] as const;

  for (const vehicle of vehicles) {
    const assignedIds: string[] = (vehicle.assigned_employee_ids as string[]) || [];
    if (!assignedIds.length) continue;
    const subs = allSubs.filter((s) => assignedIds.includes(s.employee_id));
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
      await Promise.allSettled(
        subs.map(async (sub) => {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              pushPayload,
            );
            totalSent++;
          } catch (err: unknown) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 410 || status === 404) staleIds.push(sub.id);
          }
        }),
      );
    }
  }

  if (staleIds.length) await sb.from('push_subscriptions').delete().in('id', staleIds);

  return new Response(
    JSON.stringify({ refreshed: dateUpdates.length, sent: totalSent }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
