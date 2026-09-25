const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = "marcvasseurpolytech-dot/polytech-dashboard";
const FILE_PATH = "toeic-scores-data.json";
const BRANCH = "main";
const ADMIN_HASH = "f7ff32b790557d7601029bc0b296115f82e18d799b6e27ba0c6202fdbd1f2a08";

async function ghGet() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" }
  });
  if (!r.ok) throw new Error("Lecture GitHub impossible (" + r.status + ")");
  const j = await r.json();
  const content = Buffer.from(j.content, "base64").toString("utf8");
  return { data: JSON.parse(content), sha: j.sha };
}

async function ghPut(data, sha, message) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
    method: "PUT",
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ message, content, branch: BRANCH, sha })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("Ecriture GitHub impossible (" + r.status + ") " + t);
  }
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (!GITHUB_TOKEN) {
    res.status(500).json({ error: "Variable d'environnement GITHUB_TOKEN manquante sur Vercel." });
    return;
  }

  try {
    if (req.method === "GET") {
      const { data } = await ghGet();
      res.status(200).json(data);
      return;
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const { action, key } = body || {};
      if (!action || !key) { res.status(400).json({ error: "Requete invalide (action/key manquants)" }); return; }

      const { data, sha } = await ghGet();
      if (!data.students) data.students = {};

      if (action === "upsert") {
        const existing = data.students[key];
        if (existing && existing.codeHash !== body.codeHash) {
          res.status(403).json({ error: "Code incorrect pour ce profil." });
          return;
        }
        data.students[key] = body.student;
        await ghPut(data, sha, "Upsert student " + key);
        res.status(200).json({ ok: true });
        return;
      }

      if (action === "adminUpdate") {
        if (body.adminHash !== ADMIN_HASH) { res.status(403).json({ error: "Non autorise." }); return; }
        data.students[key] = body.student;
        await ghPut(data, sha, "Admin update " + key);
        res.status(200).json({ ok: true });
        return;
      }

      if (action === "adminDelete") {
        if (body.adminHash !== ADMIN_HASH) { res.status(403).json({ error: "Non autorise." }); return; }
        delete data.students[key];
        await ghPut(data, sha, "Admin delete " + key);
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: "Action inconnue" });
      return;
    }

    res.status(405).json({ error: "Methode non autorisee" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
