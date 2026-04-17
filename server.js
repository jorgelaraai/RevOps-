const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');
const ical = require('node-ical');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('.'));

const CFG = {
  hs: process.env.HS_TOKEN || '',
  sl: process.env.SLACK_WH || '',
  ic: process.env.ICAL_URL || '',
  dm: process.env.DOMAIN || 'visma.com',
};

// ── HubSpot helpers ──────────────────────────────────────────────────────────

async function hsGet(path, params = {}) {
  const url = new URL('https://api.hubapi.com' + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + CFG.hs },
  });
  if (!r.ok) throw new Error('HubSpot ' + r.status);
  return r.json();
}

async function fetchDeals() {
  const props =
    'dealname,amount,dealstage,closedate,createdate,hubspot_owner_id,hs_deal_stage_probability,hs_lastmodifieddate,hs_is_closed_won,hs_is_closed';
  let all = [], after;
  for (let i = 0; i < 8; i++) {
    const p = { limit: 100, properties: props };
    if (after) p.after = after;
    const d = await hsGet('/crm/v3/objects/deals', p);
    all = all.concat(d.results || []);
    if (!d.paging?.next?.after) break;
    after = d.paging.next.after;
  }
  return all;
}

async function fetchOwners() {
  const d = await hsGet('/crm/v3/owners', { limit: 100 });
  return d.results || [];
}

async function fetchStages() {
  const d = await hsGet('/crm/v3/pipelines/deals');
  const m = {};
  (d.results || []).forEach(p =>
    (p.stages || []).forEach(s => { m[s.id] = { label: s.label }; })
  );
  return m;
}

// ── iCal helpers ─────────────────────────────────────────────────────────────

async function fetchMeetings() {
  if (!CFG.ic) return [];
  const events = await ical.async.fromURL(CFG.ic);
  const meetings = [];
  for (const ev of Object.values(events)) {
    if (ev.type !== 'VEVENT') continue;
    const attendees = Object.values(ev.attendee || {}).map(a =>
      (typeof a === 'string' ? a : a.val || '').replace('mailto:', '').toLowerCase()
    );
    meetings.push({
      sum: ev.summary || '',
      date: ev.start,
      att: attendees,
    });
  }
  return meetings;
}

function classifyMeeting(m) {
  const ext = m.att.filter(a => !a.endsWith('@' + CFG.dm));
  const lc = (m.sum || '').toLowerCase();
  return {
    comm: ext.length > 0,
    isDemo: lc.includes('demo lara'),
  };
}

// ── Slack helper ──────────────────────────────────────────────────────────────

async function sendSlack(text) {
  if (!CFG.sl) return;
  await fetch(CFG.sl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

// ── Risk scoring ──────────────────────────────────────────────────────────────

function riskLevel(deal) {
  const lm = deal.properties.hs_lastmodifieddate;
  const days = lm ? Math.floor((Date.now() - new Date(lm)) / 86400000) : 999;
  const p = parseFloat(deal.properties.hs_deal_stage_probability || 0.5) * 100;
  if (days <= 7 && p >= 50) return 'high';
  if (days <= 21 || p >= 30) return 'medium';
  return 'low';
}

// ── Main automation ───────────────────────────────────────────────────────────

async function runAutomation() {
  console.log('🚀 Iniciando ejecución automática — ' + new Date().toISOString());
  try {
    const [deals, owners, stages, meetings] = await Promise.all([
      fetchDeals(), fetchOwners(), fetchStages(), fetchMeetings(),
    ]);

    const ownerName = id => {
      const o = owners.find(x => x.id === id);
      return o ? (`${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email) : 'Sin asignar';
    };

    const active = deals.filter(d => d.properties.hs_is_closed !== 'true');
    const won = deals.filter(d => d.properties.hs_is_closed_won === 'true');
    const risky = active.filter(d => riskLevel(d) === 'low');
    const arr = active.reduce((s, d) => s + (parseFloat(d.properties.amount) || 0), 0);

    const now = new Date();
    const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
    const wkMtgs = meetings.filter(m => m.date >= weekAgo);
    const demos = meetings.filter(m => classifyMeeting(m).isDemo);

    // Reporte general
    await sendSlack([
      '*🤖 RevOps Lara AI · Reporte semanal*',
      '',
      `📊 *Pipeline activo:* ${active.length} deals · $${Math.round(arr).toLocaleString()} ARR`,
      `✅ *Won:* ${won.length} | ⚠️ *En riesgo:* ${risky.length}`,
      `📅 *Reuniones semana:* ${wkMtgs.length} | 🎯 *Demos Lara:* ${demos.length}`,
      '',
      '_Por favor revisá este reporte el lunes antes de la Weekly de Sales 👆_',
    ].join('\n'));

    // Alerta deals en riesgo
    if (risky.length > 0) {
      await sendSlack([
        `*⚠️ Deals en riesgo · ${risky.length} requieren atención*`,
        ...risky.slice(0, 8).map(d =>
          `• *${d.properties.dealname}* (${ownerName(d.properties.hubspot_owner_id)}) — $${Math.round(parseFloat(d.properties.amount) || 0).toLocaleString()} ARR`
        ),
      ].join('\n'));
    }

    console.log('✅ Ejecución completada');
  } catch (e) {
    console.error('❌ Error en automatización:', e.message);
    await sendSlack('❌ RevOps Lara AI: error en ejecución automática — ' + e.message);
  }
}

// ── Cron: todos los viernes a las 23:00 hora Buenos Aires (UTC-3) ─────────────
// En UTC eso es las 02:00 del sábado
cron.schedule('0 2 * * 6', runAutomation, { timezone: 'UTC' });
console.log('⏰ Cron programado: viernes 23:00 hs Buenos Aires');

// ── API endpoints ─────────────────────────────────────────────────────────────

app.get('/api/deals', async (req, res) => {
  try { res.json(await fetchDeals()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/owners', async (req, res) => {
  try { res.json(await fetchOwners()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stages', async (req, res) => {
  try { res.json(await fetchStages()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/meetings', async (req, res) => {
  try { res.json(await fetchMeetings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/run', async (req, res) => {
  runAutomation();
  res.json({ ok: true, message: 'Ejecución iniciada' });
});

app.get('/api/config', (req, res) => {
  res.json({
    hasHS: !!CFG.hs,
    hasSL: !!CFG.sl,
    hasIC: !!CFG.ic,
    domain: CFG.dm,
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🟢 Lara RevOps AI corriendo en puerto ' + PORT));
