-- Up Migration

-- Tenants. Seeded only; there is no API to create them.
CREATE TABLE companies (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Current probation state of each employee.
CREATE TABLE employees (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid        NOT NULL REFERENCES companies (id) ON DELETE RESTRICT,
  name                     text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  join_date                date        NOT NULL,
  initial_probation_months smallint    NOT NULL CHECK (initial_probation_months BETWEEN 1 AND 6),
  -- The database guarantee of the 6-month rule.
  total_probation_months   smallint    NOT NULL CHECK (total_probation_months BETWEEN 1 AND 6),
  -- Always recomputed from join_date + the current total: month-end clamping, never chained.
  probation_end_date       date        GENERATED ALWAYS AS
                             ((join_date + make_interval(months => total_probation_months))::date) STORED,
  status                   text        NOT NULL DEFAULT 'on_probation'
                             CHECK (status IN ('on_probation', 'confirmed')),
  confirmed_at             timestamptz,
  confirmed_by             text
                             CHECK (confirmed_by IS NULL OR length(trim(confirmed_by)) BETWEEN 1 AND 100),
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT employees_total_gte_initial
    CHECK (total_probation_months >= initial_probation_months),
  -- Either fully on probation or fully confirmed; no half-filled states.
  CONSTRAINT employees_confirmation_consistent CHECK (
       (status = 'on_probation' AND confirmed_at IS NULL     AND confirmed_by IS NULL)
    OR (status = 'confirmed'    AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)
  ),
  -- Target of the composite foreign keys below.
  CONSTRAINT employees_company_id_id_key UNIQUE (company_id, id)
);

-- Business history of extensions.
CREATE TABLE probation_extensions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL,
  employee_id       uuid        NOT NULL,
  months            smallint    NOT NULL CHECK (months BETWEEN 1 AND 3),
  reason            text        NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  actor             text        NOT NULL CHECK (length(trim(actor)) BETWEEN 1 AND 100),
  previous_end_date date        NOT NULL,
  new_end_date      date        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT probation_extensions_dates_check CHECK (new_end_date > previous_end_date),
  -- Composite FK: the extension must belong to the SAME company as its employee.
  CONSTRAINT probation_extensions_employee_fkey FOREIGN KEY (company_id, employee_id)
    REFERENCES employees (company_id, id) ON DELETE RESTRICT
);

-- Append-only log: who, what, when.
CREATE TABLE audit_events (
  id          bigint      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  company_id  uuid        NOT NULL,
  employee_id uuid        NOT NULL,
  action      text        NOT NULL
                CHECK (action IN ('employee.created', 'probation.confirmed', 'probation.extended')),
  actor       text        NOT NULL CHECK (length(trim(actor)) BETWEEN 1 AND 100),
  details     jsonb       NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_events_employee_fkey FOREIGN KEY (company_id, employee_id)
    REFERENCES employees (company_id, id) ON DELETE RESTRICT
);

-- Matches the list query exactly; confirmed rows are left out.
CREATE INDEX employees_open_probations_idx
  ON employees (company_id, probation_end_date) WHERE status = 'on_probation';

CREATE INDEX probation_extensions_employee_idx
  ON probation_extensions (company_id, employee_id);

CREATE INDEX audit_events_employee_idx
  ON audit_events (company_id, employee_id, id);

-- Backstop: at most one confirmation event per employee, ever.
CREATE UNIQUE INDEX audit_events_one_confirmation_idx
  ON audit_events (employee_id) WHERE action = 'probation.confirmed';

-- Down Migration

DROP TABLE audit_events;
DROP TABLE probation_extensions;
DROP TABLE employees;
DROP TABLE companies;
