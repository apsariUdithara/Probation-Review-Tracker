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
// Sequence-diagram helper for the scenario diagrams: lanes, numbered messages, replies,
// self-calls, notes, dividers, activation bars and combined fragments (par).
// ---------------------------------------------------------------------------------------------

type Lane = { name: string; sub: string; role: Role | null };

type SeqStep =
  | { kind: 'msg'; from: number; to: number; labels: string[]; ink: Ink; n?: number; reply?: boolean }
  | { kind: 'self'; at: number; label: string; ink: Ink; n?: number }
  | { kind: 'note'; from: number; to: number; lines: string[]; role: Role }
  | { kind: 'divider'; label: string };

type SeqSpec = {
  width: number;
  title: string;
  subtitle: string;
  lanes: Lane[];
  steps: SeqStep[];
  activations: { lane: number; from: number; to: number; role: Role }[]; // step indices, inclusive
  frames?: { from: number; to: number; label: string; text: string }[];
  notes: string[]; // first line is the headline result
  legend: Role[];
  desc: string;
};

function sequence(t: Theme, spec: SeqSpec): string {
  const s = new Svg(t);
  const W = spec.width;
  const laneX = (i: number) => 110 + (i * (W - 220)) / (spec.lanes.length - 1);
  s.heading(spec.title, spec.subtitle);

  // Pass 1: layout, so activation bars and frames can be drawn underneath the arrows.
  const ys: number[] = [];
  let y = 168;
  for (const step of spec.steps) {
    if (step.kind === 'msg') {
      y += 15 * step.labels.length + 4;
      ys.push(y);
      y += 18;
    } else if (step.kind === 'self') {
      y += 6;
      ys.push(y);
      y += 40;
    } else if (step.kind === 'note') {
      ys.push(y);
      y += 24 + 16 * step.lines.length;
    } else {
      y += 8;
      ys.push(y);
      y += 26;
    }
  }
  const lifeEnd = y + 6;
  const stepBottom = (i: number) => {
    const step = spec.steps[i]!;
    return ys[i]! + (step.kind === 'self' ? 24 : step.kind === 'note' ? 10 + 16 * step.lines.length : 6);
  };

  spec.lanes.forEach((lane, i) => {
    const x = laneX(i);
    if (lane.role) s.roleBox(x - 92, 80, 184, 50, lane.role);
    else s.rect(x - 92, 80, 184, 50);
    s.text(x, 101, lane.name, { size: 13.5, weight: 700, anchor: 'middle' });
    s.text(x, 119, lane.sub, { size: 11.5, ink: 'muted', anchor: 'middle', mono: lane.role !== null });
    s.line(x, 130, x, lifeEnd, { ink: 'line', dash: true });
  });

  for (const f of spec.frames ?? []) {
    const top = ys[f.from]! - 46;
    const bottom = stepBottom(f.to) + 10;
    s.rect(24, top, W - 48, bottom - top, { fill: 'none', stroke: t.muted, rx: 4 });
    s.path(`M 24 ${top + 20} L 78 ${top + 20} L 88 ${top + 10} L 88 ${top}`, { ink: 'muted', width: 1.2 });
    s.text(34, top + 15, f.label, { size: 11.5, weight: 700, ink: 'muted', mono: true });
    s.text(100, top + 15, f.text, { size: 11.5, ink: 'muted', italic: true });
  }

  for (const a of spec.activations) {
    const top = ys[a.from]! - 8;
    s.roleBox(laneX(a.lane) - 5, top, 10, stepBottom(a.to) + 6 - top, a.role, { rx: 2 });
  }

  spec.steps.forEach((step, i) => {
    const sy = ys[i]!;
    if (step.kind === 'msg') {
      const from = laneX(step.from);
      const to = laneX(step.to);
      const dir = Math.sign(to - from);
      const ink = step.reply ? 'muted' : step.ink;
      s.line(from + dir * 5, sy, to - dir * 7, sy, { ink: step.reply ? step.ink : ink, arrow: true, dash: step.reply });
      const labelInk: Ink = step.ink === 'muted' ? 'ink' : step.ink;
      step.labels.forEach((l, j) =>
        s.text((from + to) / 2, sy - 8 - (step.labels.length - 1 - j) * 15, l, {
          size: 11.5,
          anchor: 'middle',
          mono: true,
          ink: step.reply && step.ink === 'muted' ? 'ink' : labelInk,
        }),
      );
      if (step.n !== undefined) {
        const badgeRole: Role = step.ink in t.role ? (step.ink as Role) : 'flow';
        s.badge(from - dir * 18, sy, step.n, badgeRole);
      }
    } else if (step.kind === 'self') {
      const x = laneX(step.at);
      s.path(`M ${x + 5} ${sy} L ${x + 44} ${sy} L ${x + 44} ${sy + 22} L ${x + 7} ${sy + 22}`, {
        ink: step.ink,
        arrow: true,
      });
      s.text(x + 52, sy + 15, step.label, { size: 11.5, mono: true, ink: step.ink === 'muted' ? 'ink' : step.ink });
      if (step.n !== undefined) {
        const badgeRole: Role = step.ink in t.role ? (step.ink as Role) : 'flow';
        s.badge(x - 18, sy + 11, step.n, badgeRole);
      }
    } else if (step.kind === 'note') {
      const a = laneX(Math.min(step.from, step.to));
      const b = laneX(Math.max(step.from, step.to));
      const left = step.from === step.to ? a - 112 : a + 20;
      const right = step.from === step.to ? a + 112 : b - 20;
      s.roleBox(left, sy, right - left, 14 + 16 * step.lines.length, step.role);
      step.lines.forEach((l, j) =>
        s.text((left + right) / 2, sy + 17 + j * 16, l, {
          size: j === 0 ? 12 : 11.5,
          weight: j === 0 ? 600 : 400,
          ink: j === 0 ? step.role : 'muted',
          anchor: 'middle',
          mono: j > 0,
        }),
      );
    } else {
      s.line(24, sy, W - 24, sy, { ink: 'muted', dash: true, width: 1.2 });
      const w = step.label.length * 6.6 + 24;
      s.rect(W / 2 - w / 2, sy - 11, w, 22, { fill: t.bg, stroke: t.muted, rx: 11, width: 1.2 });
      s.text(W / 2, sy + 4, step.label, { size: 11.5, ink: 'muted', anchor: 'middle', italic: true });
    }
  });

  spec.notes.forEach((n, i) =>
    s.text(24, lifeEnd + 32 + i * 19, n, { size: 12.5, ink: i === 0 ? 'ink' : 'muted', weight: i === 0 ? 600 : 400 }),
  );
  const H = lifeEnd + 32 + spec.notes.length * 19 + 44;
  s.legend(H - 22, spec.legend, [{ label: 'dashed arrow: reply' }]);
  return s.render(W, H, spec.title, spec.desc);
}

const CLIENT: Lane = { name: 'Client', sub: 'HTTP', role: null };
const ROUTES: Lane = { name: 'routes.ts', sub: 'employeeRoutes', role: 'flow' };
const POSTGRES: Lane = { name: 'PostgreSQL', sub: 'transaction client', role: 'store' };

// ---------------------------------------------------------------------------------------------
// 5. Create an employee (createEmployee): employee row + audit row in one transaction.
// ---------------------------------------------------------------------------------------------

function createEmployeeSeq(t: Theme): string {
  const [C, R, S, D] = [0, 1, 2, 3];
  return sequence(t, {
    width: 1100,
    title: 'Scenario: add an employee',
    subtitle: 'POST /employees → createEmployee() in src/employees/service.ts. The company comes from X-Company-Id (ctx), never from the body.',
    lanes: [CLIENT, ROUTES, { name: 'service.ts', sub: 'createEmployee()', role: 'flow' }, POSTGRES],
    steps: [
      { kind: 'msg', from: C, to: R, labels: ['POST /employees', '{ name, joinDate, probationMonths }'], ink: 'flow', n: 1 },
      { kind: 'self', at: R, label: 'createEmployeeBody.parse(req.body)', ink: 'flow', n: 2 },
      { kind: 'msg', from: R, to: S, labels: ['createEmployee(pool, ctx, input)'], ink: 'flow', n: 3 },
      { kind: 'msg', from: S, to: D, labels: ['BEGIN'], ink: 'store', n: 4 },
      { kind: 'msg', from: S, to: D, labels: ['insertEmployee: INSERT INTO employees', 'initial = total = probationMonths'], ink: 'store', n: 5 },
      { kind: 'msg', from: D, to: S, labels: ['RETURNING …, probation_end_date', '(generated: join_date + months)'], ink: 'muted', reply: true },
      { kind: 'msg', from: S, to: D, labels: ['insertAuditEvent', "action = 'employee.created'"], ink: 'store', n: 6 },
      { kind: 'msg', from: S, to: D, labels: ['COMMIT'], ink: 'store', n: 7 },
      { kind: 'msg', from: S, to: R, labels: ['employee'], ink: 'muted', reply: true },
      { kind: 'msg', from: R, to: C, labels: ['201 Created', 'Location: /employees/{id}'], ink: 'success', n: 8 },
    ],
    activations: [
      { lane: R, from: 0, to: 9 },
      { lane: S, from: 2, to: 8 },
      { lane: D, from: 3, to: 7 },
    ].map((a) => ({ ...a, role: a.lane === D ? ('store' as Role) : ('flow' as Role) })),
    notes: [
      'Result: the employee row and its employee.created audit row are saved together, or not at all.',
      'Step 2 is strict Zod: a real calendar date (isValidIsoDate), months 1–6, trimmed name; an extra companyId field → 400. It fails before BEGIN, so nothing is written.',
      'If step 5 or 6 throws, withTransaction (src/db.ts) rolls back: there is never an employee without its audit row.',
    ],
    legend: ['flow', 'success', 'store'],
    desc:
      'Sequence diagram. The client sends POST /employees with name, joinDate and probationMonths. The route validates the body with createEmployeeBody, then calls createEmployee. ' +
      'The service opens a transaction, inserts the employee with initial and total months equal to probationMonths, and Postgres returns the row with the generated probation_end_date. ' +
      'It then inserts an employee.created audit event and commits. The route responds 201 Created with a Location header.',
  });
}

// ---------------------------------------------------------------------------------------------
// 6. Extend a probation (extendProbation), success path. Data from lifecycle.test.ts.
// ---------------------------------------------------------------------------------------------

function extendSeq(t: Theme): string {
  const [C, R, S, D] = [0, 1, 2, 3];
  return sequence(t, {
    width: 1100,
    title: 'Scenario: extend a probation',
    subtitle: 'POST /employees/:id/extensions → extendProbation(). Example: joined 2026-01-15 on 3 months (ends 2026-04-15), extended by 2.',
    lanes: [CLIENT, ROUTES, { name: 'service.ts', sub: 'extendProbation()', role: 'flow' }, POSTGRES],
    steps: [
      { kind: 'msg', from: C, to: R, labels: ['POST /employees/:id/extensions', '{ months: 2, reason }'], ink: 'flow', n: 1 },
      { kind: 'self', at: R, label: 'parseEmployeeId · extensionBody.parse', ink: 'flow', n: 2 },
      { kind: 'msg', from: R, to: S, labels: ['extendProbation(pool, ctx, id, input)'], ink: 'flow', n: 3 },
      { kind: 'msg', from: S, to: D, labels: ['BEGIN', 'lockEmployee: SELECT … FOR UPDATE'], ink: 'store', n: 4 },
      { kind: 'msg', from: D, to: S, labels: ["on_probation, total 3, ends 2026-04-15"], ink: 'muted', reply: true },
      { kind: 'self', at: S, label: 'assertCanExtend(3, 2): 5 ≤ 6', ink: 'flow', n: 5 },
      { kind: 'msg', from: S, to: D, labels: ['addProbationMonths: UPDATE …', 'SET total = total + 2'], ink: 'store', n: 6 },
      { kind: 'msg', from: D, to: S, labels: ['total 5, ends 2026-06-15', '(recomputed from join_date)'], ink: 'muted', reply: true },
      { kind: 'msg', from: S, to: D, labels: ['insertExtension', 'previous 2026-04-15 → new 2026-06-15'], ink: 'store', n: 7 },
      { kind: 'msg', from: S, to: D, labels: ['insertAuditEvent', "'probation.extended' + details"], ink: 'store', n: 8 },
      { kind: 'msg', from: S, to: D, labels: ['COMMIT'], ink: 'store', n: 9 },
      { kind: 'msg', from: S, to: R, labels: ['{ employee, extension }'], ink: 'muted', reply: true },
      { kind: 'msg', from: R, to: C, labels: ['201 { employee, extension }'], ink: 'success', n: 10 },
    ],
    activations: [
      { lane: R, from: 0, to: 12, role: 'flow' },
      { lane: S, from: 2, to: 11, role: 'flow' },
      { lane: D, from: 3, to: 10, role: 'store' },
    ],
    notes: [
      'Result: total 5, end date 2026-06-15, one extension row and one probation.extended audit row, all in one transaction.',
      'Step 5 runs before any write. Exactly 6 is allowed (3 + 3, 4 + 2); over 6 is the next scenario.',
      'Step 4 locks the row, so a concurrent extend or confirm waits (see the concurrent-extensions scenario).',
      'Audit details: { months, reason, previousEndDate, newEndDate, newTotal }.',
    ],
    legend: ['flow', 'success', 'store'],
    desc:
      'Sequence diagram for extending a probation by 2 months. The route validates the id and body, then calls extendProbation. The service begins a transaction and locks the employee row; ' +
      'Postgres returns status on_probation, total 3, end 2026-04-15. assertCanExtend(3, 2) passes because 5 is at most 6. The service adds 2 months to the total; Postgres recomputes the end date ' +
      'from the join date as 2026-06-15. It inserts the extension row with previous and new end dates, inserts a probation.extended audit event and commits. The client receives 201 with the employee and the extension.',
  });
}

// ---------------------------------------------------------------------------------------------
// 7. Extension over the 6-month limit (required edge case). Data from lifecycle.test.ts.
// ---------------------------------------------------------------------------------------------

function extendOverLimitSeq(t: Theme): string {
  const [C, E, R, S, D] = [0, 1, 2, 3, 4];
  return sequence(t, {
    width: 1180,
    title: 'Scenario: an extension that would go over 6 months',
    subtitle: 'Required edge case. Example: 4 months, already extended by 2 (total 6, ends 2026-07-15), then +1 is requested.',
    lanes: [
      CLIENT,
      { name: 'errorHandler', sub: 'error-handler.ts', role: 'flow' },
      ROUTES,
      { name: 'service.ts', sub: 'extendProbation()', role: 'flow' },
      POSTGRES,
    ],
    steps: [
      { kind: 'msg', from: C, to: R, labels: ['POST /employees/:id/extensions', '{ months: 1, reason }'], ink: 'flow', n: 1 },
      { kind: 'self', at: R, label: 'extensionBody.parse: valid', ink: 'flow', n: 2 },
      { kind: 'msg', from: R, to: S, labels: ['extendProbation(…)'], ink: 'flow', n: 3 },
      { kind: 'msg', from: S, to: D, labels: ['BEGIN', 'lockEmployee: SELECT … FOR UPDATE'], ink: 'store', n: 4 },
      { kind: 'msg', from: D, to: S, labels: ['total 6, ends 2026-07-15'], ink: 'muted', reply: true },
      { kind: 'self', at: S, label: 'assertCanExtend(6, 1): 7 > 6', ink: 'rejected', n: 5 },
      { kind: 'divider', label: 'BusinessRuleError thrown: no write has happened' },
      { kind: 'msg', from: S, to: D, labels: ['ROLLBACK (withTransaction)'], ink: 'rejected', n: 6 },
      { kind: 'msg', from: S, to: R, labels: ['rejects: BusinessRuleError'], ink: 'rejected', reply: true },
      { kind: 'msg', from: R, to: E, labels: ['Express 5 passes the', 'rejected promise on'], ink: 'rejected', n: 7 },
      { kind: 'msg', from: E, to: C, labels: ['422', 'MAX_PROBATION_EXCEEDED'], ink: 'rejected', n: 8 },
    ],
    activations: [
      { lane: R, from: 0, to: 9, role: 'flow' },
      { lane: S, from: 2, to: 8, role: 'flow' },
      { lane: D, from: 3, to: 7, role: 'store' },
      { lane: E, from: 9, to: 10, role: 'rejected' },
    ],
    notes: [
      'Result: 422 with "Cannot extend by 1 month(s): current total is 6, which would make 7; the maximum is 6."',
      'Nothing changed: total still 6, end date 2026-07-15, still one extension, no new audit row (asserted in lifecycle.test.ts).',
      'Backstop if step 5 were missing: the UPDATE would break CHECK total_probation_months BETWEEN 1 AND 6 → 23514 → 422 CONSTRAINT_VIOLATION.',
      'A confirmed employee stops one check earlier: ConflictError → 409 ALREADY_CONFIRMED, by the same rollback path.',
    ],
    legend: ['flow', 'rejected', 'store'],
    desc:
      'Sequence diagram for the over-the-limit case. The employee has a total of 6 months. The client requests a 1-month extension; validation passes and extendProbation begins a transaction and locks the row. ' +
      'assertCanExtend(6, 1) fails because 7 is more than 6 and throws BusinessRuleError before any write. withTransaction rolls back, the rejected promise reaches errorHandler, ' +
      'and the client receives 422 MAX_PROBATION_EXCEEDED. The total, end date, extensions and audit log are unchanged.',
  });
}

// ---------------------------------------------------------------------------------------------
// 8. Two +3 extensions at once on a total of 3 (lifecycle.test.ts concurrency test).
// ---------------------------------------------------------------------------------------------

function concurrentExtendSeq(t: Theme): string {
  const [CA, RA, D, RB, CB] = [0, 1, 2, 3, 4];
  return sequence(t, {
    width: 1140,
    title: 'Scenario: two extensions at once',
    subtitle: 'Both ask for +3 months on an employee whose total is 3. Only one can fit under the 6-month limit.',
    lanes: [
      { name: 'Client A', sub: 'HTTP', role: null },
      { name: 'Request A', sub: 'extendProbation()', role: 'flow' },
      { name: 'PostgreSQL', sub: 'employees row (id)', role: 'store' },
      { name: 'Request B', sub: 'extendProbation()', role: 'flow' },
      { name: 'Client B', sub: 'HTTP', role: null },
    ],
    steps: [
      { kind: 'msg', from: CA, to: RA, labels: ['POST …/extensions { months: 3 }'], ink: 'flow', n: 1 },
      { kind: 'msg', from: CB, to: RB, labels: ['POST …/extensions { months: 3 }'], ink: 'flow', n: 2 },
      { kind: 'msg', from: RA, to: D, labels: ['BEGIN; SELECT … FOR UPDATE'], ink: 'store', n: 3 },
      { kind: 'msg', from: D, to: RA, labels: ['total 3'], ink: 'muted', reply: true },
      { kind: 'msg', from: RB, to: D, labels: ['BEGIN; SELECT … FOR UPDATE'], ink: 'store', n: 4 },
      { kind: 'note', from: D, to: RB, lines: ['B waits: row locked by A'], role: 'waiting' },
      { kind: 'self', at: RA, label: 'assertCanExtend(3, 3): 6 ≤ 6', ink: 'flow', n: 5 },
      { kind: 'msg', from: RA, to: D, labels: ['UPDATE total = 6; INSERT', 'extension + audit row'], ink: 'store', n: 6 },
      { kind: 'msg', from: RA, to: D, labels: ['COMMIT: lock released'], ink: 'store', n: 7 },
      { kind: 'msg', from: RA, to: CA, labels: ['201 · total 6'], ink: 'success', n: 8 },
      { kind: 'msg', from: D, to: RB, labels: ['re-read after the wait:', 'total 6'], ink: 'muted', reply: true },
      { kind: 'self', at: RB, label: 'assertCanExtend(6, 3): 9 > 6', ink: 'rejected', n: 9 },
      { kind: 'msg', from: RB, to: D, labels: ['ROLLBACK: nothing written'], ink: 'rejected', n: 10 },
      { kind: 'msg', from: RB, to: CB, labels: ['422 MAX_PROBATION_EXCEEDED'], ink: 'rejected', n: 11 },
    ],
    activations: [
      { lane: RA, from: 2, to: 9, role: 'flow' },
      { lane: D, from: 2, to: 8, role: 'store' },
      { lane: RB, from: 4, to: 13, role: 'flow' },
      { lane: RB, from: 4, to: 10, role: 'waiting' },
    ],
    frames: [{ from: 0, to: 1, label: 'par', text: 'sent together' }],
    notes: [
      'Result: one 201 and one 422; total 6, one extension row, one probation.extended audit row (lifecycle.test.ts).',
      'B checks the limit against the committed total (6), not the total it would have seen without the lock (3).',
      'Without the lock both checks would pass; B’s UPDATE would then wait on A’s row and fail CHECK total ≤ 6 → 422 CONSTRAINT_VIOLATION.',
    ],
    legend: ['flow', 'success', 'rejected', 'waiting', 'store'],
    desc:
      'Sequence diagram. Clients A and B each request a 3-month extension at the same time on an employee with a total of 3. Request A locks the row first and reads total 3; request B blocks on the lock. ' +
      'A passes assertCanExtend(3, 3), updates the total to 6, inserts the extension and audit rows, commits and returns 201. B then re-reads the committed total of 6, fails assertCanExtend(6, 3), ' +
      'rolls back and returns 422 MAX_PROBATION_EXCEEDED.',
  });
}

// ---------------------------------------------------------------------------------------------
// 9. Building the grouped list (GET /probations), incl. the "ends today" edge case.
// ---------------------------------------------------------------------------------------------

function probationList(t: Theme): string {
  const s = new Svg(t);
  const W = 1140;
  s.heading(
    'Scenario: build the grouped list',
    'GET /probations?withinDays=N → listProbations(). A read: one SELECT on the pool, no transaction. Example: test clock today = 2026-11-13, N = 30.',
  );

  // Steps 1-4 (a real sequence, numbered).
  const boxes: { w: number; title: string; lines: string[]; role: Role; mono?: boolean }[] = [
    { w: 232, title: 'listProbationsQuery', lines: ['withinDays: digits only, 0–365', 'missing → 30', "'', -1, 366, 1.5 → 400"], role: 'flow' },
    { w: 232, title: 'clock.today()', lines: ["todayIn('Asia/Colombo') via", 'Intl formatToParts', "→ '2026-11-13' (fixed in tests)"], role: 'flow' },
    {
      w: 372,
      title: 'listOpenProbations',
      lines: [
        'WHERE company_id = $1',
        "  AND status = 'on_probation'",
        '  AND probation_end_date <= $2::date + $3::int',
        'ORDER BY probation_end_date, name, id',
        'daysUntilEnd = probation_end_date - $2::date',
      ],
      role: 'store',
      mono: true,
    },
    { w: 196, title: 'bucketFor()', lines: ['each row → one group', 'SQL order is kept', 'counts per group'], role: 'flow' },
  ];
  let x = 24;
  const BY = 86;
  const BH = 132;
  boxes.forEach((b, i) => {
    s.roleBox(x, BY, b.w, BH, b.role);
    s.badge(x + 18, BY + 20, i + 1, b.role);
    s.text(x + 34, BY + 25, b.title, { mono: true, size: 13, weight: 700 });
    b.lines.forEach((l, j) =>
      s.text(x + 14, BY + 50 + j * 16, l, { size: b.mono ? 11 : 12, mono: b.mono, ink: b.mono ? 'ink' : 'muted' }),
    );
    if (i < boxes.length - 1) s.line(x + b.w, BY + BH / 2, x + b.w + 18, BY + BH / 2, { ink: 'flow', arrow: true });
    x += b.w + 20;
  });

  // Number line for step 4: daysUntilEnd.
  const AX_Y = 380;
  const X0 = 80;
  const PX = 20; // px per day
  const dx = (d: number) => X0 + (d + 12) * PX; // -12 .. +38
  s.badge(34, 262, 4);
  s.text(50, 267, 'bucketFor(daysUntilEnd) on a day axis (N = 30)', { size: 14, weight: 700 });
  s.text(50, 286, 'The SQL window is probation_end_date ≤ today + N with no lower bound, so overdue rows are always included.', {
    size: 12,
    ink: 'muted',
  });

  const seg = (from: number, to: number, label: string, sub: string, listed: boolean) => {
    const x1 = from;
    const x2 = to;
    if (listed) s.roleBox(x1, AX_Y - 34, x2 - x1, 28, 'flow', { rx: 4 });
    else s.rect(x1, AX_Y - 34, x2 - x1, 28, { rx: 4, dash: true, fill: 'none', stroke: t.muted });
    s.text((x1 + x2) / 2, AX_Y - 16, label, { mono: true, size: 11.5, weight: 700, anchor: 'middle', ink: listed ? 'ink' : 'muted' });
    s.text((x1 + x2) / 2, AX_Y + 42, sub, { size: 11.5, anchor: 'middle', ink: 'muted' });
  };
  seg(dx(-12), dx(-0.5), 'overdue', 'below 0, however old', true);
  seg(dx(-0.5), dx(7.5), 'dueWithin7Days', '0 to 7', true);
  seg(dx(7.5), dx(30.5), 'dueWithin30Days', '8 to 30', true);
  seg(dx(30.5), dx(38), 'not listed', 'over N', false);
  s.line(dx(-12) + 2, AX_Y, dx(38), AX_Y, { ink: 'ink', arrow: true });
  s.path(`M ${dx(-12) + 14} ${AX_Y - 6} L ${dx(-12) + 2} ${AX_Y} L ${dx(-12) + 14} ${AX_Y + 6}`, { ink: 'ink' });
  for (const d of [-1, 0, 7, 8, 30, 31]) {
    s.line(dx(d), AX_Y - 4, dx(d), AX_Y + 4, { ink: 'ink', width: 1.4 });
    s.text(dx(d), AX_Y + 20, String(d), { size: 11.5, anchor: 'middle', mono: true });
  }
  s.text(dx(38) - 4, AX_Y - 42, 'daysUntilEnd →', { size: 11.5, ink: 'muted', anchor: 'end' });

  // Example rows from probations.test.ts, as callouts above the axis.
  const callout = (d: number, height: number, lines: string[], role: Role | null) => {
    const cx = dx(d);
    const top = AX_Y - 34 - height;
    s.line(cx, top + 4, cx, AX_Y - 36, { ink: role ?? 'muted', width: 1.2 });
    s.dot(cx, AX_Y, 5, role ?? 'muted');
    lines.forEach((l, j) =>
      s.text(cx, top - 4 - (lines.length - 1 - j) * 15, l, {
        size: 11.5,
        anchor: 'middle',
        weight: j === 0 ? 700 : 400,
        ink: j === 0 ? (role ?? 'muted') : 'muted',
      }),
    );
  };
  callout(-1, 22, ['ended yesterday', 'joined 2026-08-12 → overdue'], 'flow');
  callout(0, 70, ['ENDS TODAY (required case)', 'joined 2026-08-13 + 3 months', '→ dueWithin7Days, not overdue'], 'success');
  callout(30, 22, ['day 30 → dueWithin30Days'], 'flow');
  callout(31, 70, ['day 31 → not listed', 'when N = 30'], null);

  // dueLater explanation + response
  const RY = 470;
  s.rect(24, RY, 520, 120, { dash: true, stroke: t.muted });
  s.text(38, RY + 22, 'With N > 30 a fourth group appears', { size: 12.5, weight: 700 });
  [
    'dueLater: 31 to N days (e.g. N = 60 → days 31–60).',
    'N = 0 → only overdue and ending today.',
    'Confirmed employees and other companies never',
    'reach bucketFor: the WHERE clause removes them.',
  ].forEach((l, i) => s.text(38, RY + 44 + i * 17, l, { size: 12, ink: 'muted' }));

  s.roleBox(564, RY, 552, 120, 'success');
  s.text(578, RY + 22, '200 response (all four arrays always present)', { size: 12.5, weight: 700, ink: 'success' });
  [
    '{ "asOf": "2026-11-13", "withinDays": 30,',
    '  "counts": { "overdue": 1, "dueWithin7Days": 1, … },',
    '  "overdue": [ … ], "dueWithin7Days": [ { …, "daysUntilEnd": 0 } ],',
    '  "dueWithin30Days": [ … ], "dueLater": [] }',
  ].forEach((l, i) => s.text(578, RY + 46 + i * 17, l, { size: 11, mono: true }));

  const H = RY + 120 + 56;
  s.legend(H - 22, ['flow', 'success', 'store'], [{ label: 'dashed: not returned / explanation', dashed: true }]);
  return s.render(
    W,
    H,
    'Scenario: build the grouped list',
    'Four steps: 1 the withinDays query is validated (0 to 365, default 30); 2 today is taken from the clock in Asia/Colombo; 3 one SELECT returns unconfirmed probations of this company ending on or before today plus N, ' +
      'with daysUntilEnd = end date minus today, sorted by end date, name and id; 4 bucketFor puts each row in a group: below 0 overdue, 0 to 7 due within 7 days, 8 to 30 due within 30 days, 31 to N due later. ' +
      'A probation ending today has daysUntilEnd 0 and is due within 7 days, not overdue. With N = 30 a probation 31 days away is not listed.',
  );
}

// ---------------------------------------------------------------------------------------------
// 10. How probation_end_date is calculated (29 February, clamping, no chaining).
// ---------------------------------------------------------------------------------------------

function endDate(t: Theme): string {
  const s = new Svg(t);
  const W = 1100;
  s.heading(
    'Scenario: how the end date is calculated',
    'Postgres computes it; JavaScript never does month arithmetic. Examples are the ones asserted in schema.test.ts and dates.test.ts.',
  );

  s.roleBox(24, 80, W - 48, 64, 'store');
  s.text(
    40,
    104,
    'probation_end_date date GENERATED ALWAYS AS ((join_date + make_interval(months => total_probation_months))::date) STORED',
    { mono: true, size: 12, weight: 700 },
  );
  s.text(40, 128, 'Recomputed on every INSERT and on every UPDATE of total_probation_months. If the day does not exist in the target month, Postgres uses that month’s last day.', {
    size: 12,
    ink: 'muted',
  });

  const pill = (x: number, y: number, date: string, role: Role, dash = false) => {
    s.roleBox(x, y, 112, 30, role, { rx: 15, dash });
    s.text(x + 56, y + 20, date, { mono: true, size: 12.5, weight: 700, anchor: 'middle' });
  };

  // Header
  const HY = 176;
  s.text(40, HY, 'join_date', { size: 11.5, weight: 700, ink: 'muted' });
  s.text(232, HY, 'probation_end_date', { size: 11.5, weight: 700, ink: 'muted' });
  s.text(400, HY, 'why', { size: 11.5, weight: 700, ink: 'muted' });

  const rows: [string, number, string, string, boolean][] = [
    ['2024-02-29', 3, '2024-05-29', '29 February join (required case): May has a 29th, so no clamping; joinDate round-trips as "2024-02-29".', false],
    ['2024-02-29', 6, '2024-08-29', 'Same day of the month, six months on.', false],
    ['2026-01-15', 3, '2026-04-15', 'The anniversary date (assumption A2).', false],
    ['2025-08-31', 6, '2026-02-28', 'Clamped: February 2026 has no 29th, 30th or 31st.', true],
    ['2023-08-31', 6, '2024-02-29', 'Clamped to the leap day: 2024 is a leap year.', true],
  ];
  rows.forEach(([join, months, end, why, clamped], i) => {
    const y = HY + 14 + i * 44;
    pill(24, y, join, 'store');
    s.line(136, y + 15, 230, y + 15, { ink: 'flow', arrow: true });
    s.text(183, y + 9, `+${months} months`, { size: 11, anchor: 'middle', ink: 'flow', mono: true });
    pill(232, y, end, 'store');
    if (clamped) s.text(352, y + 20, 'clamped', { size: 11, weight: 700, ink: 'flow' });
    s.text(400, y + 20, why, { size: 12, ink: clamped ? 'ink' : 'muted' });
  });

  // No chaining.
  const CY = HY + 14 + rows.length * 44 + 30;
  s.text(24, CY, 'Extensions never chain from the old end date', { size: 14, weight: 700 });
  s.text(24, CY + 20, 'Joined 2025-11-30 on 3 months (ends 2026-02-28, clamped), then extended by 1. The total becomes 4.', {
    size: 12,
    ink: 'muted',
  });
  const PY = CY + 44;
  pill(24, PY + 30, '2025-11-30', 'store');
  // Used: from join_date with the new total.
  s.path(`M 136 ${PY + 45} L 170 ${PY + 45} L 170 ${PY + 15} L 548 ${PY + 15}`, { ink: 'flow', arrow: true });
  s.text(190, PY + 8, 'join_date + 4 months (what the generated column does)', { size: 11.5, ink: 'flow', mono: true });
  pill(550, PY, '2026-03-30', 'success');
  s.text(674, PY + 20, '✓ correct: the 30th is kept', { size: 12, weight: 700, ink: 'success' });
  // Not used: chained.
  s.path(`M 136 ${PY + 45} L 170 ${PY + 45} L 170 ${PY + 75} L 298 ${PY + 75}`, { ink: 'muted', arrow: true, dash: true });
  s.text(180, PY + 98, '+3 months', { size: 11, ink: 'muted', mono: true });
  pill(300, PY + 60, '2026-02-28', 'store', true);
  s.line(412, PY + 75, 548, PY + 75, { ink: 'muted', arrow: true, dash: true });
  s.text(480, PY + 98, '+1 month', { size: 11, ink: 'muted', mono: true, anchor: 'middle' });
  pill(550, PY + 60, '2026-03-28', 'fault', true);
  s.text(674, PY + 80, '✗ chained: the clamp to the 28th is carried forward (not used)', { size: 12, ink: 'fault' });

  const FY = PY + 136;
  s.text(24, FY, 'Dates stay strings in Node: src/db.ts overrides pg’s DATE parser, so "2024-02-29" is never turned into a local-midnight JS Date,', {
    size: 12,
    ink: 'muted',
  });
  s.text(24, FY + 18, 'which would serialise as 2024-02-28 in UTC for Asia/Colombo (UTC+05:30).', { size: 12, ink: 'muted' });

  const H = FY + 18 + 52;
  s.legend(H - 22, ['flow', 'success', 'fault', 'store'], [{ label: 'dashed: the chained calculation, not used', dashed: true }]);
  return s.render(
    W,
    H,
    'Scenario: how the end date is calculated',
    'probation_end_date is a Postgres generated column: join_date plus total_probation_months months, recomputed on insert and on every update of the total. ' +
      'Examples: 2024-02-29 plus 3 months is 2024-05-29 and plus 6 is 2024-08-29; 2026-01-15 plus 3 is 2026-04-15; 2025-08-31 plus 6 is clamped to 2026-02-28; 2023-08-31 plus 6 is clamped to 2024-02-29. ' +
      'Extensions do not chain: joining 2025-11-30 on 3 months and extending by 1 gives 2026-03-30 (join date plus 4 months), not 2026-03-28 (the old clamped end date plus 1 month).',
  );
}

// ---------------------------------------------------------------------------------------------

const DIAGRAMS: Record<string, (t: Theme) => string> = {
  'request-pipeline': pipeline,
  'concurrent-confirm': concurrentConfirm,
  'employee-lifecycle': lifecycle,
  'company-isolation': isolation,
  'scenario-create-employee': createEmployeeSeq,
  'scenario-extend-probation': extendSeq,
  'scenario-extend-over-limit': extendOverLimitSeq,
  'scenario-concurrent-extensions': concurrentExtendSeq,
  'scenario-probation-list': probationList,
  'scenario-end-date': endDate,
};

const outDir = join(import.meta.dirname, '..', 'docs', 'diagrams');
mkdirSync(outDir, { recursive: true });
for (const [name, draw] of Object.entries(DIAGRAMS)) {
  for (const theme of [LIGHT, DARK]) {
    writeFileSync(join(outDir, `${name}-${theme.name}.svg`), draw(theme));
  }
}
console.log(`Wrote ${Object.keys(DIAGRAMS).length * 2} SVG files to docs/diagrams/`);
