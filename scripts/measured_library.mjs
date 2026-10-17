#!/usr/bin/env node
/**
 * The measured library: brand design systems read from the live websites by Design Awesome
 * (https://github.com/plugin87/design-awesome), each passed a fidelity gate that traces every value back to the
 * measurement. Where the kit's own design-systems/library/ holds hand-written "inspired by" specs, these are
 * measured: computed styles, hover states, UX at 1280 and 390, and a build recipe.
 *
 * Every brand has three files:
 *   designs/<slug>.md         DESIGN.md: YAML tokens (colors, typography, rounded, spacing, components) + art direction
 *   ux/<slug>.md              UX.md: header, nav, first view, page structure, phone, motion, accessibility facts
 *   how-to-design/<slug>.md   HOW-TO-DESIGN.md: CSS variables, components as CSS, page skeleton, phone, motion
 *
 * Where it reads from, first match wins:
 *   1. DESIGN_LIBRARY_DIR, a folder with designs/ ux/ how-to-design/ (and industries/)
 *   2. the design-taste skill, if installed: ~/.claude/skills/design-taste (works offline)
 *   3. DESIGN_LIBRARY_URL, a deployed Design Awesome site (its /api/index.json and /api/<slug>.*.md)
 *
 * Usage:
 *   node scripts/measured_library.mjs source                  # where it reads from, and how many brands
 *   node scripts/measured_library.mjs search <term> [--industry=<name>]
 *   node scripts/measured_library.mjs show <slug> [design|ux|how]
 *   node scripts/measured_library.mjs tokens <slug> [--json]  # the brand's measured tokens mapped onto the kit's
 *                                                             # semantic roles (Library Contract), unmapped roles listed
 * Exit 2 when no source is available: nothing was read, which is not the same as "no match".
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FILES = { design: 'designs', ux: 'ux', how: 'how-to-design' };

/* ------------------------------------------------------------------ source */

export function resolveSource(env = process.env, home = homedir()) {
  const dirs = [env.DESIGN_LIBRARY_DIR, join(home, '.claude/skills/design-taste')].filter(Boolean);
  for (const d of dirs) if (existsSync(join(d, 'designs'))) return { kind: 'dir', root: d };
  if (env.DESIGN_LIBRARY_URL) return { kind: 'url', root: env.DESIGN_LIBRARY_URL.replace(/\/$/, '') };
  return null;
}

async function readText(src, rel) {
  if (src.kind === 'dir') {
    const p = join(src.root, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  const r = await fetch(`${src.root}/${rel}`);
  return r.ok ? r.text() : null;
}

/* ----------------------------------------------------- frontmatter (YAML) */
// The DESIGN.md frontmatter is generated: nested maps, scalars and quoted strings, two-space indents.
// A small parser for exactly that, so the kit gains no dependency.
export function parseFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---/.exec(md || '');
  if (!m) return {};
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const raw of m[1].split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().replace(/^["']|["']$/g, '');
    let val = line.slice(i + 1).trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (val === '') { parent[key] = {}; stack.push({ indent, obj: parent[key] }); continue; }
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    parent[key] = val;
  }
  return root;
}

/* ------------------------------------------------------------------ index */

async function index(src) {
  if (src.kind === 'url') {
    const r = await fetch(`${src.root}/api/index.json`);
    if (!r.ok) throw new Error(`${src.root}/api/index.json answered ${r.status}`);
    return (await r.json()).brands;
  }
  return indexDir(src);
}

// Folder source, synchronous (the MCP server answers synchronously). Cached per root.
const CACHE = new Map();
export function indexDir(src) {
  if (CACHE.has(src.root)) return CACHE.get(src.root);
  // Industry of each brand, from the industries/ tables (brand → file links).
  const industryOf = {};
  const ind = join(src.root, 'industries');
  if (existsSync(ind)) {
    for (const f of readdirSync(ind).filter((x) => x.endsWith('.md'))) {
      const t = readFileSync(join(ind, f), 'utf8');
      const name = (/^# (.+?) — /m.exec(t) || /^# (.+)$/m.exec(t) || [, f])[1].trim();
      for (const m of t.matchAll(/designs\/([a-z0-9-]+)\.md/g)) industryOf[m[1]] ??= name;
    }
  }
  const list = readdirSync(join(src.root, 'designs')).filter((f) => f.endsWith('.md')).map((f) => {
    const slug = f.slice(0, -3);
    const fm = parseFrontmatter(readFileSync(join(src.root, 'designs', f), 'utf8').slice(0, 6000));
    return {
      slug,
      name: fm.name || slug,
      industry: industryOf[slug] || null,
      description: fm.description || '',
      primary: fm.colors?.primary ?? null,
      canvas: fm.colors?.canvas ?? null,
      files: Object.keys(FILES).filter((k) => existsSync(join(src.root, FILES[k], f))),
    };
  });
  CACHE.set(src.root, list);
  return list;
}

export async function search(src, term = '', industry = '') {
  return filter(await index(src), term, industry);
}
export const searchDir = (src, term = '', industry = '') => filter(indexDir(src), term, industry);
function filter(all, term, industry) {
  const t = String(term).toLowerCase(), ind = String(industry).toLowerCase();
  return all
    .filter((b) => (!t || b.slug.includes(t) || b.name.toLowerCase().includes(t) || b.description.toLowerCase().includes(t)) && (!ind || (b.industry || '').toLowerCase().includes(ind)))
    .sort((a, b) => (a.slug === t ? -1 : b.slug === t ? 1 : a.name.localeCompare(b.name)));
}

export function getDir(src, slug, which = 'design') {
  if (!/^[a-z0-9-]+$/.test(slug) || !FILES[which]) return null;
  const p = join(src.root, FILES[which], `${slug}.md`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

export async function get(src, slug, which = 'design') {
  if (!/^[a-z0-9-]+$/.test(slug) || !FILES[which]) return null;
  if (src.kind === 'dir') return getDir(src, slug, which);
  const rel = src.kind === 'dir' ? `${FILES[which]}/${slug}.md` : `api/${slug}${which === 'design' ? '' : `.${which}`}.md`;
  return readText(src, rel);
}

/* ------------------------------------------------- Library Contract mapping */
// Measured colour keys → the kit's semantic roles. A measured value is used verbatim; a role with no measured
// value keeps the kit default and is listed, so nothing is silently invented.
const ROLE_MAP = [
  ['action.primary', ['primary', 'brand', 'accent', 'cta']],
  ['action.primary-hover', ['primary-hover', 'primary-dark', 'brand-hover']],
  ['action.primary-active', ['primary-pressed', 'primary-active']],
  ['text.on-action', ['on-primary', 'on-brand', 'on-accent']],
  ['surface.page', ['canvas', 'background', 'page', 'bg']],
  ['surface.card', ['surface', 'card', 'surface-card', 'panel']],
  ['surface.sunken', ['surface-quiet', 'surface-muted', 'surface-subtle', 'surface-2', 'surface-alt']],
  ['text.primary', ['ink', 'text', 'foreground', 'heading']],
  ['text.secondary', ['ink-body', 'body', 'ink-muted', 'text-muted', 'muted']],
  ['text.tertiary', ['ink-subtle', 'ink-faint', 'text-subtle']],
  ['text.link', ['link', 'link-color']],
  ['border.default', ['hairline', 'border', 'surface-border', 'divider', 'outline']],
];

export function mapTokens(design) {
  const fm = parseFrontmatter(design);
  const colors = fm.colors || {};
  const keys = Object.keys(colors);
  const semantic = {}, unmapped = [];
  for (const [role, names] of ROLE_MAP) {
    const k = names.find((n) => keys.includes(n));
    if (k) semantic[role] = { $type: 'color', $value: colors[k], $description: `measured: colors.${k}` };
    else unmapped.push(role);
  }
  const used = new Set(Object.values(semantic).map((v) => v.$description.slice('measured: colors.'.length)));
  return {
    name: fm.name,
    semantic,
    unmapped,
    extraColors: Object.fromEntries(keys.filter((k) => !used.has(k)).map((k) => [k, colors[k]])),
    typography: fm.typography || {},
    rounded: fm.rounded || {},
    spacing: fm.spacing || {},
    components: Object.keys(fm.components || {}),
  };
}

/* -------------------------------------------------------------------- CLI */

async function main(argv) {
  const [cmd, a, b] = argv.filter((x) => !x.startsWith('--'));
  const flag = (k) => argv.find((x) => x.startsWith(`--${k}=`))?.slice(k.length + 3);
  const src = resolveSource();
  if (!src) {
    console.log('No measured library found. Install the design-taste skill, or set DESIGN_LIBRARY_DIR or DESIGN_LIBRARY_URL.');
    console.log('Nothing was read: this is not "no match".');
    return 2;
  }
  if (cmd === 'source' || !cmd) {
    const all = await index(src);
    console.log(`${src.kind === 'dir' ? 'folder' : 'site'}: ${src.root}\n${all.length} measured brands · ${all.filter((x) => x.files.includes('ux')).length} with UX.md · ${all.filter((x) => x.files.includes('how')).length} with HOW-TO-DESIGN.md`);
    return 0;
  }
  if (cmd === 'search') {
    const hits = await search(src, a || '', flag('industry') || '');
    for (const h of hits.slice(0, 40)) console.log(`${h.slug.padEnd(34)} ${String(h.primary || '').padEnd(10)} ${(h.industry || '').padEnd(28)} ${h.name}`);
    console.log(`\n${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length > 40 ? ' (first 40 shown)' : ''}.`);
    return 0;
  }
  if (cmd === 'show') {
    const t = await get(src, a, b || 'design');
    if (!t) { console.log(`No ${b || 'design'} file for "${a}". Try: node scripts/measured_library.mjs search ${a}`); return 1; }
    process.stdout.write(t);
    return 0;
  }
  if (cmd === 'tokens') {
    const t = await get(src, a, 'design');
    if (!t) { console.log(`No measured brand "${a}".`); return 1; }
    const m = mapTokens(t);
    if (argv.includes('--json')) { console.log(JSON.stringify(m, null, 2)); return 0; }
    console.log(`${m.name}: measured values mapped onto the kit's semantic roles\n`);
    for (const [role, v] of Object.entries(m.semantic)) console.log(`  ${role.padEnd(24)} ${v.$value.padEnd(12)} ${v.$description}`);
    if (m.unmapped.length) console.log(`\n  not measured, kit default kept: ${m.unmapped.join(', ')}`);
    console.log(`\n  typography styles: ${Object.keys(m.typography).join(', ') || 'none'}\n  radius: ${Object.entries(m.rounded).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}\n  components: ${m.components.join(', ') || 'none'}`);
    console.log('\nNext: re-run contrast on every mapped pair (scripts/contrast.py). A measured brand value that fails AA is adjusted, and the adjustment is stated.');
    return 0;
  }
  console.log('Usage: measured_library.mjs source | search <term> [--industry=x] | show <slug> [design|ux|how] | tokens <slug> [--json]');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main(process.argv.slice(2)));
