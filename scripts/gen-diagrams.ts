import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Generates the architecture diagrams in docs/diagrams/ as hand-authored SVG, one light and
// one dark file per diagram. Run: npm run diagrams. Edit the data below, never the SVG output.

// ---------------------------------------------------------------------------------------------
// Semantic roles: one colour per role, identical in every diagram.
// ---------------------------------------------------------------------------------------------

type Role = 'flow' | 'success' | 'rejected' | 'fault' | 'waiting' | 'store';

const ROLE_LABEL: Record<Role, string> = {
  flow: 'request / control flow',
  success: 'success (2xx)',
  rejected: 'rejected (4xx): nothing written',
  fault: 'server error (5xx)',
  waiting: 'blocked on a row lock',
  store: 'PostgreSQL',
};

type Theme = {
  name: 'light' | 'dark';
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  role: Record<Role, { stroke: string; fill: string }>;
};

// Neutrals lean slightly toward the blue flow accent.
const LIGHT: Theme = {
  name: 'light',
  bg: '#f6f7fb',
  surface: '#ffffff',
  ink: '#1b2235',
  muted: '#5b6480',
  line: '#c5cbdc',
  role: {
    flow: { stroke: '#3b5bdb', fill: '#e9edfc' },
    success: { stroke: '#2b8a3e', fill: '#e6f4ea' },
    rejected: { stroke: '#b35c00', fill: '#fff1e0' },
    fault: { stroke: '#c92a2a', fill: '#fdeaea' },
    waiting: { stroke: '#7048e8', fill: '#efeafd' },
    store: { stroke: '#0b7285', fill: '#e3f4f6' },
  },
};

const DARK: Theme = {
  name: 'dark',
  bg: '#0f1320',
  surface: '#171c2c',
  ink: '#e3e7f2',
  muted: '#98a1bb',
  line: '#38405a',
  role: {
    flow: { stroke: '#7c95f5', fill: '#1c2547' },
    success: { stroke: '#5cc477', fill: '#15301e' },
    rejected: { stroke: '#f0a34a', fill: '#36260f' },
    fault: { stroke: '#f27474', fill: '#3a1a1d' },
    waiting: { stroke: '#a58cff', fill: '#261e45' },
    store: { stroke: '#4fc1d1', fill: '#0f2e33' },
  },
};

const SANS = "'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace";

// ---------------------------------------------------------------------------------------------
// A tiny SVG builder.
// ---------------------------------------------------------------------------------------------

type Ink = Role | 'ink' | 'muted' | 'line';

type TextOpts = {
  size?: number;
  weight?: number;
  ink?: Ink;
  anchor?: 'start' | 'middle' | 'end';
  mono?: boolean;
  italic?: boolean;
  fill?: string; // explicit colour, overrides `ink`
};

type ShapeOpts = { fill?: string; stroke?: string; dash?: boolean; rx?: number; width?: number };

type LineOpts = { ink?: Ink; dash?: boolean; arrow?: boolean; width?: number };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class Svg {
  readonly t: Theme;
  private parts: string[] = [];

  constructor(theme: Theme) {
    this.t = theme;
  }

  color(ink: Ink): string {
    if (ink === 'ink') return this.t.ink;
    if (ink === 'muted') return this.t.muted;
    if (ink === 'line') return this.t.line;
    return this.t.role[ink].stroke;
  }

  rect(x: number, y: number, w: number, h: number, o: ShapeOpts = {}): void {
    this.parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 8}" fill="${o.fill ?? this.t.surface}" ` +
        `stroke="${o.stroke ?? this.t.line}" stroke-width="${o.width ?? 1.5}"${o.dash ? ' stroke-dasharray="6 4"' : ''}/>`,
    );
  }

  /** A box filled and outlined in a role's colours. */
  roleBox(x: number, y: number, w: number, h: number, role: Role, o: ShapeOpts = {}): void {
    this.rect(x, y, w, h, { fill: this.t.role[role].fill, stroke: this.t.role[role].stroke, ...o });
  }

  text(x: number, y: number, s: string, o: TextOpts = {}): void {
    this.parts.push(
      `<text x="${x}" y="${y}" font-family="${o.mono ? MONO : SANS}" font-size="${o.size ?? 12.5}" ` +
        `font-weight="${o.weight ?? 400}" fill="${o.fill ?? this.color(o.ink ?? 'ink')}" text-anchor="${o.anchor ?? 'start'}"` +
        `${o.italic ? ' font-style="italic"' : ''}>${esc(s)}</text>`,
    );
  }

  path(d: string, o: LineOpts = {}): void {
    const ink = o.ink ?? 'muted';
    this.parts.push(
      `<path d="${d}" fill="none" stroke="${this.color(ink)}" stroke-width="${o.width ?? 1.6}"` +
        `${o.dash ? ' stroke-dasharray="5 4"' : ''}${o.arrow ? ` marker-end="url(#arrow-${ink})"` : ''}/>`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, o: LineOpts = {}): void {
    this.path(`M ${x1} ${y1} L ${x2} ${y2}`, o);
  }

  /** Numbered circle: the same number marks a stage and every outcome it causes. */
  badge(cx: number, cy: number, n: number, role: Role = 'flow'): void {
    this.parts.push(`<circle cx="${cx}" cy="${cy}" r="9" fill="${this.t.role[role].stroke}"/>`);
    // The digit sits on a saturated circle, so it uses the page background colour.
    this.text(cx, cy + 4, String(n), { size: 11, weight: 700, anchor: 'middle', fill: this.t.bg });
  }

  dot(cx: number, cy: number, r: number, ink: Ink): void {
    this.parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${this.color(ink)}"/>`);
  }

  /** Title block shared by every diagram. */
  heading(title: string, subtitle: string): void {
    this.text(24, 36, title, { size: 18, weight: 700 });
    this.text(24, 58, subtitle, { size: 12.5, ink: 'muted' });
  }

  /** Legend row: only the roles a diagram actually uses. */
  legend(y: number, roles: Role[], extras: { label: string; dashed?: boolean }[] = []): void {
    let x = 24;
    for (const role of roles) {
      this.roleBox(x, y - 10, 14, 14, role, { rx: 3 });
      this.text(x + 20, y + 1, ROLE_LABEL[role], { size: 11.5, ink: 'muted' });
      x += 34 + ROLE_LABEL[role].length * 6.1;
    }
    for (const extra of extras) {
      this.rect(x, y - 10, 14, 14, { rx: 3, dash: extra.dashed, fill: 'none', stroke: this.t.muted });
      this.text(x + 20, y + 1, extra.label, { size: 11.5, ink: 'muted' });
      x += 34 + extra.label.length * 6.1;
    }
  }

  render(width: number, height: number, title: string, desc: string): string {
    const inks: Ink[] = ['ink', 'muted', 'line', 'flow', 'success', 'rejected', 'fault', 'waiting', 'store'];
    const markers = inks
      .map(
        (ink) =>
          `<marker id="arrow-${ink}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" ` +
          `orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z" fill="${this.color(ink)}"/></marker>`,
      )
      .join('');
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="title desc">`,
      `<title id="title">${esc(title)}</title>`,
      `<desc id="desc">${esc(desc)}</desc>`,
      `<defs>${markers}</defs>`,
      `<rect width="${width}" height="${height}" rx="12" fill="${this.t.bg}"/>`,
      ...this.parts,
      '</svg>',
      '',
    ].join('\n');
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Request pipeline: which stage produces which response (src/app.ts order).
// ---------------------------------------------------------------------------------------------

type Outcome = {
  status: number;
  code: string;
  cause: string[];
  role: 'rejected' | 'fault';
  backstop?: boolean; // database safety net, unreachable if the app code is correct
  direct?: boolean; // sent by notFoundHandler, not by errorHandler
};

const STAGES: { title: string; lines: string[]; role: Role; outcomes: Outcome[] }[] = [
  {
    title: 'express.json()',
    lines: ['parses the JSON body', 'limit 100 kb'],
    role: 'flow',
    outcomes: [
      { status: 400, code: 'INVALID_JSON', cause: ['malformed JSON body'], role: 'rejected' },
      { status: 413, code: 'INVALID_REQUEST', cause: ['body over 100 kb'], role: 'rejected' },
    ],
  },
  {
    title: 'tenantMiddleware',
    lines: ['X-Company-Id: a known', 'company · X-Actor-Id', '→ res.locals.ctx'],
    role: 'flow',
    outcomes: [
      {
        status: 401,
        code: 'UNAUTHENTICATED',
        cause: ['header missing or malformed,', 'or company unknown'],
        role: 'rejected',
      },
    ],
  },
  {
    title: 'employeeRoutes',
    lines: ['Zod: body, query, :id', 'then calls the service', 'sends 2xx on success'],
    role: 'flow',
    outcomes: [
      { status: 400, code: 'VALIDATION_ERROR', cause: ['ZodError: body or withinDays'], role: 'rejected' },
      { status: 404, code: 'EMPLOYEE_NOT_FOUND', cause: [':id is not a UUID'], role: 'rejected' },
      {
        status: 404,
        code: 'NOT_FOUND',
        cause: ['no route matched: sent', 'directly by notFoundHandler'],
        role: 'rejected',
        direct: true,
      },
    ],
  },
  {
    title: 'service.ts',
    lines: ['writes run inside', 'withTransaction: lock,', 'rules, change, audit row'],
    role: 'flow',
    outcomes: [
      {
        status: 404,
        code: 'EMPLOYEE_NOT_FOUND',
        cause: ['no row with this id', 'AND company_id'],
        role: 'rejected',
      },
      { status: 409, code: 'ALREADY_CONFIRMED', cause: ["status = 'confirmed'"], role: 'rejected' },
      { status: 422, code: 'MAX_PROBATION_EXCEEDED', cause: ['total + months > 6'], role: 'rejected' },
    ],
  },
  {
    title: 'repository.ts',
    lines: ['parameterised SQL,', 'scoped by company_id', '→ PostgreSQL 17'],
    role: 'store',
    outcomes: [
      { status: 422, code: 'CONSTRAINT_VIOLATION', cause: ['CHECK failed (23514)'], role: 'rejected', backstop: true },
      { status: 400, code: 'VALIDATION_ERROR', cause: ['bad date (22007/22008)'], role: 'rejected', backstop: true },
      { status: 500, code: 'INTERNAL_ERROR', cause: ['anything else; logged'], role: 'fault' },
    ],
  },
];

function pipeline(t: Theme): string {
  const s = new Svg(t);
  const W = 1140;
  const colX = (i: number) => 150 + i * 196;
  const COL_W = 180;
  const STAGE_Y = 118;
  const STAGE_H = 100;
  const PILL_Y = 252;

  s.heading(
    'Request pipeline: where every response comes from',
    'createApp() in src/app.ts mounts these stages in order. Each one passes the request on or throws; the numbers tie every outcome to its stage.',
  );

  // Client
  s.rect(20, STAGE_Y, 110, STAGE_H);
  s.text(75, STAGE_Y + 30, 'Client', { size: 14, weight: 700, anchor: 'middle' });
  s.text(75, STAGE_Y + 52, 'curl, web/ page,', { size: 11.5, ink: 'muted', anchor: 'middle' });
  s.text(75, STAGE_Y + 68, 'supertest', { size: 11.5, ink: 'muted', anchor: 'middle' });
  s.line(130, STAGE_Y + 50, colX(0) - 2, STAGE_Y + 50, { ink: 'flow', arrow: true });

  // Success: the route handler sends the 2xx response.
  const routeMid = colX(2) + COL_W / 2;
  s.path(`M ${routeMid} ${STAGE_Y} L ${routeMid} 96 L 75 96 L 75 ${STAGE_Y - 2}`, { ink: 'success', arrow: true });
  s.text(150, 90, '2xx JSON, sent by the route handler: 201 for create and extend, 200 otherwise', {
    size: 12,
    ink: 'success',
  });

  let lowest = 0;
  const spines: { x: number; top: number }[] = []; // per column: line that carries errors down
  STAGES.forEach((stage, i) => {
    const x = colX(i);
    s.roleBox(x, STAGE_Y, COL_W, STAGE_H, stage.role);
    s.badge(x + 18, STAGE_Y + 21, i + 1, stage.role);
    s.text(x + 34, STAGE_Y + 26, stage.title, { mono: true, size: 13, weight: 700 });
    stage.lines.forEach((line, j) => s.text(x + 14, STAGE_Y + 50 + j * 16, line, { size: 12, ink: 'muted' }));
    if (i < STAGES.length - 1) {
      s.line(x + COL_W, STAGE_Y + 50, colX(i + 1) - 2, STAGE_Y + 50, { ink: 'flow', arrow: true });
    }

    // Outcomes this stage can throw, stacked below it.
    s.line(x + COL_W / 2, STAGE_Y + STAGE_H, x + COL_W / 2, PILL_Y - 2, { ink: 'muted', dash: true, arrow: true });
    let y = PILL_Y;
    const spineX = x + COL_W + 8;
    let spineTop = Infinity;
    for (const o of stage.outcomes) {
      const h = 46 + o.cause.length * 14;
      s.roleBox(x, y, COL_W, h, o.role, { dash: o.backstop });
      s.badge(x + 16, y + 17, i + 1, stage.role);
      s.text(x + 32, y + 22, String(o.status), { size: 15, weight: 700, ink: o.role });
      s.text(x + 12, y + 40, o.code, { mono: true, size: 11.5, weight: 700, ink: o.role });
      o.cause.forEach((c, j) => s.text(x + 12, y + 56 + j * 14, c, { size: 11.5, ink: 'muted' }));
      if (!o.direct) {
        s.line(x + COL_W, y + h / 2, spineX, y + h / 2, { ink: 'muted' });
        spineTop = Math.min(spineTop, y + h / 2);
      }
      y += h + 10;
    }
    lowest = Math.max(lowest, y);
    spines.push({ x: spineX, top: spineTop });
  });

  // errorHandler: every thrown error converges here (except notFoundHandler's direct 404).
  const BAR_Y = lowest + 14;
  const BAR_H = 58;
  for (const spine of spines) s.line(spine.x, spine.top, spine.x, BAR_Y - 2, { ink: 'muted', arrow: true });
  s.roleBox(colX(0), BAR_Y, colX(4) + COL_W + 16 - colX(0), BAR_H, 'flow');
  s.text(colX(0) + 16, BAR_Y + 24, 'errorHandler', { mono: true, size: 13, weight: 700 });
  s.text(
    colX(0) + 112,
    BAR_Y + 24,
    '(src/error-handler.ts): the one place a thrown error becomes a response, always { error: { code, message, details? } }',
    { size: 12 },
  );
  s.text(
    colX(0) + 16,
    BAR_Y + 44,
    'Database backstops and 500s are logged with the Postgres code, constraint and table; the client only gets the generic message.',
    { size: 12, ink: 'muted' },
  );
  s.path(`M ${colX(0)} ${BAR_Y + BAR_H / 2} L 75 ${BAR_Y + BAR_H / 2} L 75 ${STAGE_Y + STAGE_H + 2}`, {
    ink: 'rejected',
    arrow: true,
  });
  s.text(28, BAR_Y + BAR_H / 2 - 8, 'error JSON', { size: 12, ink: 'rejected' });

  // Transaction note: outcomes from stages 4 and 5 on a write never leave a trace.
  const NOTE_Y = BAR_Y + BAR_H + 28;
  s.badge(34, NOTE_Y - 4, 4);
  s.badge(56, NOTE_Y - 4, 5, 'store');
  s.text(
    72,
    NOTE_Y,
    'On a write these run inside withTransaction (src/db.ts): any throw → ROLLBACK, so a rejected request changes nothing and writes no audit row.',
    { size: 12.5 },
  );

  const H = NOTE_Y + 50;
  s.legend(H - 22, ['flow', 'success', 'rejected', 'fault', 'store'], [
    { label: 'dashed: database backstop, unreachable if the app is correct', dashed: true },
  ]);
  return s.render(
    W,
    H,
    'Request pipeline: where every response comes from',
    'A request passes five stages in order: 1 express.json, 2 tenantMiddleware, 3 employeeRoutes, 4 service.ts, 5 repository.ts and PostgreSQL. ' +
      'Success responses (200 or 201) are sent by the route handler. Each stage can instead throw: 1 gives 400 INVALID_JSON or 413; ' +
      '2 gives 401 UNAUTHENTICATED; 3 gives 400 VALIDATION_ERROR or 404 EMPLOYEE_NOT_FOUND for a non-UUID id, and unmatched routes get 404 NOT_FOUND from notFoundHandler; ' +
      '4 gives 404 EMPLOYEE_NOT_FOUND, 409 ALREADY_CONFIRMED or 422 MAX_PROBATION_EXCEEDED; 5 gives database backstops 422 CONSTRAINT_VIOLATION and 400, or 500 INTERNAL_ERROR. ' +
      'All thrown errors go through errorHandler. Writes run in a transaction, so a rejected request leaves no change and no audit row.',
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Two simultaneous confirmations (confirmEmployee + lockEmployee, READ COMMITTED).
// ---------------------------------------------------------------------------------------------

function concurrentConfirm(t: Theme): string {
  const s = new Svg(t);
  const W = 1100;
  const CA = 90;
  const RA = 330;
  const PG = 560;
  const RB = 790;
  const CB = 1010;
  const LIFE_END = 700;

  s.heading(
    'Two confirmations at once: the row lock decides',
    'POST /employees/:id/confirmation → confirmEmployee() in src/employees/service.ts, under Postgres READ COMMITTED (the default).',
  );

  const heads: [number, string, string, Role | null][] = [
    [CA, 'Client A', 'HTTP', null],
    [RA, 'Request A', 'confirmEmployee()', 'flow'],
    [PG, 'PostgreSQL', 'employees row (id)', 'store'],
    [RB, 'Request B', 'confirmEmployee()', 'flow'],
    [CB, 'Client B', 'HTTP', null],
  ];
  for (const [x, name, sub, role] of heads) {
    if (role) s.roleBox(x - 90, 80, 180, 50, role);
    else s.rect(x - 90, 80, 180, 50);
    s.text(x, 101, name, { size: 13.5, weight: 700, anchor: 'middle' });
    s.text(x, 119, sub, { size: 11.5, ink: 'muted', anchor: 'middle', mono: role !== null });
    s.line(x, 130, x, LIFE_END, { ink: 'line', dash: true });
  }

  // par fragment: both requests are sent together.
  s.rect(24, 146, W - 48, 86, { fill: 'none', stroke: t.muted, rx: 4 });
  s.path(`M 24 166 L 78 166 L 88 156 L 88 146`, { ink: 'muted', width: 1.2 });
  s.text(34, 161, 'par', { size: 11.5, weight: 700, ink: 'muted', mono: true });
  s.text(100, 161, 'sent together', { size: 11.5, ink: 'muted', italic: true });

  // Activation bars and lock / wait periods (drawn first, under the arrows).
  s.roleBox(RA - 5, 252, 10, 272, 'flow', { rx: 2 });
  s.roleBox(RB - 5, 314, 10, 362, 'flow', { rx: 2 });
  s.roleBox(RB - 5, 314, 10, 246, 'waiting', { rx: 2 });
  s.roleBox(PG - 5, 252, 10, 238, 'store', { rx: 2 });

  const msg = (
    n: number | null,
    from: number,
    to: number,
    y: number,
    labels: { text: string; mono?: boolean }[],
    ink: Ink,
    dash = false,
  ) => {
    const dir = Math.sign(to - from);
    s.line(from + dir * 5, y, to - dir * 7, y, { ink, arrow: true, dash });
    const mid = (from + to) / 2;
    // The label takes the arrow's colour; replies (muted, dashed) use normal text colour.
    labels.forEach((l, i) =>
      s.text(mid, y - 8 - (labels.length - 1 - i) * 15, l.text, {
        size: 11.5,
        anchor: 'middle',
        mono: l.mono ?? true,
        ink: ink === 'muted' ? 'ink' : ink,
      }),
    );
    if (n !== null) s.badge(from - dir * 18, y, n, ink === 'ink' || ink === 'muted' || ink === 'line' ? 'flow' : ink);
  };

  msg(1, CA, RA, 186, [{ text: 'POST …/:id/confirmation' }], 'flow');
  msg(2, CB, RB, 218, [{ text: 'POST …/:id/confirmation' }], 'flow');
  msg(3, RA, PG, 262, [{ text: 'BEGIN; SELECT … FOR UPDATE' }], 'store');
  msg(null, PG, RA, 294, [{ text: "row: status = 'on_probation'" }], 'muted', true);
  msg(4, RB, PG, 326, [{ text: 'BEGIN; SELECT … FOR UPDATE' }], 'store');

  // Note: B is blocked.
  const NOTE_X = PG + 22;
  const NOTE_W = RB - PG - 44;
  s.roleBox(NOTE_X, 338, NOTE_W, 60, 'waiting');
  s.text(NOTE_X + NOTE_W / 2, 356, 'B waits: row locked by A', { size: 12, weight: 600, ink: 'waiting', anchor: 'middle' });
  s.text(NOTE_X + NOTE_W / 2, 373, 'pg_stat_activity:', { size: 11, ink: 'muted', anchor: 'middle', mono: true });
  s.text(NOTE_X + NOTE_W / 2, 389, "wait_event_type = 'Lock'", { size: 11, ink: 'muted', anchor: 'middle', mono: true });

  msg(5, RA, PG, 420, [{ text: "markConfirmed: UPDATE … SET" }, { text: "status = 'confirmed' … AND" }, { text: "status = 'on_probation'" }], 'store');
  msg(6, RA, PG, 462, [{ text: 'INSERT audit_events' }, { text: "action = 'probation.confirmed'" }], 'store');
  msg(7, RA, PG, 492, [{ text: 'COMMIT: lock released' }], 'store');
  msg(8, RA, CA, 524, [{ text: '200 · employee, confirmedBy A' }], 'success');
  msg(null, PG, RB, 560, [{ text: 're-read after the wait:', mono: false }, { text: "status = 'confirmed'" }], 'muted', true);

  // Self-message: B throws.
  s.path(`M ${RB + 5} 590 L ${RB + 46} 590 L ${RB + 46} 612 L ${RB + 7} 612`, { ink: 'rejected', arrow: true });
  s.badge(RB - 18, 600, 9, 'rejected');
  s.text(RB + 54, 605, 'throw new ConflictError()', { size: 11.5, mono: true, ink: 'rejected' });

  msg(10, RB, PG, 646, [{ text: 'ROLLBACK: nothing written' }], 'rejected');
  msg(11, RB, CB, 680, [{ text: '409 ALREADY_CONFIRMED' }], 'rejected');

  // Outcome and backstops.
  const notes = [
    'Result: one 200, one 409, and exactly one probation.confirmed row in audit_events.',
    "If this logic were broken: step 5's AND status = 'on_probation' would update 0 rows (→ 500), and the unique index",
    'audit_events_one_confirmation_idx rejects a second confirmation event.',
    'extendProbation takes the same lock: two +3 extensions on a total of 3 → one 201, one 422 MAX_PROBATION_EXCEEDED.',
  ];
  notes.forEach((n, i) => s.text(24, 736 + i * 19, n, { size: 12.5, ink: i === 0 ? 'ink' : 'muted', weight: i === 0 ? 600 : 400 }));

  const H = 846;
  s.legend(H - 22, ['flow', 'success', 'rejected', 'waiting', 'store'], [{ label: 'dashed arrow: reply' }]);
  return s.render(
    W,
    H,
    'Two confirmations at once: the row lock decides',
    'Sequence diagram. Clients A and B send POST /employees/:id/confirmation together. Request A runs BEGIN and SELECT … FOR UPDATE first and gets the row with status on_probation. ' +
      'Request B runs the same SELECT … FOR UPDATE and blocks on the row lock. A updates the status to confirmed, inserts a probation.confirmed audit event and commits, releasing the lock, and returns 200. ' +
      'B then re-reads the committed row, sees status confirmed, throws ConflictError, rolls back and returns 409 ALREADY_CONFIRMED. Exactly one audit event is written.',
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Employee lifecycle (status column + total_probation_months).
// ---------------------------------------------------------------------------------------------

function lifecycle(t: Theme): string {
  const s = new Svg(t);
  const W = 1060;
  const Y = 250; // state row top
  const H_STATE = 104;
  const MID = Y + H_STATE / 2;
  const P = { x: 330, w: 250 }; // on_probation
  const C = { x: 820, w: 214 }; // confirmed

  s.heading(
    'Employee lifecycle: two states, every other request rejected',
    "employees.status is 'on_probation' or 'confirmed' (CHECK constraint). Transitions read: request [guard] / effect.",
  );

  const state = (x: number, w: number, name: string, body: string[]) => {
    s.roleBox(x, Y, w, H_STATE, 'flow', { rx: 22 });
    s.text(x + w / 2, Y + 30, name, { mono: true, size: 15, weight: 700, anchor: 'middle' });
    s.line(x, Y + 44, x + w, Y + 44, { ink: 'flow', width: 1 });
    body.forEach((b, i) => s.text(x + w / 2, Y + 66 + i * 17, b, { size: 12, ink: 'muted', anchor: 'middle' }));
  };

  // Initial pseudo-state -> on_probation
  s.dot(70, MID, 9, 'ink');
  s.line(79, MID, P.x - 2, MID, { ink: 'flow', arrow: true });
  ['POST /employees', '[probationMonths 1–6]', '/ total = initial = months', '/ audit: employee.created'].forEach((l, i) =>
    s.text(96, MID - 60 + i * 16, l, { mono: true, size: 11.5, ink: i === 0 ? 'flow' : 'ink' }),
  );

  state(P.x, P.w, 'on_probation', ['total_probation_months 1–6', 'probation_end_date generated']);
  state(C.x, C.w, 'confirmed', ['confirmed_at, confirmed_by set', 'no transition leaves this state']);

  // on_probation -> confirmed
  s.line(P.x + P.w, MID, C.x - 2, MID, { ink: 'flow', arrow: true });
  ['POST …/confirmation', '/ confirmed_at = now(),', '  confirmed_by = actor', '/ audit: probation.confirmed'].forEach((l, i) =>
    s.text(P.x + P.w + 14, MID - 60 + i * 16, l, { mono: true, size: 11.5, ink: i === 0 ? 'flow' : 'ink' }),
  );

  // Self-loop: extend
  const lx1 = P.x + 80;
  const lx2 = P.x + P.w - 80;
  s.path(`M ${lx1} ${Y} C ${lx1} ${Y - 80}, ${lx2} ${Y - 80}, ${lx2} ${Y - 2}`, { ink: 'flow', arrow: true });
  [
    'POST …/extensions',
    '[total + months ≤ 6]',
    '/ total += months; end date recomputed',
    '  from join_date by Postgres',
    '/ audit: probation.extended',
  ].forEach((l, i) =>
    // Five lines stacked so the last one ends above the loop's top (about Y - 60).
    s.text(P.x + P.w / 2, Y - 150 + i * 16, l, { mono: true, size: 11.5, anchor: 'middle', ink: i === 0 ? 'flow' : 'ink' }),
  );

  // Rejections: no transition, state unchanged.
  const pill = (x: number, w: number, status: string, code: string, cause: string[]) => {
    const y = Y + H_STATE + 70;
    s.line(x + w / 2, Y + H_STATE, x + w / 2, y - 2, { ink: 'rejected', dash: true, arrow: true });
    s.roleBox(x, y, w, 46 + cause.length * 15, 'rejected');
    s.text(x + 14, y + 22, status, { size: 15, weight: 700, ink: 'rejected' });
    s.text(x + 50, y + 21, code, { mono: true, size: 12, weight: 700, ink: 'rejected' });
    cause.forEach((c, i) => s.text(x + 14, y + 42 + i * 15, c, { size: 12, ink: 'muted' }));
  };
  pill(P.x, P.w, '422', 'MAX_PROBATION_EXCEEDED', ['extend with total + months > 6', 'state unchanged, ROLLBACK']);
  pill(C.x, C.w, '409', 'ALREADY_CONFIRMED', ['confirm or extend again', 'state unchanged, ROLLBACK']);

  // Derived, not stored.
  const NY = Y + H_STATE + 70;
  s.rect(24, NY, 270, 92, { dash: true, stroke: t.muted, fill: t.surface });
  s.text(38, NY + 22, 'Not states: overdue, due soon', { size: 12.5, weight: 700 });
  ['Computed at read time by bucketFor()', 'from probation_end_date − today, so', 'nothing has to update them as days pass.'].forEach((l, i) =>
    s.text(38, NY + 42 + i * 16, l, { size: 12, ink: 'muted' }),
  );

  const H = NY + 92 + 52;
  s.legend(H - 22, ['flow', 'rejected'], [{ label: 'dashed box: derived, not stored', dashed: true }]);
  return s.render(
    W,
    H,
    'Employee lifecycle: two states, every other request rejected',
    'State machine. POST /employees creates an employee in state on_probation with a total of 1 to 6 months and writes an employee.created audit event. ' +
      'POST extensions is a self-transition on on_probation, allowed only while total plus months is at most 6; it adds the months, Postgres recomputes the end date from the join date, and a probation.extended event is written. ' +
      'POST confirmation moves on_probation to confirmed and writes probation.confirmed. Extending past 6 months is rejected with 422, and confirming or extending a confirmed employee is rejected with 409; both leave the state unchanged. ' +
      'Overdue and due soon are not states: they are computed at read time from the end date and today.',
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Company isolation: application scoping + database composite foreign keys.
// ---------------------------------------------------------------------------------------------

function isolation(t: Theme): string {
  const s = new Svg(t);
  const W = 1140;
  const G_Y = 84;
  const G_H = 556;

  s.heading(
    'Company isolation: enforced in the app, and again in the database',
    'Another company’s employee behaves exactly like one that does not exist. Proven by test/integration/isolation.test.ts.',
  );

  // Boundaries
  s.rect(20, G_Y, 540, G_H, { fill: 'none', stroke: t.muted, dash: true, rx: 10 });
  s.text(36, G_Y + 22, 'Application  ·  src/', { size: 12.5, weight: 700, ink: 'muted' });
  s.rect(580, G_Y, 540, G_H, { fill: 'none', stroke: t.muted, dash: true, rx: 10 });
  s.text(596, G_Y + 22, 'Database  ·  migrations/1794552285665_init.sql', { size: 12.5, weight: 700, ink: 'muted' });

  // Application steps (a genuine sequence: numbered).
  const X = 44;
  const BW = 492;
  const step = (n: number, y: number, h: number, title: string, lines: { text: string; mono?: boolean; ink?: Ink }[]) => {
    s.roleBox(X, y, BW, h, 'flow');
    s.badge(X + 18, y + 20, n);
    s.text(X + 34, y + 25, title, { mono: true, size: 13, weight: 700 });
    lines.forEach((l, i) => s.text(X + 14, y + 48 + i * 17, l.text, { size: 12, mono: l.mono, ink: l.ink ?? 'muted' }));
  };
  step(1, 118, 64, 'X-Company-Id header', [
    { text: 'The only source of the company: never the URL, never the body (bodies are strict).' },
  ]);
  s.line(X + BW / 2, 182, X + BW / 2, 196, { ink: 'flow', arrow: true });
  step(2, 198, 82, 'tenantMiddleware', [
    { text: 'SELECT 1 FROM companies WHERE id = $1', mono: true, ink: 'ink' },
    { text: 'unknown or malformed → 401 UNAUTHENTICATED', ink: 'rejected' },
  ]);
  s.line(X + BW / 2, 280, X + BW / 2, 294, { ink: 'flow', arrow: true });
  step(3, 296, 64, 'res.locals.ctx.companyId', [
    { text: 'service.ts passes ctx.companyId to every repository call.' },
  ]);
  s.line(X + BW / 2, 360, X + BW / 2, 374, { ink: 'flow', arrow: true });

  const rows: [string, string][] = [
    ['findEmployee · lockEmployee', 'WHERE id = $1 AND company_id = $2'],
    ['markConfirmed · addProbationMonths', 'WHERE id = $1 AND company_id = $2'],
    ['listOpenProbations · listExtensions', 'WHERE company_id = $1 AND …'],
    ['listAuditEvents', 'WHERE company_id = $1 AND …'],
    ['insertEmployee · insertExtension', 'company_id = ctx.companyId'],
    ['insertAuditEvent', 'company_id = ctx.companyId'],
  ];
  s.roleBox(X, 376, BW, 40 + rows.length * 18, 'flow');
  s.badge(X + 18, 396, 4);
  s.text(X + 34, 401, 'repository.ts', { mono: true, size: 13, weight: 700 });
  s.text(X + 140, 401, 'all 10 functions scope their parameterised SQL', { size: 12, ink: 'muted' });
  rows.forEach(([names, clause], i) => {
    s.text(X + 14, 428 + i * 18, names, { mono: true, size: 11, ink: 'ink' });
    s.text(X + 262, 428 + i * 18, clause, { mono: true, size: 11, ink: 'muted' });
  });
  const repoBottom = 376 + 40 + rows.length * 18;

  // Outcome of the scoping.
  s.line(X + BW / 2, repoBottom, X + BW / 2, repoBottom + 18, { ink: 'rejected', dash: true, arrow: true });
  s.roleBox(X, repoBottom + 20, BW, 64, 'rejected');
  s.badge(X + 18, repoBottom + 40, 4);
  s.text(X + 34, repoBottom + 45, "Another company's employee: 0 rows", { size: 12.5, weight: 700, ink: 'rejected' });
  s.text(X + 14, repoBottom + 68, '→ NotFoundError → 404 EMPLOYEE_NOT_FOUND, identical to a missing id', {
    size: 12,
    ink: 'muted',
  });

  // Parameterised SQL crosses into the database (all tables, so it ends at the boundary).
  s.line(X + BW, 440, 578, 440, { ink: 'store', arrow: true });

  // Tables
  const table = (x: number, y: number, w: number, name: string, cols: [string, string][]) => {
    const h = 32 + cols.length * 19 + 6;
    s.roleBox(x, y, w, h, 'store', { rx: 6 });
    s.text(x + 12, y + 21, name, { mono: true, size: 13, weight: 700 });
    s.line(x, y + 30, x + w, y + 30, { ink: 'store', width: 1 });
    cols.forEach(([c, note], i) => {
      s.text(x + 12, y + 48 + i * 19, c, { mono: true, size: 11.5 });
      s.text(x + w - 12, y + 48 + i * 19, note, { size: 11, ink: 'muted', anchor: 'end' });
    });
    return h;
  };
  const companiesH = table(620, 120, 220, 'companies', [
    ['id', 'uuid PK'],
    ['name', 'text'],
  ]);
  const employeesY = 246;
  const employeesH = table(620, employeesY, 460, 'employees', [
    ['id', 'uuid PK'],
    ['company_id', 'FK → companies(id)'],
    ['UNIQUE (company_id, id)', 'target of the composite FKs'],
  ]);
  const childY = 420;
  const childCols: [string, string][] = [
    ['(company_id, employee_id)', ''],
    ['→ employees(company_id, id)', ''],
  ];
  table(620, childY, 220, 'probation_extensions', childCols);
  table(860, childY, 220, 'audit_events', childCols);

  // Relationships: 1 -> many
  const rel = (x1: number, y1: number, x2: number, y2: number) => {
    s.line(x1, y1, x2, y2, { ink: 'store' });
    s.text(x1 + 8, y1 + 14, '1', { size: 11.5, weight: 700, ink: 'store' });
    s.text(x2 + 8, y2 - 6, '*', { size: 13, weight: 700, ink: 'store' });
  };
  rel(700, 120 + companiesH, 700, employeesY);
  rel(730, employeesY + employeesH, 730, childY);
  rel(970, employeesY + employeesH, 970, childY);

  // Backstop
  const BY = 540;
  s.roleBox(620, BY, 460, 78, 'fault', { dash: true });
  s.text(634, BY + 23, 'Backstop: a cross-company child row cannot exist', { size: 12.5, weight: 700, ink: 'fault' });
  s.text(634, BY + 44, "INSERT with company B's company_id and company A's employee_id", { size: 12, ink: 'muted' });
  s.text(634, BY + 62, '→ 23503 foreign key violation, even if the application code were wrong', {
    size: 12,
    ink: 'muted',
  });

  const H = G_Y + G_H + 52;
  s.legend(H - 22, ['flow', 'rejected', 'fault', 'store'], [
    { label: 'dashed: database backstop', dashed: true },
  ]);
  return s.render(
    W,
    H,
    'Company isolation: enforced in the app, and again in the database',
    'Application layer: the company comes only from the X-Company-Id header; tenantMiddleware checks it with SELECT 1 FROM companies WHERE id = $1 (401 if unknown) and stores it in res.locals.ctx.companyId; ' +
      'the service passes it to all 10 repository functions, each of which filters or inserts by company_id. Another company’s employee returns 0 rows, so the API answers 404 EMPLOYEE_NOT_FOUND, the same as a missing id. ' +
      'Database layer: companies has many employees; employees exposes UNIQUE (company_id, id); probation_extensions and audit_events reference employees through the composite foreign key (company_id, employee_id), ' +
      'so a row pointing at another company’s employee is rejected with a foreign key violation.',
  );
}

// ---------------------------------------------------------------------------------------------

const DIAGRAMS: Record<string, (t: Theme) => string> = {
  'request-pipeline': pipeline,
  'concurrent-confirm': concurrentConfirm,
  'employee-lifecycle': lifecycle,
  'company-isolation': isolation,
};

const outDir = join(import.meta.dirname, '..', 'docs', 'diagrams');
mkdirSync(outDir, { recursive: true });
for (const [name, draw] of Object.entries(DIAGRAMS)) {
  for (const theme of [LIGHT, DARK]) {
    writeFileSync(join(outDir, `${name}-${theme.name}.svg`), draw(theme));
  }
}
console.log(`Wrote ${Object.keys(DIAGRAMS).length * 2} SVG files to docs/diagrams/`);
