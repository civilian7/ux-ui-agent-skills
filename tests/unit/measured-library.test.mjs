/**
 * Unit layer: scripts/measured_library.mjs against a two-brand fixture library, so it runs without the
 * design-taste skill installed. Covers the source order, search, show, the role mapping and the exit codes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { node, ROOT } from '../helpers/run.mjs';
import { parseFrontmatter, mapTokens, resolveSource, searchDir, getDir } from '../../scripts/measured_library.mjs';

const LIB = join(ROOT, 'tests/fixtures/measured-library');
const SRC = { kind: 'dir', root: LIB };
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'ml-home-'));
const ml = (args, env = {}) => node('measured_library.mjs', args, { env: { HOME: EMPTY_HOME, DESIGN_LIBRARY_DIR: LIB, ...env } });

test('DESIGN_LIBRARY_DIR wins over the installed skill, and a URL is the last resort', () => {
  assert.deepEqual(resolveSource({ DESIGN_LIBRARY_DIR: LIB, DESIGN_LIBRARY_URL: 'https://x.test/' }, EMPTY_HOME), SRC);
  // A folder without designs/ is not a source; the URL is used, without its trailing slash.
  assert.deepEqual(resolveSource({ DESIGN_LIBRARY_DIR: EMPTY_HOME, DESIGN_LIBRARY_URL: 'https://x.test/' }, EMPTY_HOME), { kind: 'url', root: 'https://x.test' });
  assert.equal(resolveSource({}, EMPTY_HOME), null);
});

test('the frontmatter parser reads nested maps and strips quotes', () => {
  const fm = parseFrontmatter('---\nname: A\ncolors:\n  primary: "#0a5cff"\ntypography:\n  display:\n    fontSize: 56px\n---\n');
  assert.equal(fm.colors.primary, '#0a5cff');
  assert.equal(fm.typography.display.fontSize, '56px');
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});
});

test('search matches name and slug, filters by industry, and lists the files each brand has', () => {
  const all = searchDir(SRC);
  assert.equal(all.length, 2);
  const acme = all.find((b) => b.slug === 'acme-bank');
  assert.equal(acme.industry, 'Banking & Insurance');
  assert.equal(acme.primary, '#0a5cff');
  assert.deepEqual(acme.files, ['design', 'ux']);
  assert.deepEqual(searchDir(SRC, 'zed').map((b) => b.slug), ['zed-studio']);
  assert.deepEqual(searchDir(SRC, '', 'banking').map((b) => b.slug), ['acme-bank']);
});

test('show refuses a slug that is not a slug, and returns null for a missing file', () => {
  assert.equal(getDir(SRC, '../etc/passwd'), null);
  assert.equal(getDir(SRC, 'zed-studio', 'ux'), null);
  assert.match(getDir(SRC, 'acme-bank', 'ux'), /Sticky header/);
});

test('tokens maps measured colours to roles verbatim and lists the roles nothing was measured for', () => {
  const m = mapTokens(getDir(SRC, 'acme-bank'));
  assert.equal(m.semantic['action.primary'].$value, '#0a5cff');
  assert.equal(m.semantic['action.primary'].$description, 'measured: colors.primary');
  assert.equal(m.semantic['text.on-action'].$value, '#ffffff');
  assert.equal(m.semantic['surface.page'].$value, '#ffffff');
  assert.equal(m.semantic['text.primary'].$value, '#111111');
  assert.equal(m.semantic['border.default'].$value, '#e5e5e5');
  assert.ok(m.unmapped.includes('action.primary-hover'), 'no hover was measured, so none is invented');
  assert.deepEqual(m.extraColors, { promo: '#ff3366' });
  assert.deepEqual(m.components, ['button-primary']);
});

test('CLI: exit 0 on a hit, 1 on an unknown brand, 2 when there is no library at all', () => {
  assert.equal(ml(['show', 'acme-bank', 'ux']).status, 0);
  assert.equal(ml(['show', 'nope']).status, 1);
  const none = ml(['source'], { DESIGN_LIBRARY_DIR: '' });
  assert.equal(none.status, 2, none.out);
  assert.match(none.stdout, /not "no match"/);
  const t = ml(['tokens', 'acme-bank']);
  assert.equal(t.status, 0);
  assert.match(t.stdout, /not measured, kit default kept: .*action\.primary-hover/);
});
