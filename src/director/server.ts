import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { DirectorRepo } from "./repo.js";
import type { DirectorService } from "./service.js";
import type { EngineRegistry } from "./engines.js";
import type { Vocabulary } from "./vocabulary.js";
import type { ReferenceKind, ReferenceRole, Rule, Shot } from "./types.js";
import { DIRECTOR_HTML } from "./ui-html.js";

/**
 * The local UI (spec §9): bible, kanban, shot card, job queue, review. One
 * process, 127.0.0.1 only, JSON in and out; the page is one static HTML
 * document. Every Venice send passes through `approve` first; the server
 * exposes no route that skips it.
 */
export interface ServerDeps {
  readonly repo: DirectorRepo;
  readonly service: DirectorService;
  readonly engines: EngineRegistry;
  readonly vocabulary: Vocabulary;
  readonly dataDir: string;
  readonly capabilities: { text: boolean; textModel: string; textProvider: string; gate: boolean; venice: boolean; ffmpeg: boolean };
  readonly log: (msg: string, fields?: Record<string, unknown>) => void;
}

export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".json": "application/json" };
const REF_KINDS: readonly ReferenceKind[] = ["image", "video", "audio"];
const REF_ROLES: readonly ReferenceRole[] = ["identity", "keyframe", "style", "motion", "audio"];

function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > limit) { rej(new HttpError(413, "body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

const num = (s: string | undefined): number => { const n = Number(s); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `bad id '${s}'`); return n; };

/** The API as plain functions, so tests call them without sockets. */
export function createApi(d: ServerDeps) {
  const { repo, service } = d;
  const need = (v: unknown, what: string): void => { if (v === undefined || v === null || v === "") throw new HttpError(400, `${what} fehlt`); };

  const shotDetail = (id: number) => {
    const shot = repo.shot(id); if (!shot) throw new HttpError(404, "shot not found");
    const gate = repo.latestGate(id);
    let checks: unknown = []; try { checks = service.codeChecks(id); } catch { /* unknown engine: the card shows nothing */ }
    return {
      shot, references: repo.shotReferences(id), gate: gate ? { ...gate, answers: JSON.parse(gate.answers_json), confidences: JSON.parse(gate.confidence_json), code_checks: JSON.parse(gate.code_checks_json) } : null,
      checks, claude_calls: repo.claudeCalls(id).map((c) => ({ id: c.id, purpose: c.purpose, input_tokens: c.input_tokens, output_tokens: c.output_tokens, model: c.model, created_at: c.created_at })),
      jobs: repo.jobs(id), reviews: repo.reviews(id), engine: d.engines.get(shot.engine) ?? null,
    };
  };

  return {
    state: () => ({ projects: repo.projects(), engines: d.engines.all(), vocabulary: d.vocabulary, costs: repo.costs(), capabilities: d.capabilities }),
    project: (id: number) => {
      const project = repo.project(id); if (!project) throw new HttpError(404, "project not found");
      const shots = repo.shots(id);
      return { project, characters: repo.characters(id), references: repo.references(id), rules: repo.rules(id, false), shots, jobs: repo.jobs().filter((j) => shots.some((s) => s.id === j.shot_id)) };
    },
    createProject: (b: Record<string, unknown>) => { need(b["name"], "name"); return repo.createProject(b as { name: string }); },
    updateProject: (id: number, b: Record<string, unknown>) => { repo.updateProject(id, b); return repo.project(id); },
    createCharacter: (pid: number, b: Record<string, unknown>) => { need(b["name"], "name"); return repo.createCharacter({ ...b, project_id: pid } as { project_id: number; name: string }); },
    updateCharacter: (id: number, b: Record<string, unknown>) => { repo.updateCharacter(id, b); return repo.character(id); },
    /** Raw upload: the bytes become data/<project>/refs/<sha>.<ext>; the row remembers the sha. */
    addReference: (pid: number, q: URLSearchParams, bytes: Buffer) => {
      const project = repo.project(pid); if (!project) throw new HttpError(404, "project not found");
      const name = q.get("name") ?? "reference.bin"; const kind = q.get("kind") as ReferenceKind; const role = q.get("role") as ReferenceRole;
      if (!REF_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${REF_KINDS.join(", ")}`);
      if (!REF_ROLES.includes(role)) throw new HttpError(400, `role must be one of ${REF_ROLES.join(", ")}`);
      if (!bytes.length) throw new HttpError(400, "empty upload");
      const dir = join(d.dataDir, String(pid), "refs"); mkdirSync(dir, { recursive: true });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const path = join(dir, `${sha256.slice(0, 16)}${extname(name).toLowerCase() || ""}`);
      if (!existsSync(path)) writeFileSync(path, bytes);
      const cid = q.get("character_id"); const dur = q.get("duration_s");
      return repo.addReference({ project_id: pid, character_id: cid ? num(cid) : null, kind, path, role_default: role, duration_s: dur ? Number(dur) : null, sha256 });
    },
    setConsent: (id: number, b: Record<string, unknown>) => { if (!repo.reference(id)) throw new HttpError(404, "reference not found"); repo.setReferenceConsent(id, b["consent"] ?? b); return repo.reference(id); },
    addRule: (pid: number, b: Record<string, unknown>) => { need(b["text_de"], "text_de"); return repo.addRule(pid, { text_de: String(b["text_de"]), text_en: String(b["text_en"] ?? ""), severity: (b["severity"] === "warn" ? "warn" : "block") as Rule["severity"], check_type: String(b["check_type"] ?? "jev"), origin: String(b["origin"] ?? "user") }); },
    setRuleActive: (id: number, active: boolean) => { repo.setRuleActive(id, active); return { id, active }; },
    createShot: (pid: number, b: Record<string, unknown>) => { if (!repo.project(pid)) throw new HttpError(404, "project not found"); return repo.createShot({ ...b, project_id: pid } as Partial<Shot> & { project_id: number }); },
    updateShot: (id: number, b: Record<string, unknown>) => { if (!repo.shot(id)) throw new HttpError(404, "shot not found"); repo.updateShot(id, b as Partial<Shot>); return shotDetail(id); },
    shot: shotDetail,
    setShotReferences: (id: number, refs: unknown) => {
      if (!repo.shot(id)) throw new HttpError(404, "shot not found");
      if (!Array.isArray(refs)) throw new HttpError(400, "references must be a list");
      repo.setShotReferences(id, refs.map((r: Record<string, unknown>, i) => ({ reference_id: num(String(r["reference_id"])), slot: String(r["slot"] ?? `Image ${i + 1}`), role: (REF_ROLES.includes(r["role"] as ReferenceRole) ? r["role"] : "identity") as ReferenceRole, subject_label: String(r["subject_label"] ?? "") })));
      return shotDetail(id);
    },
    translate: async (pid: number) => { await service.ensureEnglish(pid); return { ok: true }; },
    draft: async (id: number) => { await service.draft(id); return shotDetail(id); },
    build: (id: number) => ({ result: service.build(id), ...shotDetail(id) }),
    gate: async (id: number) => { const run = await service.gate(id); return { ...shotDetail(id), gate_run: run }; },
    reviewFix: async (id: number) => { await service.reviewFix(id); return shotDetail(id); },
    quote: async (id: number, b: Record<string, unknown>) => service.quote(id, b["consent"]),
    approve: (jobId: number) => service.approve(jobId),
    queue: (jobId: number) => service.queue(jobId),
    poll: (jobId: number) => service.poll(jobId, { once: true }),
    jobs: () => repo.jobs(),
    review: (id: number) => { const review = repo.review(id); if (!review) throw new HttpError(404, "review not found"); return { ...review, frames: JSON.parse(review.frame_paths_json), checklist: JSON.parse(review.checklist_json), shot: repo.shot(review.shot_id), job: repo.job(review.job_id), references: repo.shotReferences(review.shot_id) }; },
    verdict: (id: number, b: Record<string, unknown>) => {
      const v = b["verdict"]; if (v !== "pass" && v !== "fail") throw new HttpError(400, "verdict must be pass or fail");
      const nr = b["new_rule"] as { text_de?: string; text_en?: string; severity?: string } | undefined;
      return service.verdict(id, v, String(b["notes"] ?? ""), Array.isArray(b["checklist"]) ? (b["checklist"] as { rule: string; pass: boolean | null }[]) : [], nr && nr.text_de ? { text_de: nr.text_de, text_en: nr.text_en ?? "", severity: nr.severity === "warn" ? "warn" : "block" } : undefined);
    },
    /** Files under data/ only; anything else is 404. */
    filePath: (rel: string): string => {
      const root = resolve(d.dataDir);
      const given = normalize(decodeURIComponent(rel));
      // Stored paths are as the service wrote them (relative to the working directory or absolute); either way they must land under data/.
      const p = resolve(given);
      if (p !== root && !p.startsWith(root + sep)) throw new HttpError(404, "not found");
      if (!existsSync(p) || !statSync(p).isFile()) throw new HttpError(404, "not found");
      return p;
    },
  };
}

export type DirectorApi = ReturnType<typeof createApi>;

export function startDirectorServer(d: ServerDeps, port: number, host = "127.0.0.1"): Server {
  const api = createApi(d);
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = req.method ?? "GET"; const p = url.pathname;
    const seg = p.split("/").filter(Boolean);
    try {
      if (m === "GET" && p === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(DIRECTOR_HTML); return; }
      if (m === "GET" && seg[0] === "files") {
        const file = api.filePath(seg.slice(1).join("/"));
        res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "content-length": statSync(file).size });
        createReadStream(file).pipe(res); return;
      }
      if (seg[0] !== "api") throw new HttpError(404, "not found");
      const body = m === "GET" ? Buffer.alloc(0) : await readBody(req);
      const b = (): Record<string, unknown> => { if (!body.length) return {}; try { return JSON.parse(body.toString("utf8")) as Record<string, unknown>; } catch { throw new HttpError(400, "invalid JSON"); } };
      const r = seg.slice(1);
      const route = `${m} ${r.map((s, i) => (i % 2 === 1 ? ":id" : s)).join("/")}`;
      const id = () => num(r[1]); const id2 = () => num(r[3]);
      let out: unknown;
      switch (route) {
        case "GET state": out = api.state(); break;
        case "POST projects": out = api.createProject(b()); break;
        case "GET projects/:id": out = api.project(id()); break;
        case "PATCH projects/:id": out = api.updateProject(id(), b()); break;
        case "POST projects/:id/characters": out = api.createCharacter(id(), b()); break;
        case "PATCH characters/:id": out = api.updateCharacter(id(), b()); break;
        case "PUT projects/:id/references": out = api.addReference(id(), url.searchParams, body); break;
        case "POST references/:id/consent": out = api.setConsent(id(), b()); break;
        case "POST projects/:id/rules": out = api.addRule(id(), b()); break;
        case "PATCH rules/:id": out = api.setRuleActive(id(), Boolean(b()["active"])); break;
        case "POST projects/:id/shots": out = api.createShot(id(), b()); break;
        case "POST projects/:id/translate": out = await api.translate(id()); break;
        case "GET shots/:id": out = api.shot(id()); break;
        case "PATCH shots/:id": out = api.updateShot(id(), b()); break;
        case "PUT shots/:id/references": out = api.setShotReferences(id(), b()["references"]); break;
        case "POST shots/:id/draft": out = await api.draft(id()); break;
        case "POST shots/:id/build": out = api.build(id()); break;
        case "POST shots/:id/gate": out = await api.gate(id()); break;
        case "POST shots/:id/review-fix": out = await api.reviewFix(id()); break;
        case "POST shots/:id/quote": out = await api.quote(id(), b()); break;
        case "GET jobs": out = api.jobs(); break;
        case "POST jobs/:id/approve": out = api.approve(id()); break;
        case "POST jobs/:id/queue": out = await api.queue(id()); break;
        case "POST jobs/:id/poll": out = await api.poll(id()); break;
        case "GET reviews/:id": out = api.review(id()); break;
        case "POST reviews/:id/verdict": out = api.verdict(id(), b()); break;
        default: void id2; throw new HttpError(404, `no route ${route}`);
      }
      json(res, 200, out);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) d.log("request failed", { method: m, path: p, message });
      json(res, status, { error: message });
    }
  });
  server.listen(port, host, () => d.log(`director on http://${host}:${port}`));
  return server;
}
