import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Generates the architecture diagrams in docs/diagrams/, one SVG per diagram. Each SVG is
// drawn in the light colours and switches itself to the dark colours when the viewer prefers
// a dark theme, so a plain Markdown image works in GitHub, VS Code and anywhere else.
// Run: npm run diagrams. Change the diagram data below, never the SVG files.

type Theme = {
  name: 'light' | 'dark';
  bg: string;
  ink: string; // main text
  muted: string; // secondary text
  box: { fill: string; stroke: string };
  main: { fill: string; stroke: string }; // the API
  db: { fill: string; stroke: string };
  ok: string;
  err: string;
};

const LIGHT: Theme = {
  name: 'light',
  bg: '#ffffff',
  ink: '#1f2633',
  muted: '#66708a',
  box: { fill: '#fdfdff', stroke: '#7d88a6' }, // not #ffffff: every light colour must be unique (see darkModeStyle)
  main: { fill: '#eef2ff', stroke: '#3b5bdb' },
  db: { fill: '#e7f6f8', stroke: '#0b7285' },
  ok: '#2b8a3e',
  err: '#c92a2a',
};

const DARK: Theme = {
  name: 'dark',
  bg: '#0d1117',
  ink: '#e6edf3',
  muted: '#8b95ad',
  box: { fill: '#161b26', stroke: '#5d6782' },
  main: { fill: '#1a2240', stroke: '#7c95f5' },
  db: { fill: '#102a30', stroke: '#4fc1d1' },
  ok: '#57c26f',
  err: '#f07070',
};

const FONT = "'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif";
const MONO = 'ui-monospace, SFMono-Regular, Consolas, monospace';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Style = 'box' | 'main' | 'db';
type TextOpts = { size?: number; bold?: boolean; color?: string; anchor?: string; mono?: boolean };

// ---------------------------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------------------------

class Svg {
  readonly t: Theme;
  private out: string[] = [];

  constructor(t: Theme) {
    this.t = t;
  }

  text(x: number, y: number, s: string, o: TextOpts = {}) {
    this.out.push(
      `<text x="${x}" y="${y}" font-family="${o.mono ? MONO : FONT}" font-size="${o.size ?? 13}"` +
        ` font-weight="${o.bold ? 600 : 400}" fill="${o.color ?? this.t.ink}" text-anchor="${o.anchor ?? 'middle'}">${esc(s)}</text>`,
    );
  }

  rect(x: number, y: number, w: number, h: number, style: Style, o: { dash?: boolean; rx?: number; stroke?: string } = {}) {
    const c = this.t[style];
    this.out.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 6}" fill="${c.fill}" stroke="${o.stroke ?? c.stroke}"` +
        ` stroke-width="1.5"${o.dash ? ' stroke-dasharray="6 4"' : ''}/>`,
    );
  }

  /** A box with a bold name and up to two smaller lines, all centred. */
  box(x: number, y: number, w: number, h: number, style: Style, name: string, ...lines: string[]) {
    this.rect(x, y, w, h, style);
    const top = y + h / 2 - (lines.length * 17) / 2 + 4;
    this.text(x + w / 2, top, name, { bold: true, size: 14 });
    lines.forEach((l, i) => this.text(x + w / 2, top + 19 + i * 17, l, { size: 12, color: this.t.muted }));
  }

  /** The standard database symbol. */
  cylinder(x: number, y: number, w: number, h: number, name: string, sub: string) {
    const c = this.t.db;
    const ry = 10;
    this.out.push(
      `<path d="M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} L ${x + w} ${y + h - ry} A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z"` +
        ` fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>`,
      `<path d="M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}" fill="none" stroke="${c.stroke}" stroke-width="1.5"/>`,
    );
    this.text(x + w / 2, y + h / 2 + 6, name, { bold: true, size: 14 });
    this.text(x + w / 2, y + h / 2 + 24, sub, { size: 12, color: this.t.muted });
  }

  person(cx: number, cy: number, label: string) {
    const s = this.t.box.stroke;
    this.out.push(
      `<circle cx="${cx}" cy="${cy - 26}" r="11" fill="${this.t.box.fill}" stroke="${s}" stroke-width="1.5"/>`,
      `<path d="M ${cx - 22} ${cy + 18} Q ${cx - 22} ${cy - 10} ${cx} ${cy - 10} Q ${cx + 22} ${cy - 10} ${cx + 22} ${cy + 18} Z"` +
        ` fill="${this.t.box.fill}" stroke="${s}" stroke-width="1.5"/>`,
    );
    this.text(cx, cy + 38, label, { bold: true, size: 14 });
  }

  /** Arrow through the given points, with an optional label on a background patch. */
  arrow(points: [number, number][], o: { label?: string; color?: string; dash?: boolean; labelAt?: [number, number] } = {}) {
    const color = o.color ?? this.t.muted;
    const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ');
    this.out.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"${o.dash ? ' stroke-dasharray="6 4"' : ''}` +
        ` marker-end="url(#head-${this.markerFor(color)})"/>`,
    );
    if (o.label) {
      const [a, b] = [points[0]!, points[1]!];
      const [lx, ly] = o.labelAt ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.patch(lx, ly, o.label, { size: 12, color: o.color === undefined ? this.t.ink : color });
    }
  }

  /** Centred text on a background patch, so lines behind it don't cut through. */
  patch(x: number, y: number, s: string, o: TextOpts = {}) {
    const w = s.length * ((o.size ?? 13) * (o.mono ? 0.6 : 0.55)) + 12;
    this.out.push(`<rect x="${x - w / 2}" y="${y - 10}" width="${w}" height="20" fill="${this.t.bg}"/>`);
    this.text(x, y + 4, s, o);
  }

  line(x1: number, y1: number, x2: number, y2: number, color = this.t.muted, dash = false) {
    this.out.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5"${dash ? ' stroke-dasharray="4 4"' : ''}/>`,
    );
  }

  raw(s: string) {
    this.out.push(s);
  }

  private markerFor(color: string): string {
    return color === this.t.ok ? 'ok' : color === this.t.err ? 'err' : color === this.t.main.stroke ? 'main' : 'muted';
  }

  render(w: number, h: number, title: string, desc: string): string {
    const heads = { ok: this.t.ok, err: this.t.err, main: this.t.main.stroke, muted: this.t.muted };
    const defs = Object.entries(heads)
      .map(
        ([id, c]) =>
          `<marker id="head-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`,
      )
      .join('');
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="title desc">`,
      `<title id="title">${esc(title)}</title>`,
      `<desc id="desc">${esc(desc)}</desc>`,
      `<defs>${defs}</defs>`,
      `<rect width="${w}" height="${h}" fill="${this.t.bg}"/>`,
      ...this.out,
      '</svg>',
      '',
    ].join('\n');
  }
}

// ---------------------------------------------------------------------------------------------
// 1. System overview
// ---------------------------------------------------------------------------------------------

function systemOverview(t: Theme): string {
  const s = new Svg(t);
  s.person(70, 150, 'HR user');
  s.box(170, 60, 190, 76, 'box', 'Web page', 'React + Vite (optional)');
  s.box(170, 170, 190, 76, 'box', 'API clients', 'curl, tests');
  s.box(450, 104, 220, 96, 'main', 'Probation API', 'Node.js 24 + Express 5', 'rules and transactions');
  s.cylinder(760, 102, 150, 100, 'Database', 'PostgreSQL 17');

  s.arrow([[100, 120], [168, 100]], { label: 'uses' });
  s.arrow([[360, 98], [448, 140]], { label: 'JSON' });
  s.arrow([[360, 208], [448, 168]], { label: 'JSON' });
  s.arrow([[670, 152], [758, 152]], { label: 'SQL' });

  return s.render(940, 280, 'System overview', 'An HR user works through the optional React web page; other clients such as curl and the tests call the API directly. Both send JSON over HTTP to the Probation API (Node.js and Express), which stores everything in PostgreSQL.');
}

// ---------------------------------------------------------------------------------------------
// 2. API layers (with the real file names)
// ---------------------------------------------------------------------------------------------

function apiLayers(t: Theme): string {
  const s = new Svg(t);
  const X = 60;
  const W = 300;
  const layers: [string, string, string][] = [
    ['Middleware', 'tenant.ts', 'company + user from headers'],
    ['Routes', 'employees/routes.ts', 'validate input (Zod)'],
    ['Service', 'employees/service.ts', 'rules, transactions, audit'],
    ['Repository', 'employees/repository.ts', 'SQL, scoped by company_id'],
  ];
  layers.forEach(([name, file, what], i) => {
    const y = 30 + i * 100;
    s.box(X, y, W, 72, 'main', name, file, what);
    if (i < layers.length - 1) s.arrow([[X + W / 2, y + 72], [X + W / 2, y + 98]]);
  });
  s.arrow([[X + W / 2, 30 + 3 * 100 + 72], [X + W / 2, 428]]);
  s.cylinder(X + W / 2 - 80, 430, 160, 86, 'Database', 'PostgreSQL');

  s.box(450, 30, 220, 72, 'box', 'Error handler', 'error-handler.ts', 'errors → JSON');
  s.arrow([[X + W, 66], [448, 66]], { label: 'any error', dash: true });
  s.box(450, 230, 220, 72, 'box', 'Domain', 'domain/probation.ts', 'pure rules, no I/O');
  s.arrow([[X + W, 266], [448, 266]], { label: 'uses', dash: true });

  return s.render(720, 546, 'API layers', 'Requests pass down through four layers: middleware (tenant.ts) reads the company and user from headers, routes (routes.ts) validate input with Zod, the service (service.ts) applies rules inside transactions and writes the audit trail, and the repository (repository.ts) runs SQL scoped by company_id. The service uses pure rules in domain/probation.ts. Any error goes to error-handler.ts, which returns JSON.');
}

// ---------------------------------------------------------------------------------------------
// 3. Error map: which stage produces which status code
// ---------------------------------------------------------------------------------------------

function errorMap(t: Theme): string {
  const s = new Svg(t);
  const colX = (i: number) => 170 + i * 210;
  const CW = 196;
  const stages: { name: string; sub: string; style: Style; codes: string[] }[] = [
    { name: 'express.json()', sub: 'parse body', style: 'main', codes: ['400 INVALID_JSON', '413 INVALID_REQUEST'] },
    { name: 'tenantMiddleware', sub: 'check headers', style: 'main', codes: ['401 UNAUTHENTICATED'] },
    { name: 'routes', sub: 'validate (Zod)', style: 'main', codes: ['400 VALIDATION_ERROR', '404 EMPLOYEE_NOT_FOUND'] },
    { name: 'service', sub: 'business rules', style: 'main', codes: ['404 EMPLOYEE_NOT_FOUND', '409 ALREADY_CONFIRMED', '422 MAX_PROBATION_EXCEEDED'] },
    { name: 'PostgreSQL', sub: 'constraints', style: 'db', codes: ['422 CONSTRAINT_VIOLATION', '500 INTERNAL_ERROR'] },
  ];

  s.box(20, 70, 120, 60, 'box', 'Client');
  s.arrow([[140, 100], [colX(0) - 2, 100]]);
  // Success comes back from the route handler.
  const routeMid = colX(2) + CW / 2;
  s.arrow([[routeMid, 70], [routeMid, 40], [80, 40], [80, 68]], { color: t.ok, label: '200 / 201', labelAt: [400, 40] });

  const CHIP_Y = 162;
  let lowest = 0;
  stages.forEach((st, i) => {
    const x = colX(i);
    s.box(x, 70, CW, 60, st.style, st.name, st.sub);
    if (i < stages.length - 1) s.arrow([[x + CW, 100], [colX(i + 1) - 2, 100]]);
    st.codes.forEach((code, j) => {
      const y = CHIP_Y + j * 38;
      s.raw(`<rect x="${x}" y="${y}" width="${CW}" height="28" rx="14" fill="${t.bg}" stroke="${t.err}" stroke-width="1.5"/>`);
      s.text(x + CW / 2, y + 18, code, { size: 11.5, mono: true, color: t.err, bold: true });
      lowest = Math.max(lowest, y + 28);
    });
    s.line(x + CW / 2, 130, x + CW / 2, CHIP_Y, t.muted, true);
  });

  // Every error goes through errorHandler on its way back.
  const BAR_Y = lowest + 34;
  stages.forEach((st, i) => {
    const bottom = CHIP_Y + (st.codes.length - 1) * 38 + 28;
    s.arrow([[colX(i) + CW / 2, bottom], [colX(i) + CW / 2, BAR_Y - 2]]);
  });
  s.rect(colX(0), BAR_Y, colX(4) + CW - colX(0), 40, 'box');
  s.text((colX(0) + colX(4) + CW) / 2, BAR_Y + 25, 'errorHandler  →  { "error": { "code", "message" } }', { size: 13 });
  s.arrow([[colX(0), BAR_Y + 20], [80, BAR_Y + 20], [80, 132]], { color: t.err });

  return s.render(colX(4) + CW + 24, BAR_Y + 64, 'Where each response comes from', 'Requests pass express.json, tenantMiddleware, routes, service and PostgreSQL in order. The route handler returns 200 or 201. Each stage can instead fail: express.json with 400 INVALID_JSON or 413; tenantMiddleware with 401 UNAUTHENTICATED; routes with 400 VALIDATION_ERROR or 404 for a malformed id; the service with 404 EMPLOYEE_NOT_FOUND, 409 ALREADY_CONFIRMED or 422 MAX_PROBATION_EXCEEDED; PostgreSQL with 422 CONSTRAINT_VIOLATION or 500. All errors go through errorHandler, which returns a JSON error body.');
}

// ---------------------------------------------------------------------------------------------
// 4. Data model (ER diagram, crow's foot) with the key constraints
// ---------------------------------------------------------------------------------------------

function dataModel(t: Theme): string {
  const s = new Svg(t);
  const W = 300;
  const table = (x: number, y: number, name: string, cols: [string, string?][]) => {
    const h = 34 + cols.length * 22 + 8;
    s.rect(x, y, W, h, 'db', { rx: 4 });
    s.text(x + 14, y + 22, name, { bold: true, size: 14, anchor: 'start', mono: true });
    s.line(x, y + 32, x + W, y + 32, t.db.stroke);
    cols.forEach(([c, key], i) => {
      s.text(x + 14, y + 52 + i * 22, c, { size: 12.5, anchor: 'start', mono: true });
      if (key) s.text(x + W - 14, y + 52 + i * 22, key, { size: 11.5, anchor: 'end', color: t.muted, bold: true });
    });
    return h;
  };

  table(40, 40, 'companies', [['id', 'PK'], ['name']]);
  table(420, 40, 'employees', [
    ['id', 'PK'],
    ['company_id', 'FK'],
    ['name'],
    ['join_date'],
    ['total_probation_months', 'CHECK 1–6'],
    ['probation_end_date', 'generated'],
    ['status', 'CHECK'],
    ['UNIQUE (company_id, id)'],
  ]);
  table(40, 330, 'probation_extensions', [
    ['id', 'PK'],
    ['(company_id, employee_id)', 'FK'],
    ['months', 'CHECK 1–3'],
    ['reason'],
    ['actor'],
  ]);
  table(800, 330, 'audit_events', [
    ['id', 'PK'],
    ['(company_id, employee_id)', 'FK'],
    ['action'],
    ['actor'],
    ['occurred_at'],
  ]);

  // One-to-many: a bar on the "one" side, a crow's foot on the "many" side.
  const crow = (x: number, y: number, dir: 'right' | 'down') => {
    const [dx, dy] = dir === 'right' ? [1, 0] : [0, 1];
    const bx = x - dx * 14;
    const by = y - dy * 14;
    s.raw(`<path d="M ${bx} ${by} L ${x + dy * 8} ${y + dx * 8} M ${bx} ${by} L ${x} ${y} M ${bx} ${by} L ${x - dy * 8} ${y - dx * 8}" stroke="${t.muted}" stroke-width="1.5" fill="none"/>`);
  };
  const bar = (x: number, y: number) => s.line(x, y - 8, x, y + 8);

  s.raw(`<path d="M 340 74 L 420 74" stroke="${t.muted}" stroke-width="1.5" fill="none"/>`);
  bar(352, 74);
  crow(420, 74, 'right');
  s.raw(`<path d="M 420 250 L 190 250 L 190 330" stroke="${t.muted}" stroke-width="1.5" fill="none"/>`);
  bar(408, 250);
  crow(190, 330, 'down');
  s.raw(`<path d="M 720 250 L 950 250 L 950 330" stroke="${t.muted}" stroke-width="1.5" fill="none"/>`);
  bar(732, 250);
  crow(950, 330, 'down');

  return s.render(1140, 490, 'Data model', 'Entity-relationship diagram. A company has many employees; an employee has many probation extensions and many audit events. employees has CHECK 1 to 6 on total_probation_months, a generated probation_end_date, a status CHECK, and UNIQUE (company_id, id). probation_extensions and audit_events reference employees through the composite foreign key (company_id, employee_id), so they always belong to the same company as their employee. Extension months have CHECK 1 to 3.');
}

// ---------------------------------------------------------------------------------------------
// 5. Employee lifecycle (UML state diagram)
// ---------------------------------------------------------------------------------------------

function lifecycle(t: Theme): string {
  const s = new Svg(t);
  s.raw(`<circle cx="50" cy="130" r="9" fill="${t.ink}"/>`);
  s.arrow([[60, 130], [178, 130]], { label: 'add employee', labelAt: [119, 110] });
  s.rect(180, 96, 190, 68, 'main', { rx: 22 });
  s.text(275, 135, 'On probation', { bold: true, size: 15 });
  s.rect(560, 96, 190, 68, 'main', { rx: 22 });
  s.text(655, 135, 'Confirmed', { bold: true, size: 15 });
  s.arrow([[370, 130], [558, 130]], { label: 'confirm', labelAt: [464, 110] });

  // extend: self-transition
  s.raw(`<path d="M 240 96 C 240 30, 310 30, 310 94" fill="none" stroke="${t.muted}" stroke-width="1.5" marker-end="url(#head-muted)"/>`);
  s.text(275, 32, 'extend [total ≤ 6 months]', { size: 12 });

  // Rejected requests: the state does not change.
  s.text(275, 190, 'extend over 6 → 422', { size: 12, color: t.err });
  s.text(655, 190, 'confirm / extend → 409', { size: 12, color: t.err });

  return s.render(800, 214, 'Employee lifecycle', 'State diagram. Adding an employee starts them in On probation. Extending keeps them On probation while the total stays at or below 6 months; an extension over 6 is rejected with 422. Confirming moves them to Confirmed; confirming or extending a confirmed employee is rejected with 409.');
}

// ---------------------------------------------------------------------------------------------
// 6. Company isolation: in the app and in the database
// ---------------------------------------------------------------------------------------------

function isolation(t: Theme): string {
  const s = new Svg(t);
  s.box(30, 110, 190, 70, 'box', 'Request', 'X-Company-Id: A');
  s.box(300, 110, 220, 70, 'main', 'Probation API', 'WHERE company_id = A');

  s.rect(600, 30, 320, 270, 'db', { rx: 8 });
  s.text(760, 56, 'Database', { bold: true, size: 14 });
  s.rect(620, 74, 280, 72, 'box');
  s.text(760, 104, 'Company A employees', { bold: true });
  s.text(760, 124, 'returned', { size: 12, color: t.ok });
  s.rect(620, 164, 280, 72, 'box', { dash: true });
  s.text(760, 194, 'Company B employees', { bold: true, color: t.muted });
  s.text(760, 214, '404, as if they did not exist', { size: 12, color: t.err });
  s.text(760, 272, 'FK (company_id, employee_id)', { size: 12, mono: true });
  s.text(760, 289, 'blocks cross-company rows', { size: 12, color: t.muted });

  s.arrow([[220, 145], [298, 145]]);
  s.arrow([[520, 135], [618, 110]], { color: t.ok });

  return s.render(950, 320, 'Company isolation', 'A request carries the caller company id in the X-Company-Id header. The API adds WHERE company_id = A to every query, so only Company A employees are returned; asking for a Company B employee gives 404, as if it did not exist. In the database, the composite foreign key (company_id, employee_id) blocks extension or audit rows that point at another company’s employee.');
}

// ---------------------------------------------------------------------------------------------
// Sequence diagrams (UML): participants, lifelines, messages, replies, alt frames, notes,
// and activation bars for waiting.
// ---------------------------------------------------------------------------------------------

type Msg =
  | { from: number; to: number; label: string; reply?: boolean; color?: 'ok' | 'err' }
  | { self: number; label: string }
  | { note: number; label: string; color?: 'ok' | 'err' }
  | { alt: string } // starts an alt frame with this guard
  | { else: string }
  | { end: true };

function sequence(
  t: Theme,
  title: string,
  desc: string,
  participants: [string, Style][],
  steps: Msg[],
  waits: { lane: number; from: number; to: number }[] = [], // step indices
): string {
  const s = new Svg(t);
  const gap = 250;
  const x = (i: number) => 130 + i * gap;
  const W = x(participants.length - 1) + 130;

  // Layout pass (y of each step) so frames and bars can be drawn behind messages.
  let y = 110;
  const ys: number[] = [];
  for (const st of steps) {
    if ('alt' in st) y += 20;
    if ('else' in st) y += 16;
    ys.push(y);
    if ('self' in st) y += 62;
    else if ('note' in st) y += 44;
    else if ('end' in st) y += 4;
    else if (!('alt' in st) && !('else' in st)) y += 40;
  }
  const H = y + 30;

  participants.forEach(([name, style], i) => {
    s.box(x(i) - 90, 30, 180, 44, style, name);
    s.line(x(i), 74, x(i), H - 20, t.box.stroke, true);
  });

  for (const w of waits) {
    const top = ys[w.from]! + 4;
    s.raw(`<rect x="${x(w.lane) - 6}" y="${top}" width="12" height="${ys[w.to]! - top}" fill="${t.box.fill}" stroke="${t.muted}" stroke-dasharray="3 3"/>`);
  }

  // alt frames. Guards sit on a background patch so lifelines don't run through them.
  const left = x(0) - 110;
  const right = x(participants.length - 1) + 110;
  const guard = (gx: number, gy: number, label: string) => {
    s.raw(`<rect x="${gx - 4}" y="${gy - 13}" width="${label.length * 6.8 + 8}" height="18" fill="${t.bg}"/>`);
    s.text(gx, gy, label, { size: 12, anchor: 'start', color: t.muted });
  };
  steps.forEach((st, i) => {
    if ('alt' in st) {
      const top = ys[i]! - 26;
      const end = ys[steps.findIndex((e, j) => j > i && 'end' in e)]! - 22;
      s.raw(`<rect x="${left}" y="${top}" width="${right - left}" height="${end - top}" fill="none" stroke="${t.box.stroke}"/>`);
      s.text(left + 10, top + 15, 'alt', { bold: true, size: 12, anchor: 'start' });
      s.raw(`<path d="M ${left} ${top + 20} L ${left + 34} ${top + 20} L ${left + 42} ${top + 12} L ${left + 42} ${top}" fill="none" stroke="${t.box.stroke}"/>`);
      guard(left + 52, top + 15, `[${st.alt}]`);
    } else if ('else' in st) {
      const ly = ys[i]! - 26;
      s.line(left, ly, right, ly, t.box.stroke, true);
      guard(left + 10, ly + 15, `[${st.else}]`);
    }
  });

  steps.forEach((st, i) => {
    const sy = ys[i]!;
    if ('from' in st) {
      const color = st.color === 'ok' ? t.ok : st.color === 'err' ? t.err : st.reply ? t.muted : t.main.stroke;
      const dir = Math.sign(x(st.to) - x(st.from));
      s.arrow([[x(st.from), sy], [x(st.to) - dir * 2, sy]], { color, dash: st.reply });
      s.text((x(st.from) + x(st.to)) / 2, sy - 8, st.label, { size: 12.5, color: st.color ? color : t.ink });
    } else if ('self' in st) {
      const sx = x(st.self);
      s.raw(`<path d="M ${sx} ${sy} L ${sx + 40} ${sy} L ${sx + 40} ${sy + 24} L ${sx + 2} ${sy + 24}" fill="none" stroke="${t.main.stroke}" stroke-width="1.5" marker-end="url(#head-main)"/>`);
      s.text(sx + 48, sy + 16, st.label, { size: 12.5, anchor: 'start' });
    } else if ('note' in st) {
      const nx = x(st.note);
      const color = st.color === 'ok' ? t.ok : st.color === 'err' ? t.err : t.muted;
      const w = st.label.length * 7 + 24;
      s.raw(`<rect x="${nx - w / 2}" y="${sy - 4}" width="${w}" height="28" rx="4" fill="${t.bg}" stroke="${color}" stroke-width="1.5"/>`);
      s.text(nx, sy + 15, st.label, { size: 12.5, color, bold: true });
    }
  });

  return s.render(W, H, title, desc);
}

const CRUD: [string, Style][] = [['Client', 'box'], ['API', 'main'], ['PostgreSQL', 'db']];

const createSeq = (t: Theme) =>
  sequence(t, 'Add employee', 'The client posts the new employee. The API validates the input with Zod; invalid input returns 400 before anything is written. Valid input is saved in one transaction: insertEmployee (Postgres generates the end date), then an employee.created audit event, then COMMIT, and the API returns 201 Created with a Location header.',
    CRUD,
    [
      { from: 0, to: 1, label: 'POST /employees' },
      { self: 1, label: 'validate (Zod)' },
      { alt: 'valid' },
      { from: 1, to: 2, label: 'BEGIN · insertEmployee' },
      { from: 2, to: 1, label: 'row + generated end date', reply: true },
      { from: 1, to: 2, label: 'insertAuditEvent (created)' },
      { from: 1, to: 2, label: 'COMMIT' },
      { from: 1, to: 0, label: '201 Created + Location', color: 'ok' },
      { else: 'invalid' },
      { from: 1, to: 0, label: '400 VALIDATION_ERROR', color: 'err' },
      { end: true },
    ]);

const confirmSeq = (t: Theme) =>
  sequence(t, 'Confirm employee', 'The API begins a transaction and locks the employee row with lockEmployee (SELECT … FOR UPDATE). If the employee is on probation it runs markConfirmed, writes a probation.confirmed audit event, commits and returns 200. If already confirmed it rolls back with 409; if not found in this company it rolls back with 404.',
    CRUD,
    [
      { from: 0, to: 1, label: 'POST /employees/:id/confirmation' },
      { from: 1, to: 2, label: 'BEGIN · lockEmployee' },
      { from: 2, to: 1, label: 'row (SELECT … FOR UPDATE)', reply: true },
      { alt: 'on_probation' },
      { from: 1, to: 2, label: 'markConfirmed' },
      { from: 1, to: 2, label: 'insertAuditEvent (confirmed)' },
      { from: 1, to: 2, label: 'COMMIT' },
      { from: 1, to: 0, label: '200 OK', color: 'ok' },
      { else: 'already confirmed' },
      { from: 1, to: 2, label: 'ROLLBACK' },
      { from: 1, to: 0, label: '409 ALREADY_CONFIRMED', color: 'err' },
      { else: 'not found' },
      { from: 1, to: 2, label: 'ROLLBACK' },
      { from: 1, to: 0, label: '404 EMPLOYEE_NOT_FOUND', color: 'err' },
      { end: true },
    ]);

const extendSeq = (t: Theme) =>
  sequence(t, 'Extend probation', 'The API locks the employee row; a missing or confirmed employee is rejected first, then assertCanExtend checks the 6-month limit before any write. Within the limit it runs addProbationMonths (Postgres recomputes the end date from the join date), insertExtension and a probation.extended audit event, commits and returns 201. Over the limit it rolls back with 422 and nothing changes; a confirmed employee gets 409 and an unknown one 404.',
    CRUD,
    [
      { from: 0, to: 1, label: 'POST /employees/:id/extensions' },
      { from: 1, to: 2, label: 'BEGIN · lockEmployee' },
      { from: 2, to: 1, label: 'row (current total)', reply: true },
      { alt: 'on_probation and total + months ≤ 6' },
      { from: 1, to: 2, label: 'addProbationMonths' },
      { from: 1, to: 2, label: 'insertExtension' },
      { from: 1, to: 2, label: 'insertAuditEvent (extended)' },
      { from: 1, to: 2, label: 'COMMIT' },
      { from: 1, to: 0, label: '201 Created', color: 'ok' },
      { else: 'over 6 months: assertCanExtend throws' },
      { from: 1, to: 2, label: 'ROLLBACK' },
      { from: 1, to: 0, label: '422 MAX_PROBATION_EXCEEDED', color: 'err' },
      { else: 'confirmed / not found' },
      { from: 1, to: 2, label: 'ROLLBACK' },
      { from: 1, to: 0, label: '409 / 404', color: 'err' },
      { end: true },
    ]);

const concurrentSeq = (t: Theme) =>
  sequence(t, 'Two confirms at the same time', 'Two requests try to confirm the same employee. Request A takes the row lock with SELECT … FOR UPDATE; request B blocks on the same lock. A confirms, writes the audit event and commits, which releases the lock, and returns 200. B then re-reads the row, sees it is already confirmed, rolls back and returns 409. Exactly one audit event is written.',
    [['Request A', 'main'], ['PostgreSQL', 'db'], ['Request B', 'main']],
    [
      { from: 0, to: 1, label: 'BEGIN · SELECT … FOR UPDATE' },
      { from: 1, to: 0, label: 'row (on_probation)', reply: true },
      { from: 2, to: 1, label: 'BEGIN · SELECT … FOR UPDATE' },
      { note: 2, label: 'waits for the lock' },
      { from: 0, to: 1, label: 'UPDATE status = confirmed' },
      { from: 0, to: 1, label: 'INSERT audit event' },
      { from: 0, to: 1, label: 'COMMIT (releases lock)' },
      { note: 0, label: '200 OK', color: 'ok' },
      { from: 1, to: 2, label: 're-read: confirmed', reply: true },
      { from: 2, to: 1, label: 'ROLLBACK' },
      { note: 2, label: '409 ALREADY_CONFIRMED', color: 'err' },
    ],
    [{ lane: 2, from: 2, to: 8 }]);

// ---------------------------------------------------------------------------------------------
// 11. How the list is grouped
// ---------------------------------------------------------------------------------------------

function listGrouping(t: Theme): string {
  const s = new Svg(t);
  const Y = 30;
  const AX = Y + 90;
  const dx = (d: number) => 260 + d * 20; // day 0 (today) at x = 260
  const groups: [number, number, string, string, boolean][] = [
    [40, dx(-0.5), 'Overdue', 'before today', false],
    [dx(-0.5), dx(7.5), 'Due in 7 days', 'day 0–7', false],
    [dx(7.5), dx(30.5), 'Due in 30 days', 'day 8–30', false],
    [dx(30.5), dx(36), 'Due later', 'day 31–N', true],
  ];
  for (const [a, b, name, range, later] of groups) {
    s.rect(a + 3, Y, b - a - 6, 50, later ? 'box' : 'main', { rx: 4, dash: later });
    s.text((a + b) / 2, Y + 22, name, { bold: true });
    s.text((a + b) / 2, Y + 40, range, { size: 12, color: t.muted });
  }
  s.arrow([[40, AX], [dx(36) + 10, AX]]);
  for (const d of [-1, 0, 7, 8, 30, 31]) {
    s.line(dx(d), AX - 6, dx(d), AX + 6, t.ink);
    s.text(dx(d), AX + 22, String(d), { size: 12, mono: true });
  }
  s.raw(`<line x1="${dx(0)}" y1="${AX - 10}" x2="${dx(0)}" y2="${AX + 10}" stroke="${t.ok}" stroke-width="3"/>`);
  s.text(dx(0), AX + 42, 'today: ends today is due, not overdue', { size: 12, bold: true, color: t.ok });
  s.text(dx(36) + 10, AX + 22, 'days until end', { size: 12, color: t.muted, anchor: 'end' });

  return s.render(dx(36) + 50, AX + 64, 'How the list is grouped', 'Each unconfirmed probation is placed by its days until end (end date minus today): below 0 is Overdue, 0 to 7 is Due in 7 days, 8 to 30 is Due in 30 days, and 31 up to N is Due later. Day 0, a probation that ends today, is due, not overdue.');
}

// ---------------------------------------------------------------------------------------------

const DIAGRAMS: Record<string, (t: Theme) => string> = {
  'system-overview': systemOverview,
  'api-layers': apiLayers,
  'error-map': errorMap,
  'data-model': dataModel,
  'employee-lifecycle': lifecycle,
  'company-isolation': isolation,
  'sequence-add-employee': createSeq,
  'sequence-confirm': confirmSeq,
  'sequence-extend': extendSeq,
  'sequence-concurrent-confirm': concurrentSeq,
  'list-grouping': listGrouping,
};

// CSS that recolours the light drawing for dark mode. CSS rules beat SVG presentation
// attributes, so [fill="<light>"] { fill: <dark> } swaps each colour in place.
function darkModeStyle(): string {
  const pairs: [string, string][] = [
    [LIGHT.bg, DARK.bg],
    [LIGHT.ink, DARK.ink],
    [LIGHT.muted, DARK.muted],
    [LIGHT.box.fill, DARK.box.fill],
    [LIGHT.box.stroke, DARK.box.stroke],
    [LIGHT.main.fill, DARK.main.fill],
    [LIGHT.main.stroke, DARK.main.stroke],
    [LIGHT.db.fill, DARK.db.fill],
    [LIGHT.db.stroke, DARK.db.stroke],
    [LIGHT.ok, DARK.ok],
    [LIGHT.err, DARK.err],
  ];
  if (new Set(pairs.map(([light]) => light)).size !== pairs.length) {
    throw new Error('Every light colour must be unique, or dark mode would swap the wrong one');
  }
  const rules = pairs.map(([l, d]) => `[fill="${l}"]{fill:${d}}[stroke="${l}"]{stroke:${d}}`).join('');
  return `<style>@media (prefers-color-scheme: dark){${rules}}</style>`;
}

const outDir = join(import.meta.dirname, '..', 'docs', 'diagrams');
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.svg')) rmSync(join(outDir, f)); // drop stale diagrams
const style = darkModeStyle();
for (const [name, draw] of Object.entries(DIAGRAMS)) {
  writeFileSync(join(outDir, `${name}.svg`), draw(LIGHT).replace('</defs>', `</defs>${style}`));
}
console.log(`Wrote ${Object.keys(DIAGRAMS).length} SVG files to docs/diagrams/`);
