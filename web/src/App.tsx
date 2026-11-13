import { useEffect, useState } from 'react';

// Read-only view of GET /probations. The demo headers are set from the company selector,
// exactly like any other API client (they are not authentication).

type Bucket = 'overdue' | 'dueWithin7Days' | 'dueWithin30Days' | 'dueLater';

type Probation = {
  id: string;
  name: string;
  joinDate: string;
  probationEndDate: string;
  totalProbationMonths: number;
  daysUntilEnd: number;
};

type ProbationList = {
  asOf: string;
  withinDays: number;
  counts: Record<Bucket, number>;
} & Record<Bucket, Probation[]>;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: ProbationList };

// There is no companies endpoint (companies are seeded only), so the page lists the two
// companies created by `npm run seed`.
const COMPANIES = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Acme Lanka (Pvt) Ltd' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Beta Exports (Pvt) Ltd' },
];

const WINDOWS = [0, 7, 30, 60, 90, 365];

const GROUPS: { key: Bucket; title: string }[] = [
  { key: 'overdue', title: 'Overdue' },
  { key: 'dueWithin7Days', title: 'Due within 7 days' },
  { key: 'dueWithin30Days', title: 'Due within 30 days' },
  { key: 'dueLater', title: 'Due later' },
];

function describeDays(days: number): string {
  if (days === 0) return 'Ends today';
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} overdue`;
  return `In ${days} day${days === 1 ? '' : 's'}`;
}

async function fetchProbations(
  companyId: string,
  withinDays: number,
  signal: AbortSignal,
): Promise<ProbationList> {
  const res = await fetch(`/api/probations?withinDays=${withinDays}`, {
    headers: { 'X-Company-Id': companyId, 'X-Actor-Id': 'web-demo' },
    signal,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (HTTP ${res.status})`);
  return body as ProbationList;
}

export function App() {
  const [companyId, setCompanyId] = useState(COMPANIES[0]!.id);
  const [withinDays, setWithinDays] = useState(30);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    // Abort the previous request when the selection changes, so a slow old response
    // can never overwrite a newer one.
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchProbations(companyId, withinDays, controller.signal).then(
      (data) => setState({ status: 'ok', data }),
      (err: Error) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: err.message });
      },
    );
    return () => controller.abort();
  }, [companyId, withinDays]);

  return (
    <main>
      <header>
        <h1>Probation reviews</h1>
        {state.status === 'ok' && <p className="as-of">As of {state.data.asOf}</p>}
      </header>

      <div className="controls">
        <label>
          Company
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            {COMPANIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ending within
          <select value={withinDays} onChange={(e) => setWithinDays(Number(e.target.value))}>
            {WINDOWS.map((n) => (
              <option key={n} value={n}>
                {n} days
              </option>
            ))}
          </select>
        </label>
      </div>

      {state.status === 'loading' && <p className="message">Loading…</p>}
      {state.status === 'error' && (
        <p className="message error" role="alert">
          Could not load probations: {state.message}. Is the API running (npm run dev) and
          seeded (npm run seed)?
        </p>
      )}
      {state.status === 'ok' &&
        GROUPS.map(({ key, title }) => (
          <section key={key} className={`group ${key}`} aria-labelledby={`${key}-title`}>
            <h2 id={`${key}-title`}>
              {title} <span className="count">{state.data.counts[key]}</span>
            </h2>
            {state.data[key].length === 0 ? (
              <p className="empty">None</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Joined</th>
                      <th scope="col">Probation ends</th>
                      <th scope="col">Months</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.data[key].map((p) => (
                      <tr key={p.id}>
                        <td>{p.name}</td>
                        <td>{p.joinDate}</td>
                        <td>{p.probationEndDate}</td>
                        <td>{p.totalProbationMonths}</td>
                        <td className="days">{describeDays(p.daysUntilEnd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
    </main>
  );
}
