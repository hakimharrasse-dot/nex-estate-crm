// ============================================================
// /api/export-data.js — Nex-Estate CRM
// Export COMPLET des donnees metier en SQL re-importable (disaster recovery).
// Protege par un jeton : en-tete "x-export-token" (ou ?token=) compare a EXPORT_TOKEN.
// La cle Supabase reste cote serveur (SUPABASE_SERVICE_ROLE_KEY) — jamais exposee.
//
// Utilise par le script local run-backup.ps1 (backup PC de Hakim), qui appelle
// cet endpoint tous les ~15 jours et sauvegarde le SQL dans NEX-ESTATE-BACKUP.
//
// Variables d'environnement Vercel requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (deja presentes)
//   EXPORT_TOKEN  (a ajouter par Hakim = contenu de .claude/nex-export-token.txt)
//
// Reconstruction fidele de chaque ligne via json_populate_record (tous types, jsonb).
// ============================================================
import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPORT_TOKEN = process.env.EXPORT_TOKEN || '';

// Tables de donnees metier a exporter (pas les backups/technique/auth).
// `reglements` (journal des soldes verses a l'equipe, cree le 2026-08-11) fait partie de
// l'historique financier : sans lui, « soldé quand, combien » serait perdu a la restauration.
// Volontairement EXCLUES : scheduled_messages / sync_heartbeat (etat operationnel, se reconstruit).
const TABLES = ['resa', 'serv', 'business', 'perso', 'taxe', 'team_members', 'recurring_charges', 'messages', 'reglements'];

// Lecture d'une table entiere via PostgREST (pagination par 1000 lignes).
async function sbGetAll(table) {
  let all = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Range: `${from}-${from + page - 1}`,
        'Range-Unit': 'items',
      },
    });
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    all = all.concat(rows);
    if (!Array.isArray(rows) || rows.length < page) break;
  }
  return all;
}

// Comparaison a temps constant (anti-timing-attack) et longueur-safe.
function tokenOk(provided) {
  if (!EXPORT_TOKEN || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(EXPORT_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  const provided = req.headers['x-export-token'] || (req.query && req.query.token) || '';
  if (!tokenOk(provided)) {
    return res.status(401).json({ error: 'Non autorise (jeton manquant/invalide ou EXPORT_TOKEN non configure cote Vercel).' });
  }
  try {
    let out = '-- ============================================================\n';
    out += '-- Nex-Estate CRM — EXPORT COMPLET DES DONNEES\n';
    out += `-- Genere le ${new Date().toISOString()} (via /api/export-data)\n`;
    out += '-- Restauration : base VIDE, schema deja cree. json_populate_record reconstruit chaque ligne.\n';
    out += '-- Regles (crm_contexte, logements) : voir regles-crm_contexte-logements.sql.\n';
    out += '-- ============================================================\n\n';
    for (const t of TABLES) {
      const rows = await sbGetAll(t);
      out += `-- ${t} (${rows.length})\n`;
      for (const row of rows) {
        if (t === 'messages') delete row.raw_payload; // debogage technique volumineux — non necessaire
        const json = JSON.stringify(row).replace(/'/g, "''"); // echappe pour le litteral SQL
        out += `insert into ${t} select * from json_populate_record(null::${t}, '${json}'::json);\n`;
      }
      out += '\n';
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="donnees-completes.sql"');
    return res.status(200).send(out);
  } catch (e) {
    console.error('[export-data] erreur:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
