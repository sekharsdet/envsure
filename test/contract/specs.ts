// Official API descriptions, normalized so recorded mock exchanges can be checked against them:
// the method/path must exist, query parameters must be declared, response bodies must match the
// documented types, and every field in a mock response must be documented (so a connector cannot
// depend on a field the real API does not return). Mocks are partial, so `required` is not enforced.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

// ajv ships CommonJS; under NodeNext the class is on `.default`.
const Ajv2020 = Ajv2020Module.default;

const AZURE = "https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/specification";
export const SPEC_URLS = {
  vercel: "https://openapi.vercel.sh/",
  render: "https://api-docs.render.com/openapi/render-public-api-1.json",
  netlify: "https://raw.githubusercontent.com/netlify/open-api/master/swagger.yml",
  heroku: "https://api.heroku.com/schema",
  fly: "https://docs.machines.dev/openapi.json",
  cloudflare: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
  digitalocean: "https://api-engineering.nyc3.cdn.digitaloceanspaces.com/spec-ci/DigitalOcean-public.v2.yaml",
  "gcp-secret-manager": "https://secretmanager.googleapis.com/$discovery/rest?version=v1",
  "gcp-cloud-run": "https://run.googleapis.com/$discovery/rest?version=v2",
  "azure-keyvault": `${AZURE}/keyvault/data-plane/Legacy/stable/7.4/secrets.json`,
  "azure-appservice": `${AZURE}/web/resource-manager/Microsoft.Web/AppService/stable/2023-12-01/WebApps.json`,
} as const;
export type SpecName = keyof typeof SPEC_URLS;

const CACHE = fileURLToPath(new URL("../../.cache/specs/", import.meta.url));

/** Download (or read the cached copy of) a document. CI caches `.cache/specs` per week. */
async function fetchDoc(url: string): Promise<any> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, createHash("sha1").update(url).digest("hex").slice(0, 16) + ".txt");
  const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < 6 * 24 * 3600 * 1000;
  let text: string;
  if (fresh) text = readFileSync(file, "utf8");
  else {
    let error = "";
    let downloaded: string | undefined;
    for (let attempt = 0; attempt < 4 && downloaded === undefined; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
      try {
        const res = await fetch(url, {
          headers: url.startsWith("https://api.heroku.com") ? { Accept: "application/vnd.heroku+json; version=3" } : {},
        });
        if (res.ok) downloaded = await res.text();
        else error = `HTTP ${res.status}`;
      } catch (err) {
        error = (err as Error).message;
      }
    }
    if (downloaded !== undefined) writeFileSync(file, (text = downloaded));
    else if (existsSync(file)) {
      // Publisher temporarily down: keep testing against the last good copy.
      console.warn(`warning: downloading ${url} failed (${error}); using cached copy`);
      text = readFileSync(file, "utf8");
    } else throw new Error(`downloading ${url}: ${error}`);
  }
  return text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: -1 });
}

export interface Operation {
  method: string;
  template: string;
  regex: RegExp;
  query: Set<string>;
  /** Absolute ref (`<doc url>#<pointer>`) of the success response schema. */
  responseRef?: string;
}

export interface Contract {
  name: SpecName;
  operations: Operation[];
  find(method: string, path: string): Operation | undefined;
  /** Problems with an exchange, empty when it conforms. */
  check(ex: { method: string; path: string; query: string[]; status?: number; response?: unknown }): string[];
}

const esc = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
function templateRegex(template: string): RegExp {
  let re = "";
  for (const part of template.split(/(\{[^}]*\})/)) {
    if (!part) continue;
    if (part.startsWith("{")) re += part.startsWith("{+") ? ".+" : "[^/]+";
    else re += esc(part);
  }
  return new RegExp(`^${re}/?$`);
}
const ptr = (...parts: string[]) => "/" + parts.map((p) => p.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");

const DROP = new Set(["discriminator", "example", "examples", "xml", "exclusiveMinimum", "exclusiveMaximum", "format",
  "pattern", "required", "nullable", "x-nullable", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"]);

/** JSON Schema 2020-12 view of an OpenAPI/Swagger/discovery document, with absolute `$ref`s. */
function normalize(doc: any, url: string, style: "openapi" | "discovery"): any {
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "oneOf") out.anyOf = walk(v); // overlapping oneOf branches are common in specs
      else if (k === "$ref" && typeof v === "string") {
        out.$ref = style === "discovery" && !v.includes("#") ? `${url}#/schemas/${v}` : new URL(v, url).href;
      } else if (k === "id" && style === "discovery" && typeof v === "string") {
        // discovery schema names, not JSON Schema ids
      } else if (!DROP.has(k)) out[k] = walk(v);
    }
    if (out.type === "any" || out.type === "file") delete out.type;
    const nullable = node.nullable === true || node["x-nullable"] === true;
    if (nullable && out.type) out.type = [...[out.type].flat(), "null"];
    if (nullable && out.$ref) return { anyOf: [{ $ref: out.$ref }, { type: "null" }] };
    return out;
  };
  return walk(doc);
}

/** Loads a spec plus every external file its `$ref`s point to. */
async function loadDocs(url: string, style: "openapi" | "discovery"): Promise<Map<string, any>> {
  const docs = new Map<string, any>();
  const pending = [url];
  while (pending.length) {
    const u = pending.pop()!;
    if (docs.has(u)) continue;
    const doc = normalize(await fetchDoc(u), u, style);
    docs.set(u, doc);
    const refs = new Set<string>();
    (function collect(n: any) {
      if (Array.isArray(n)) n.forEach(collect);
      else if (n && typeof n === "object") {
        if (typeof n.$ref === "string") refs.add(n.$ref.split("#")[0]);
        Object.values(n).forEach(collect);
      }
    })(doc);
    for (const r of refs) if (r && !docs.has(r)) pending.push(r);
  }
  return docs;
}

function resolver(docs: Map<string, any>) {
  return (ref: string): any => {
    const [file, pointer = ""] = ref.split("#");
    return pointer.split("/").slice(1).map((s) => decodeURIComponent(s).replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((o: any, k) => o?.[k], docs.get(file));
  };
}

/**
 * Fields in `data` that the schema does not document. Properties are unioned across
 * allOf/anyOf branches; an object schema without `properties` (or with additionalProperties)
 * accepts any key.
 */
export function undocumentedFields(schemaRef: string, data: unknown, resolve: (ref: string) => any): string[] {
  const found: string[] = [];
  const expand = (s: any, seen: Set<string>): any[] => {
    if (!s || typeof s !== "object") return [{}];
    if (s.$ref) {
      if (seen.has(s.$ref)) return [];
      const next = new Set(seen).add(s.$ref);
      const { $ref, ...rest } = s;
      return [...expand(resolve($ref), next), ...(Object.keys(rest).length ? expand(rest, next) : [])];
    }
    const parts = [s, ...(s.allOf ?? []), ...(s.anyOf ?? [])].filter((x, i) => i === 0 || x);
    return [s, ...parts.slice(1).flatMap((p: any) => expand(p, seen))];
  };
  const visit = (schemas: any[], value: unknown, path: string) => {
    if (Array.isArray(value)) {
      const items = schemas.flatMap((s) => (s.items ? expand(s.items, new Set()) : []));
      if (items.length) value.forEach((v, i) => visit(items, v, `${path}/${i}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const withProps = schemas.filter((s) => s.properties);
    const open = schemas.some((s) => s.additionalProperties || s.patternProperties) || withProps.length === 0;
    for (const [key, v] of Object.entries(value)) {
      const children = withProps.filter((s) => key in s.properties).flatMap((s) => expand(s.properties[key], new Set()));
      const extra = schemas.filter((s) => s.additionalProperties && typeof s.additionalProperties === "object")
        .flatMap((s) => expand(s.additionalProperties, new Set()));
      if (!children.length && !open) found.push(`${path}/${key}`);
      else visit([...children, ...extra], v, `${path}/${key}`);
    }
  };
  visit(expand({ $ref: schemaRef }, new Set()), data, "");
  return found;
}

function contract(name: SpecName, docs: Map<string, any>, operations: Operation[]): Contract {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  for (const [id, doc] of docs) ajv.addSchema({ ...doc, $id: id }, id);
  const resolve = resolver(docs);
  const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
  const validate = (ref: string, data: unknown): string[] => {
    let v = compiled.get(ref);
    if (!v) compiled.set(ref, (v = ajv.compile({ $ref: ref })));
    return v(data) ? [] : (v.errors ?? []).slice(0, 8).map((e: { instancePath: string; message?: string }) =>
      `${e.instancePath || "(root)"} ${e.message}`);
  };
  const find = (method: string, path: string) => operations.find((o) => o.method === method && o.regex.test(path));
  return {
    name,
    operations,
    find,
    check(ex) {
      const op = find(ex.method, ex.path);
      if (!op) return [`${ex.method} ${ex.path} is not an operation in the official ${name} API`];
      const at = `(${op.method} ${op.template})`;
      const problems = ex.query.filter((q) => !op.query.has(q)).map((q) => `query parameter "${q}" is not declared ${at}`);
      if (ex.status && ex.status < 300 && op.responseRef && ex.response !== undefined) {
        problems.push(...validate(op.responseRef, ex.response).map((e) => `response ${e} ${at}`));
        problems.push(...undocumentedFields(op.responseRef, ex.response, resolve).map((f) => `response field ${f} is not documented ${at}`));
      }
      return problems;
    },
  };
}

const METHODS = ["get", "post", "put", "patch", "delete"];

/** OpenAPI 3.x and Swagger 2. */
async function openapi(name: SpecName, url: string): Promise<Contract> {
  const docs = await loadDocs(url, "openapi");
  const doc = docs.get(url);
  const resolve = resolver(docs);
  const deref = (p: any) => (p?.$ref ? resolve(p.$ref) : p);
  let base = "";
  if (doc.basePath) base = doc.basePath === "/" ? "" : doc.basePath;
  else if (doc.servers?.[0]?.url) base = new URL(doc.servers[0].url.replace(/\{[^}]+\}/g, "x"), "https://x").pathname.replace(/\/$/, "");
  const ops: Operation[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref);
      const ok = ["200", "201", "2XX", "default"].find((s) => op.responses?.[s]);
      let responseRef: string | undefined;
      if (ok) {
        const resp = op.responses[ok];
        const respRef = resp.$ref ?? `${url}#${ptr("paths", path, method, "responses", ok)}`;
        const r = deref(resp);
        if (r?.content) {
          const type = Object.keys(r.content).find((t) => t.includes("json"));
          if (type && r.content[type].schema) responseRef = `${respRef}/content/${type.replace(/~/g, "~0").replace(/\//g, "~1")}/schema`;
        } else if (r?.schema) responseRef = `${respRef}/schema`;
      }
      const template = base + path;
      ops.push({
        method: method.toUpperCase(), template, regex: templateRegex(template),
        query: new Set(params.filter((p: any) => p?.in === "query").map((p: any) => p.name)), responseRef,
      });
    }
  }
  return contract(name, docs, ops);
}

/** Google API discovery documents. */
async function discovery(name: SpecName, url: string): Promise<Contract> {
  const docs = await loadDocs(url, "discovery");
  const doc = docs.get(url);
  const global = Object.keys(doc.parameters ?? {});
  const ops: Operation[] = [];
  const visit = (resources: any) => {
    for (const res of Object.values<any>(resources ?? {})) {
      for (const m of Object.values<any>(res.methods ?? {})) {
        const template = "/" + (doc.servicePath ?? "") + m.path;
        const flat = "/" + (doc.servicePath ?? "") + m.flatPath.replace(/^\//, "");
        const query = Object.entries<any>(m.parameters ?? {}).filter(([, p]) => p.location === "query").map(([k]) => k);
        ops.push({ method: m.httpMethod, template, regex: templateRegex(flat), query: new Set([...global, ...query]),
          responseRef: m.response?.$ref });
      }
      visit(res.resources);
    }
  };
  visit(doc.resources);
  return contract(name, docs, ops);
}

/** Heroku's JSON hyper-schema: links with `href` templates (no response schemas used). */
async function heroku(url: string): Promise<Contract> {
  const raw = await fetchDoc(url);
  const ops: Operation[] = [];
  for (const def of Object.values<any>(raw.definitions ?? {})) {
    for (const link of def.links ?? []) {
      const template = decodeURIComponent(link.href).replace(/\{\([^)]*\)\}/g, "{id}");
      ops.push({ method: link.method, template, regex: templateRegex(template), query: new Set() });
    }
  }
  return contract("heroku", new Map(), ops);
}

export function loadContract(name: SpecName): Promise<Contract> {
  const url = SPEC_URLS[name];
  if (name === "heroku") return heroku(url);
  if (name === "gcp-secret-manager" || name === "gcp-cloud-run") return discovery(name, url);
  return openapi(name, url);
}
