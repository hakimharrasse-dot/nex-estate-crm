// ============================================================
// /api/admin-users.js — Gestion des utilisateurs (admin only)
//
// GET    → liste tous les profils
// POST   → crée un utilisateur Auth + profil (email, password, role)
// PATCH  → modifie role / active / full_name d'un profil
// DELETE → désactive un compte (soft delete, ?id=xxx)
//
// Sécurité : chaque appel vérifie le JWT et exige role='admin'
//            via la table profiles (service_role côté serveur)
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SVC_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Helpers REST (pas de dépendance SDK) ──────────────────────

async function sbRest(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey:        SVC_KEY,
      Authorization: `Bearer ${SVC_KEY}`,
      'Content-Type': 'application/json',
      Prefer:        'return=representation',
      ...opts.headers,
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function authApi(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    ...opts,
    headers: {
      apikey:        SVC_KEY,
      Authorization: `Bearer ${SVC_KEY}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// ── Vérifier que l'appelant est admin actif ───────────────────

async function requireAdmin(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  // Résoudre le JWT via Supabase Auth
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SVC_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user?.id) return null;

  // Vérifier role = admin et active = true dans profiles
  const profRes = await sbRest(
    `profiles?id=eq.${user.id}&select=id,role,active&limit=1`,
    { headers: { Prefer: 'return=representation' } }
  );
  const prof = profRes.data?.[0];
  if (!prof || prof.role !== 'admin' || !prof.active) return null;
  return { ...user, role: prof.role };
}

// ── Handler ───────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (!SUPABASE_URL || !SVC_KEY) {
    return res.status(500).json({ error: 'Variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes' });
  }

  const admin = await requireAdmin(req.headers.authorization);
  if (!admin) return res.status(401).json({ error: 'Non autorisé — rôle admin requis' });

  // ── GET — liste des utilisateurs ──────────────────────────
  if (req.method === 'GET') {
    const r = await sbRest(
      'profiles?select=id,email,full_name,role,active,created_at&order=created_at.desc'
    );
    if (!r.ok) return res.status(500).json({ error: 'Erreur lecture profils' });
    return res.json({ users: r.data || [] });
  }

  // ── POST — créer un utilisateur ────────────────────────────
  if (req.method === 'POST') {
    const { email, password, full_name = '', role } = req.body || {};
    if (!email || !password || !role) {
      return res.status(400).json({ error: 'email, password et role sont requis' });
    }
    if (!['admin', 'manager', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide (admin | manager | user)' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum' });
    }

    // 1. Créer le compte Auth (email_confirm=true → pas d'email de vérification)
    const authRes = await authApi('admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name },
      }),
    });
    if (!authRes.ok) {
      const msg = authRes.data?.msg || authRes.data?.message || 'Erreur Auth';
      return res.status(400).json({ error: msg });
    }
    const newUser = authRes.data;

    // 2. Créer le profil
    const profRes = await sbRest('profiles', {
      method: 'POST',
      body: JSON.stringify({
        id:         newUser.id,
        email,
        full_name,
        role,
        active:     true,
        created_by: admin.id,
      }),
    });
    if (!profRes.ok) {
      // Rollback : supprimer l'utilisateur Auth créé
      await authApi(`admin/users/${newUser.id}`, { method: 'DELETE' });
      return res.status(500).json({ error: 'Erreur création profil — utilisateur Auth annulé' });
    }

    return res.status(201).json({ ok: true, user: { id: newUser.id, email, role } });
  }

  // ── PATCH — modifier role / active / full_name ─────────────
  if (req.method === 'PATCH') {
    const { id, role, active, full_name } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requis' });
    if (id === admin.id && role !== undefined) {
      return res.status(403).json({ error: 'Impossible de modifier votre propre rôle' });
    }
    if (id === admin.id && active === false) {
      return res.status(403).json({ error: 'Impossible de désactiver votre propre compte' });
    }

    const patch = {};
    if (role !== undefined) {
      if (!['admin', 'manager', 'user'].includes(role)) {
        return res.status(400).json({ error: 'Rôle invalide' });
      }
      patch.role = role;
    }
    if (active !== undefined) patch.active = Boolean(active);
    if (full_name !== undefined) patch.full_name = full_name;
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Aucune modification fournie' });
    }

    const r = await sbRest(`profiles?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return res.status(500).json({ error: 'Erreur mise à jour profil' });
    return res.json({ ok: true });
  }

  // ── DELETE — désactiver un compte (soft delete) ────────────
  if (req.method === 'DELETE') {
    const id = req.query?.id || req.body?.id;
    if (!id) return res.status(400).json({ error: 'id requis' });
    if (id === admin.id) {
      return res.status(403).json({ error: 'Impossible de désactiver votre propre compte' });
    }

    const r = await sbRest(`profiles?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ active: false }),
    });
    if (!r.ok) return res.status(500).json({ error: 'Erreur désactivation' });
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
}
