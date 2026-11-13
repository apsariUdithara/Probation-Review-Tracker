import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Generates the architecture diagrams in docs/diagrams/ (a light and a dark SVG each).
// Run: npm run diagrams. Change the diagram data below, never the SVG files.

type Theme = {
  name: 'light' | 'dark';
  bg: string;
  ink: string; // main text
  muted: string; // secondary text
  box: { fill: string; stroke: string };
  main: { fill: string; stroke: string }; // the API itself
  db: { fill: string; stroke: string };
  ok: string;
  err: string;
};

const LIGHT: Theme = {
  name: 'light',
  bg: '#ffffff',
  ink: '#1f2633',
  muted: '#66708a',
  box: { fill: '#ffffff', stroke: '#7d88a6' },
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
const MONO = "ui-monospace, SFMono-Regular, Consolas, monospace";

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Style = 'box' | 'main' | 'db';

// ---------------------------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------------------------

class Svg {
  readonly t: Theme;
  private out: string[] = [];

  constructor(t: Theme) {
    this.t = t;
  }

  text(x: number, y: number, s: string, o: { size?: number; bold?: boolean; color?: string; anchor?: string; mono?: boolean } = {}) {
    this.out.push(
      `<text x="${x}" y="${y}" font-family="${o.mono ? MONO : FONT}" font-size="${o.size ?? 13}"` +
        ` font-weight="${o.bold ? 600 : 400}" fill="${o.color ?? this.t.ink}" text-anchor="${o.anchor ?? 'middle'}">${esc(s)}</text>`,
    );
  }

  rect(x: number, y: number, w: number, h: number, style: Style, o: { dash?: boolean; rx?: number } = {}) {
    const c = this.t[style];
    this.out.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 6}" fill="${c.fill}" stroke="${c.stroke}"` +
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
      const w = o.label.length * 6.8 + 12;
      this.out.push(`<rect x="${lx - w / 2}" y="${ly - 10}" width="${w}" height="20" fill="${this.t.bg}"/>`);
      this.text(lx, ly + 4, o.label, { size: 12, color: o.color === undefined ? this.t.ink : color });
    }
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
// 2. API layers
// ---------------------------------------------------------------------------------------------

function apiLayers(t: Theme): string {
  const s = new Svg(t);
  const X = 60;
  const W = 300;
  const layers: [string, string][] = [
    ['Middleware', 'check company and user'],
    ['Routes', 'validate the request'],
    ['Service', 'business rules, transactions'],
    ['Repository', 'SQL queries'],
  ];
  layers.forEach(([name, what], i) => {
    const y = 30 + i * 96;
    s.box(X, y, W, 64, 'main', name, what);
    if (i < layers.length - 1) s.arrow([[X + W / 2, y + 64], [X + W / 2, y + 94]]);
  });
  s.arrow([[X + W / 2, 30 + 3 * 96 + 64], [X + W / 2, 412]]);
  s.cylinder(X + W / 2 - 80, 414, 160, 86, 'Database', 'PostgreSQL');

  s.box(440, 222, 200, 64, 'box', 'Domain', 'pure rules, no I/O');
  s.arrow([[X + W, 254], [438, 254]], { label: 'uses', dash: true });
  s.box(440, 30, 200, 64, 'box', 'Error handler', 'turns errors into JSON');
  s.arrow([[X + W, 62], [438, 62]], { label: 'any error', dash: true });

  return s.render(700, 530, 'API layers', 'Requests pass down through four layers: middleware checks the company and user, routes validate the request, the service applies business rules inside transactions, and the repository runs SQL against PostgreSQL. The service uses a separate domain module of pure rules. An error handler turns any error into a JSON response.');
}

// ---------------------------------------------------------------------------------------------
// 3. Data model (ER diagram, crow's foot)
// ---------------------------------------------------------------------------------------------

function dataModel(t: Theme): string {
  const s = new Svg(t);
  const table = (x: number, y: number, name: string, cols: [string, string?][]) => {
    const w = 250;
    const h = 34 + cols.length * 22 + 8;
    s.rect(x, y, w, h, 'db', { rx: 4 });
    s.text(x + 14, y + 22, name, { bold: true, size: 14, anchor: 'start', mono: true });
    s.raw(`<line x1="${x}" y1="${y + 32}" x2="${x + w}" y2="${y + 32}" stroke="${t.db.stroke}" stroke-width="1"/>`);
    cols.forEach(([c, key], i) => {
      s.text(x + 14, y + 52 + i * 22, c, { size: 12.5, anchor: 'start', mono: true });
      if (key) s.text(x + w - 14, y + 52 + i * 22, key, { size: 11.5, anchor: 'end', color: t.muted, bold: true });
    });
    return h;
  };

  table(40, 40, 'companies', [['id', 'PK'], ['name']]);
  table(380, 40, 'employees', [
    ['id', 'PK'],
    ['company_id', 'FK'],
    ['name'],
    ['join_date'],
    ['total_probation_months'],
    ['probation_end_date'],
    ['status'],
  ]);
  table(40, 300, 'probation_extensions', [['id', 'PK'], ['employee_id', 'FK'], ['months'], ['reason'], ['actor']]);
  table(720, 300, 'audit_events', [['id', 'PK'], ['employee_id', 'FK'], ['action'], ['actor'], ['occurred_at']]);

  // One-to-many: a bar on the "one" side, a crow's foot on the "many" side.
  const crow = (x: number, y: number, dir: 'left' | 'right' | 'up' | 'down') => {
    const c = t.muted;
    const v = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
    const [dx, dy] = [v[0]!, v[1]!];
    const back = [x - dx * 14, y - dy * 14];
    const spread = (k: number) => [x + dy * 8 * k, y + dx * 8 * k];
    const [l, r] = [spread(1), spread(-1)];
    s.raw(`<path d="M ${back[0]} ${back[1]} L ${l[0]} ${l[1]} M ${back[0]} ${back[1]} L ${x} ${y} M ${back[0]} ${back[1]} L ${r[0]} ${r[1]}" stroke="${c}" stroke-width="1.5" fill="none"/>`);
  };
  const bar = (x: number, y: number, vertical: boolean) => {
    const c = t.muted;
    s.raw(vertical
      ? `<line x1="${x}" y1="${y - 8}" x2="${x}" y2="${y + 8}" stroke="${c}" stroke-width="1.5"/>`
      : `<line x1="${x - 8}" y1="${y}" x2="${x + 8}" y2="${y}" stroke="${c}" stroke-width="1.5"/>`);
  };
  const line = (d: string) => s.raw(`<path d="${d}" stroke="${t.muted}" stroke-width="1.5" fill="none"/>`);

  // companies 1 -- * employees
  line('M 290 74 L 380 74');
  bar(302, 74, true);
  crow(380, 74, 'right');
  // employees 1 -- * probation_extensions
  line('M 380 220 L 165 220 L 165 300');
  bar(368, 220, true);
  crow(165, 300, 'down');
  // employees 1 -- * audit_events
  line('M 630 220 L 845 220 L 845 300');
  bar(642, 220, true);
  crow(845, 300, 'down');

  return s.render(1010, 460, 'Data model', 'Entity-relationship diagram. A company has many employees. An employee has many probation extensions and many audit events. Employees store the join date, total probation months, the calculated end date and the status.');
}

// ---------------------------------------------------------------------------------------------
// 4. Employee lifecycle (UML state diagram)
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

  return s.render(790, 200, 'Employee lifecycle', 'State diagram. Adding an employee starts them in On probation. Extending keeps them On probation as long as the total stays at or below 6 months. Confirming moves them to Confirmed; nothing moves them out of it.');
}

// ---------------------------------------------------------------------------------------------
// 5. Company isolation
// ---------------------------------------------------------------------------------------------

function isolation(t: Theme): string {
  const s = new Svg(t);
  s.box(30, 110, 200, 70, 'box', 'Request', 'X-Company-Id: A');
  s.box(320, 110, 190, 70, 'main', 'Probation API', 'adds company_id = A');

  s.rect(600, 30, 300, 230, 'db', { rx: 8 });
  s.text(750, 56, 'Database', { bold: true, size: 14 });
  s.rect(620, 74, 260, 72, 'box');
  s.text(750, 104, 'Company A employees', { bold: true });
  s.text(750, 124, 'visible', { size: 12, color: t.ok });
  s.rect(620, 164, 260, 72, 'box', { dash: true });
  s.text(750, 194, 'Company B employees', { bold: true, color: t.muted });
  s.text(750, 214, 'never returned (404)', { size: 12, color: t.err });

  s.arrow([[230, 145], [318, 145]]);
  s.arrow([[510, 135], [618, 110]], { color: t.ok });

  return s.render(930, 290, 'Company isolation', 'A request carries the caller company id in the X-Company-Id header. The API adds that company id to every query, so only Company A employees are returned. Company B employees are never returned; asking for one gives 404, as if it did not exist.');
}

// ---------------------------------------------------------------------------------------------
// Sequence diagrams (UML): participants, lifelines, messages, replies, alt frames, notes.
// ---------------------------------------------------------------------------------------------

type Msg =
  | { from: number; to: number; label: string; reply?: boolean; color?: 'ok' | 'err' }
  | { self: number; label: string }
  | { note: number; label: string; color?: 'ok' | 'err' }
  | { alt: string } // starts an alt frame with this guard
  | { else: string }
  | { end: true };

function sequence(t: Theme, title: string, desc: string, participants: [string, Style][], steps: Msg[]): string {
  const s = new Svg(t);
  const gap = 230;
  const x = (i: number) => 120 + i * gap;
  const W = x(participants.length - 1) + 120;

  // Layout pass (y of each step) so frames can be drawn behind messages.
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
    s.box(x(i) - 85, 30, 170, 44, style, name);
    s.raw(`<line x1="${x(i)}" y1="74" x2="${x(i)}" y2="${H - 20}" stroke="${t.box.stroke}" stroke-width="1" stroke-dasharray="4 4"/>`);
  });

  // alt frames. Guard text gets a background patch so lifelines don't run through it.
  const left = x(0) - 100;
  const right = x(participants.length - 1) + 100;
  const guard = (gx: number, gy: number, label: string) => {
    s.raw(`<rect x="${gx - 4}" y="${gy - 13}" width="${label.length * 6.8 + 8}" height="18" fill="${t.bg}"/>`);
    s.text(gx, gy, label, { size: 12, anchor: 'start', color: t.muted });
  };
  let frameTop = 0;
  steps.forEach((st, i) => {
    if ('alt' in st) {
      frameTop = ys[i]! - 26;
      s.raw(`<rect x="${left}" y="${frameTop}" width="${right - left}" height="${ys[steps.findIndex((e, j) => j > i && 'end' in e)]! - 22 - frameTop}" fill="none" stroke="${t.box.stroke}"/>`);
      s.text(left + 10, frameTop + 15, 'alt', { bold: true, size: 12, anchor: 'start' });
      s.raw(`<path d="M ${left} ${frameTop + 20} L ${left + 34} ${frameTop + 20} L ${left + 42} ${frameTop + 12} L ${left + 42} ${frameTop}" fill="none" stroke="${t.box.stroke}"/>`);
      guard(left + 52, frameTop + 15, `[${st.alt}]`);
    } else if ('else' in st) {
      const ly = ys[i]! - 26;
      s.raw(`<line x1="${left}" y1="${ly}" x2="${right}" y2="${ly}" stroke="${t.box.stroke}" stroke-dasharray="6 4"/>`);
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

const createSeq = (t: Theme) =>
  sequence(t, 'Add employee', 'The client posts the new employee. The API validates the input, then in one transaction inserts the employee and an "employee created" audit event, commits, and returns 201 Created.',
    [['Client', 'box'], ['API', 'main'], ['Database', 'db']],
    [
      { from: 0, to: 1, label: 'POST /employees' },
      { self: 1, label: 'validate input' },
      { from: 1, to: 2, label: 'BEGIN, insert employee' },
      { from: 2, to: 1, label: 'new row + end date', reply: true },
      { from: 1, to: 2, label: 'insert audit event' },
      { from: 1, to: 2, label: 'COMMIT' },
      { from: 1, to: 0, label: '201 Created', color: 'ok' },
    ]);

const confirmSeq = (t: Theme) =>
  sequence(t, 'Confirm employee', 'The API locks the employee row. If the employee is still on probation it sets the status to confirmed, writes an audit event, commits and returns 200. If already confirmed it rolls back and returns 409.',
    [['Client', 'box'], ['API', 'main'], ['Database', 'db']],
    [
      { from: 0, to: 1, label: 'POST /employees/:id/confirmation' },
      { from: 1, to: 2, label: 'BEGIN, lock employee row' },
      { from: 2, to: 1, label: 'employee', reply: true },
      { alt: 'on probation' },
      { from: 1, to: 2, label: 'set status = confirmed' },
      { from: 1, to: 2, label: 'insert audit event' },
      { from: 1, to: 2, label: 'COMMIT' },
      { from: 1, to: 0, label: '200 OK', color: 'ok' },
      { else: 'already confirmed' },
      { from: 1, to: 2, label: 'ROLLBACK' },
      { from: 1, to: 0, label: '409 Conflict', color: 'err' },
      { end: true },
    ]);

const extendSeq = (t: Theme) =>
  sequence(t, 'Extend probation', 'The API locks the employee row and checks the 6-month limit. Within the limit it adds the months, records the extension and an audit event, commits and returns 201. Over the limit it rolls back and returns 422, changing nothing.',
    [['Client', 'box'], ['API', 'main'], ['Database', 'db']],
    [
      { from: 0, to: 1, label: 'POST /employees/:id/extensions' },
      { from: 1, to: 2, label: 'BEGIN, lock employee row' },
      { from: 2, to: 1, label: 'employee (current total)', reply: true },
      { alt: 'total + months ≤ 6' },
      { from: 1, to: 2, label: 'add months to total' },
      { from: 1, to: 2, label: 'insert extension + audit' },
      { from: 1, to: 2, label: 'COMMIT' },
      { from: 1, to: 0, label: '201 Created', color: 'ok' },
      { else: 'over 6 months' },
      { from: 1, to: 2, label: 'ROLLBACK' },
      { from: 1, to: 0, label: '422 Over the limit', color: 'err' },
      { end: true },
    ]);

const concurrentSeq = (t: Theme) =>
  sequence(t, 'Two confirms at the same time', 'Two requests try to confirm the same employee. Request A locks the row first; request B waits. A confirms and commits, returning 200. B then sees the employee is already confirmed and returns 409.',
    [['Request A', 'main'], ['Database', 'db'], ['Request B', 'main']],
    [
      { from: 0, to: 1, label: 'lock row' },
      { from: 2, to: 1, label: 'lock row' },
      { note: 2, label: 'waits' },
      { from: 0, to: 1, label: 'confirm + COMMIT' },
      { note: 0, label: '200 OK', color: 'ok' },
      { from: 1, to: 2, label: 'already confirmed', reply: true },
      { note: 2, label: '409 Conflict', color: 'err' },
    ]);

// ---------------------------------------------------------------------------------------------
// 10. How the list is grouped
// ---------------------------------------------------------------------------------------------

function listGrouping(t: Theme): string {
  const s = new Svg(t);
  const Y = 30;
  const groups: [number, number, string, string][] = [
    [40, 260, 'Overdue', 'before today'],
    [260, 470, 'Due in 7 days', 'today to day 7'],
    [470, 720, 'Due in 30 days', 'day 8 to 30'],
    [720, 900, 'Due later', 'day 31 to N'],
  ];
  groups.forEach(([a, b, name, range], i) => {
    s.rect(a + 3, Y, b - a - 6, 50, i === 3 ? 'box' : 'main', { rx: 4, dash: i === 3 });
    s.text((a + b) / 2, Y + 22, name, { bold: true });
    s.text((a + b) / 2, Y + 40, range, { size: 12, color: t.muted });
  });
  s.arrow([[40, Y + 80], [910, Y + 80]]);
  s.raw(`<line x1="260" y1="${Y + 72}" x2="260" y2="${Y + 88}" stroke="${t.ink}" stroke-width="2"/>`);
  s.text(260, Y + 108, 'today', { bold: true });
  s.text(910, Y + 108, 'days', { size: 12, color: t.muted, anchor: 'end' });

  return s.render(950, 160, 'How the list is grouped', 'Each unconfirmed probation is placed on a day axis relative to today: before today is Overdue, today to day 7 is Due in 7 days, day 8 to 30 is Due in 30 days, and day 31 up to N is Due later. A probation that ends today is due, not overdue.');
}

// ---------------------------------------------------------------------------------------------

const DIAGRAMS: Record<string, (t: Theme) => string> = {
  'system-overview': systemOverview,
  'api-layers': apiLayers,
  'data-model': dataModel,
  'employee-lifecycle': lifecycle,
  'company-isolation': isolation,
  'sequence-add-employee': createSeq,
  'sequence-confirm': confirmSeq,
  'sequence-extend': extendSeq,
  'sequence-concurrent-confirm': concurrentSeq,
  'list-grouping': listGrouping,
};

const outDir = join(import.meta.dirname, '..', 'docs', 'diagrams');
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.svg')) rmSync(join(outDir, f)); // drop stale diagrams
for (const [name, draw] of Object.entries(DIAGRAMS)) {
  for (const theme of [LIGHT, DARK]) writeFileSync(join(outDir, `${name}-${theme.name}.svg`), draw(theme));
}
console.log(`Wrote ${Object.keys(DIAGRAMS).length * 2} SVG files to docs/diagrams/`);
