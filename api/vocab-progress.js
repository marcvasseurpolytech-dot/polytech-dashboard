const crypto = require("crypto");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = "marcvasseurpolytech-dot/polytech-dashboard";
const FILE_PATH = "vocab-progress-data.json";
// Dedicated branch: writes must not trigger a production deploy.
const BRANCH = "data";

const MAX_WORDS = 500;
const MAX_DAYS = 800;
const MAX_KEY_LENGTH = 120;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function num(x, max) {
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

// Keeps only the expected fields, with bounded numbers, before anything is written to the repository.
function sanitize(p) {
  const out = { v: 1, words: {}, days: {}, updated: 0 };
  if (!p || typeof p !== "object") return out;
  const words = p.words && typeof p.words === "object" ? p.words : {};
  Object.keys(words).slice(0, MAX_WORDS).forEach((k) => {
    if (typeof k !== "string" || k.length === 0 || k.length > MAX_KEY_LENGTH) return;
    const x = words[k];
    if (!x || typeof x !== "object") return;
    out.words[k] = {
      b: num(x.b, 5),
      s: num(x.s, 1000000),
      r: num(x.r, 1000000),
      w: num(x.w, 1000000),
      l: num(x.l, 1e15),
      d: num(x.d, 1e15)
    };
  });
  const days = p.days && typeof p.days === "object" ? p.days : {};
  Object.keys(days).slice(-MAX_DAYS).forEach((k) => {
    if (!DAY_RE.test(k)) return;
    const x = days[k];
    if (!x || typeof x !== "object") return;
    const n = num(x.n, 100000);
    out.days[k] = { n: n, ok: Math.min(num(x.ok, 100000), n) };
  });
  out.updated = num(p.updated, 1e15);
  return out;
}

// For each word, the most recently answered record wins; for each day, the larger count wins.
function merge(a, b) {
  a = sanitize(a);
  b = sanitize(b);
  const out = { v: 1, words: {}, days: {}, updated: Math.max(a.updated, b.updated) };
  new Set(Object.keys(a.words).concat(Object.keys(b.words))).forEach((k) => {
    const x = a.words[k];
    const y = b.words[k];
    if (!x) out.words[k] = y;
    else if (!y) out.words[k] = x;
    else out.words[k] = y.l > x.l || (y.l === x.l && y.s > x.s) ? y : x;
  });
  new Set(Object.keys(a.days).concat(Object.keys(b.days))).forEach((k) => {
    const x = a.days[k];
    const y = b.days[k];
    if (!x) out.days[k] = y;
    else if (!y) out.days[k] = x;
    else out.days[k] = y.n > x.n ? y : x;
  });
  return out;
}

async function ghGet() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" }
  });
  if (r.status === 404) return { data: { profiles: {} }, sha: undefined };
  if (!r.ok) throw new Error("Lecture GitHub impossible (" + r.status + ")");
  const j = await r.json();
  const data = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
  if (!data.profiles || typeof data.profiles !== "object") data.profiles = {};
  return { data, sha: j.sha };
}

async function ghPut(data, sha, message) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
  const body = { message, content, branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
    method: "PUT",
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const err = new Error("Ecriture GitHub impossible (" + r.status + ")");
    err.status = r.status;
    throw err;
  }
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Methode non autorisee" });
    return;
  }
  if (!GITHUB_TOKEN) {
    res.status(500).json({ ok: false, error: "Variable d'environnement GITHUB_TOKEN manquante sur Vercel." });
    return;
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ ok: false, error: "Requete invalide" });
    return;
  }
  const action = body && body.action;
  const h = body && body.h;
  if ((action !== "sync" && action !== "reset") || typeof h !== "string" || !HASH_RE.test(h)) {
    res.status(400).json({ ok: false, error: "Requete invalide (action ou cle manquante)" });
    return;
  }
  if (action === "sync" && JSON.stringify(body.progress || {}).length > 200000) {
    res.status(413).json({ ok: false, error: "Donnees trop volumineuses" });
    return;
  }

  // The stored key is derived from the client hash, so the file never contains the credential itself.
  const key = crypto.createHash("sha256").update("vocab:" + h).digest("hex");

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, sha } = await ghGet();
      const current = data.profiles[key] && data.profiles[key].progress;

      if (action === "reset") {
        if (!data.profiles[key]) { res.status(200).json({ ok: true }); return; }
        delete data.profiles[key];
        try {
          await ghPut(data, sha, "Vocabulaire: reset profil");
          res.status(200).json({ ok: true });
          return;
        } catch (e) {
          if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
          throw e;
        }
      }

      const merged = merge(current, body.progress);
      if (current && JSON.stringify(sanitize(current)) === JSON.stringify(merged)) {
        res.status(200).json({ ok: true, progress: merged });
        return;
      }
      data.profiles[key] = { progress: merged, updatedAt: new Date().toISOString() };
      try {
        await ghPut(data, sha, "Vocabulaire: progression");
        res.status(200).json({ ok: true, progress: merged });
        return;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
        throw e;
      }
    }
    res.status(409).json({ ok: false, error: "Conflit d'ecriture, reessaie dans un instant." });
  } catch (e) {
    if (e && (e.status === 409 || e.status === 422)) {
      res.status(409).json({ ok: false, error: "Conflit d'ecriture, reessaie dans un instant." });
      return;
    }
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.merge = merge;
module.exports.sanitize = sanitize;
