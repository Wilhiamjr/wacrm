#!/usr/bin/env node
// ---------------------------------------------------------------------------
// One-off maintenance script (idempotent): repair WAHA/GOWS LID phones.
//
// WhatsApp's LID rollout makes GOWS deliver inbound senders as
// `2419…@s.whatsapp.net` — a 14+ digit ID that is NOT a phone. Those digits
// were persisted as `contacts.phone`, so replies go out as `LID@c.us` and
// WAHA fails with "no LID found for …". This script:
//
//   1. finds contacts whose `phone_normalized` is >= 14 digits (LID-like),
//   2. resolves each to the real linked phone via
//      `GET {baseUrl}/api/{session}/lids/{lid}` → `{ pn: "…@c.us" }`,
//   3. renames the contact to the real phone, or — when a contact with that
//      real phone already exists in the same account — merges the LID row
//      into it (re-pointing every child row, mirroring migration 022).
//
// Run from `wacrm/`:  node scripts/fix-waha-lid-phones.mjs
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  const text = readFileSync('.env.local', 'utf8')
  const env = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}

const env = loadEnv()
const url = env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const LID_MIN_DIGITS = 14

const db = createClient(url, serviceKey, { auth: { persistSession: false } })

async function wahaConfigs() {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('account_id, provider, provider_config')
    .eq('provider', 'waha')
  if (error) throw error
  return data
}

async function lidContacts() {
  // No length() filter via PostgREST — fetch pages and filter client-side.
  const all = []
  let from = 0
  for (;;) {
    const page = 1000
    const { data: rows, error } = await db
      .from('contacts')
      .select('id, account_id, name, phone, phone_normalized')
      .not('phone_normalized', 'is', null)
      .range(from, from + page - 1)
      .order('id')
    if (error) throw error
    all.push(...rows)
    if (rows.length < page) break
    from += page
  }
  return all.filter(
    (c) => ((c.phone_normalized ?? '').replace(/\D/g, '')).length >= LID_MIN_DIGITS,
  )
}

async function resolveLid(session, baseUrl, apiKey, lidDigits) {
  const api = `${baseUrl.replace(/\/+$/, '')}/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lidDigits)}`
  const res = await fetch(api, {
    headers: apiKey ? { 'X-Api-Key': apiKey, 'Accept': 'application/json' } : { 'Accept': 'application/json' },
  })
  if (!res.ok) {
    console.warn(`  ! lids GET ${lidDigits} -> HTTP ${res.status} ${res.statusText}`)
    return null
  }
  const body = await res.json().catch(() => null)
  const pn = String(body?.pn ?? '').trim()
  if (!pn) return null
  const digits = pn.split('@')[0].replace(/\D/g, '')
  return digits || null
}

// ---- merge (mirrors migration 022_contact_phone_dedup) ----

const CHILD_TABLES = [
  'conversations',
  'contact_notes',
  'deals',
  'broadcast_recipients',
  'automation_logs',
  'automation_pending_executions',
]

async function repointPlain(tables, loserId, survivorId) {
  for (const table of tables) {
    const { error } = await db
      .from(table)
      .update({ contact_id: survivorId })
      .eq('contact_id', loserId)
    if (error) console.warn(`  ! ${table} re-point failed: ${error.message}`)
  }
}

async function repointContactTags(loserId, survivorId) {
  const { data: loserTags, error } = await db
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', loserId)
  if (error) throw error
  for (const { tag_id } of loserTags) {
    const { error: ex } = await db
      .from('contact_tags')
      .update({ contact_id: survivorId })
      .eq('contact_id', loserId)
      .eq('tag_id', tag_id)
    if (ex?.code === '23505') {
      const { error: delErr } = await db.from('contact_tags').delete().eq('contact_id', loserId).eq('tag_id', tag_id)
      if (delErr) console.warn(`  ! contact_tags cleanup failed: ${delErr.message}`)
    } else if (ex) {
      console.warn(`  ! contact_tags re-point failed: ${ex.message}`)
    }
  }
}

async function repointCustomValues(loserId, survivorId) {
  const { data: rows, error } = await db
    .from('contact_custom_values')
    .select('custom_field_id')
    .eq('contact_id', loserId)
  if (error) throw error
  for (const { custom_field_id } of rows) {
    const { error: ex } = await db
      .from('contact_custom_values')
      .update({ contact_id: survivorId })
      .eq('contact_id', loserId)
      .eq('custom_field_id', custom_field_id)
    if (ex?.code === '23505') {
      const { error: delErr } = await db.from('contact_custom_values').delete().eq('contact_id', loserId).eq('custom_field_id', custom_field_id)
      if (delErr) console.warn(`  ! contact_custom_values cleanup failed: ${delErr.message}`)
    } else if (ex) {
      console.warn(`  ! contact_custom_values re-point failed: ${ex.message}`)
    }
  }
}

async function repointFlowRuns(loserId, survivorId) {
  const { data: active, error } = await db
    .from('flow_runs')
    .select('id')
    .eq('contact_id', loserId)
    .eq('status', 'active')
  if (error) throw error
  const activeIds = new Set((active ?? []).map((r) => r.id))

  const { data: all, error: allErr } = await db
    .from('flow_runs')
    .select('id')
    .eq('contact_id', loserId)
  if (allErr) throw allErr
  for (const run of all ?? []) {
    if (activeIds.has(run.id)) continue // partial unique on active per contact
    const { error: ex } = await db
      .from('flow_runs')
      .update({ contact_id: survivorId })
      .eq('id', run.id)
    if (ex?.code !== '23505' && ex) console.warn(`  ! flow_runs re-point failed: ${ex.message}`)
  }
}

async function mergeContact(loser, survivor) {
  console.log(`  → merging LID contact ${loser.id} (${loser.phone}) into existing ${survivor.id} (${survivor.phone})`)
  await repointPlain(CHILD_TABLES, loser.id, survivor.id)
  await repointContactTags(loser.id, survivor.id)
  await repointCustomValues(loser.id, survivor.id)
  await repointFlowRuns(loser.id, survivor.id)

  const { error } = await db.from('contacts').delete().eq('id', loser.id)
  if (error) throw error
}

async function main() {
  const configs = await wahaConfigs()
  if (!configs.length) {
    console.error('No WAHA whatsapp_config rows found.')
    process.exit(1)
  }

  const contacts = await lidContacts()
  if (!contacts.length) {
    console.log('No LID-like contacts found (phone_normalized < 14 digits). Nothing to do.')
    return
  }

  const baseUrl = configs[0].provider_config?.baseUrl
  const apiKey = configs[0].provider_config?.apiKey
  const session = configs[0].provider_config?.sessionName || 'default'
  if (!baseUrl) {
    console.error('Missing provider_config.baseUrl on the WAHA config.')
    process.exit(1)
  }
  console.log(`Resolving ${contacts.length} LID contact(s) via ${baseUrl} (session "${session}") …`)

  for (const contact of contacts) {
    const lidDigits = contact.phone_normalized?.replace(/\D/g, '') ?? ''
    if (lidDigits.length < LID_MIN_DIGITS) continue

    const real = await resolveLid(session, baseUrl, apiKey, lidDigits)
    if (!real) {
      console.log(`  ! ${lidDigits} (${contact.name ?? contact.id}): no phone resolved — left untouched`)
      continue
    }
    if (real === lidDigits) {
      console.log(`  = ${lidDigits}: already a phone, no change`)
      continue
    }

    const { data: existing, error: exErr } = await db
      .from('contacts')
      .select('id, name, phone')
      .eq('account_id', contact.account_id)
      .eq('phone_normalized', real)
      .limit(1)
    if (exErr) {
      console.warn(`  ! lookup ${real} failed: ${exErr.message}`)
      continue
    }

    if (existing?.length) {
      await mergeContact(contact, existing[0])
    } else {
      const { error: updErr } = await db.from('contacts').update({ phone: real }).eq('id', contact.id)
      if (updErr) {
        console.warn(`  ! rename ${lidDigits} → ${real} failed: ${updErr.message}`)
      } else {
        console.log(`  ✓ ${lidDigits} → ${real} (${contact.name ?? 'unnamed'})`)
      }
    }
  }

  console.log('Done.')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})