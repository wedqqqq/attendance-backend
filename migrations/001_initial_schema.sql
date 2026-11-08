-- ============================================================
-- Attendance System — Full Schema Migration
-- Target: PostgreSQL 14+ (Neon)
-- Run order matters: FK deps top→bottom
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── ENUM TYPES ───────────────────────────────────────────────────────────────

CREATE TYPE user_role       AS ENUM ('admin', 'employee');
CREATE TYPE user_status     AS ENUM ('active', 'inactive', 'suspended');
CREATE TYPE device_status   AS ENUM ('active', 'revoked', 'pending');
CREATE TYPE qr_status       AS ENUM ('active', 'expired', 'revoked');
CREATE TYPE att_type        AS ENUM ('check_in', 'check_out');
CREATE TYPE att_status      AS ENUM ('valid', 'invalid', 'pending');
CREATE TYPE session_status  AS ENUM ('active', 'paused', 'completed', 'voided');
CREATE TYPE loc_status      AS ENUM ('live', 'stale', 'unknown');
CREATE TYPE geo_event_type  AS ENUM ('enter', 'exit', 'violation', 'return', 'warning');
CREATE TYPE violation_type  AS ENUM ('geofence', 'duplicate_checkin', 'invalid_qr', 'device_mismatch');
CREATE TYPE violation_status AS ENUM ('open', 'acknowledged', 'resolved', 'dismissed');
CREATE TYPE audit_action    AS ENUM (
  'login', 'logout', 'create', 'update', 'delete',
  'assign', 'unassign', 'generate_qr', 'export', 'password_change'
);

-- ─── 1. USERS ────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username        VARCHAR(50)  NOT NULL UNIQUE,
  email           VARCHAR(255) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  role            user_role    NOT NULL DEFAULT 'employee',
  status          user_status  NOT NULL DEFAULT 'active',
  full_name       VARCHAR(100) NOT NULL,
  phone           VARCHAR(20),
  avatar_url      VARCHAR(500),
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email    ON users(email);
CREATE INDEX idx_users_role     ON users(role);
CREATE INDEX idx_users_status   ON users(status);

-- ─── 2. REFRESH TOKENS ───────────────────────────────────────────────────────

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  device_id   UUID,
  expires_at  TIMESTAMPTZ  NOT NULL,
  revoked     BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash    ON refresh_tokens(token_hash);

-- ─── 3. DEVICES ──────────────────────────────────────────────────────────────

CREATE TABLE devices (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_token    VARCHAR(255) NOT NULL UNIQUE,
  device_name     VARCHAR(100),
  platform        VARCHAR(20)  NOT NULL DEFAULT 'ios',
  os_version      VARCHAR(20),
  app_version     VARCHAR(20),
  status          device_status NOT NULL DEFAULT 'active',
  last_seen_at    TIMESTAMPTZ,
  registered_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_devices_user_id      ON devices(user_id);
CREATE INDEX idx_devices_token        ON devices(device_token);
CREATE INDEX idx_devices_status       ON devices(status);

-- ─── 4. BRANCHES (Quầy) ──────────────────────────────────────────────────────

CREATE TABLE branches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(100) NOT NULL,
  code            VARCHAR(20)  NOT NULL UNIQUE,
  address         VARCHAR(255),
  latitude        DOUBLE PRECISION NOT NULL,
  longitude       DOUBLE PRECISION NOT NULL,
  checkin_radius  INTEGER      NOT NULL DEFAULT 50    CHECK (checkin_radius > 0),
  active_radius   INTEGER      NOT NULL DEFAULT 400   CHECK (active_radius > 0),
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by      UUID         NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_branches_code      ON branches(code);
CREATE INDEX idx_branches_is_active ON branches(is_active);

-- ─── 5. WORK ZONES (extra geofence polygons, optional) ───────────────────────

CREATE TABLE work_zones (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id   UUID   NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  label       VARCHAR(50),
  radius      INTEGER NOT NULL DEFAULT 50,
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_work_zones_branch ON work_zones(branch_id);

-- ─── 6. EMPLOYEE ASSIGNMENTS ─────────────────────────────────────────────────

CREATE TABLE employee_assignments (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id    UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  assigned_by  UUID NOT NULL REFERENCES users(id),
  valid_from   DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until  DATE,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, branch_id, valid_from)
);

CREATE INDEX idx_assignments_user   ON employee_assignments(user_id);
CREATE INDEX idx_assignments_branch ON employee_assignments(branch_id);
CREATE INDEX idx_assignments_active ON employee_assignments(is_active);

-- ─── 7. DAILY QR CODES ───────────────────────────────────────────────────────

CREATE TABLE daily_qr_codes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id       UUID        NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  qr_date         DATE        NOT NULL,
  token           VARCHAR(255) NOT NULL UNIQUE,
  hmac_signature  VARCHAR(255) NOT NULL,
  status          qr_status   NOT NULL DEFAULT 'active',
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID        REFERENCES users(id),
  UNIQUE (branch_id, qr_date)
);

CREATE INDEX idx_qr_branch_date ON daily_qr_codes(branch_id, qr_date);
CREATE INDEX idx_qr_token       ON daily_qr_codes(token);
CREATE INDEX idx_qr_status      ON daily_qr_codes(status);

-- ─── 8. ATTENDANCE ───────────────────────────────────────────────────────────

CREATE TABLE attendance (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id       UUID         NOT NULL REFERENCES branches(id),
  device_id       UUID         REFERENCES devices(id),
  qr_code_id      UUID         REFERENCES daily_qr_codes(id),
  att_type        att_type     NOT NULL,
  att_status      att_status   NOT NULL DEFAULT 'pending',
  latitude        DOUBLE PRECISION NOT NULL,
  longitude       DOUBLE PRECISION NOT NULL,
  gps_accuracy    DOUBLE PRECISION,
  distance_meters DOUBLE PRECISION,
  timestamp       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  note            TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_att_user_id   ON attendance(user_id);
CREATE INDEX idx_att_branch_id ON attendance(branch_id);
CREATE INDEX idx_att_timestamp ON attendance(timestamp);
CREATE INDEX idx_att_type      ON attendance(att_type);
CREATE INDEX idx_att_date      ON attendance(DATE(timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'));

-- ─── 9. WORK SESSIONS ────────────────────────────────────────────────────────

CREATE TABLE work_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id       UUID           NOT NULL REFERENCES branches(id),
  check_in_id     UUID           REFERENCES attendance(id),
  check_out_id    UUID           REFERENCES attendance(id),
  session_date    DATE           NOT NULL,
  started_at      TIMESTAMPTZ    NOT NULL,
  ended_at        TIMESTAMPTZ,
  status          session_status NOT NULL DEFAULT 'active',
  total_seconds   INTEGER        GENERATED ALWAYS AS (
                    CASE WHEN ended_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER
                    ELSE NULL END
                  ) STORED,
  violation_count INTEGER        NOT NULL DEFAULT 0,
  note            TEXT,
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user    ON work_sessions(user_id);
CREATE INDEX idx_sessions_branch  ON work_sessions(branch_id);
CREATE INDEX idx_sessions_date    ON work_sessions(session_date);
CREATE INDEX idx_sessions_status  ON work_sessions(status);

-- ─── 10. EMPLOYEE LOCATIONS ──────────────────────────────────────────────────

CREATE TABLE employee_locations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      UUID         REFERENCES work_sessions(id),
  latitude        DOUBLE PRECISION NOT NULL,
  longitude       DOUBLE PRECISION NOT NULL,
  accuracy        DOUBLE PRECISION,
  loc_status      loc_status   NOT NULL DEFAULT 'live',
  is_synced       BOOLEAN      NOT NULL DEFAULT TRUE,
  client_time     TIMESTAMPTZ  NOT NULL,
  server_time     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_locations_user    ON employee_locations(user_id);
CREATE INDEX idx_locations_session ON employee_locations(session_id);
CREATE INDEX idx_locations_time    ON employee_locations(server_time DESC);
-- partial index: only keep latest per user for map queries
CREATE INDEX idx_locations_latest  ON employee_locations(user_id, server_time DESC);

-- ─── 11. GEOFENCE EVENTS ─────────────────────────────────────────────────────

CREATE TABLE geofence_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      UUID           REFERENCES work_sessions(id),
  branch_id       UUID           NOT NULL REFERENCES branches(id),
  event_type      geo_event_type NOT NULL,
  latitude        DOUBLE PRECISION NOT NULL,
  longitude       DOUBLE PRECISION NOT NULL,
  distance_meters DOUBLE PRECISION,
  grace_expires_at TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_geo_user    ON geofence_events(user_id);
CREATE INDEX idx_geo_session ON geofence_events(session_id);
CREATE INDEX idx_geo_type    ON geofence_events(event_type);

-- ─── 12. VIOLATIONS ──────────────────────────────────────────────────────────

CREATE TABLE violations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      UUID             REFERENCES work_sessions(id),
  branch_id       UUID             REFERENCES branches(id),
  violation_type  violation_type   NOT NULL,
  violation_status violation_status NOT NULL DEFAULT 'open',
  description     TEXT,
  metadata        JSONB,
  occurred_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID             REFERENCES users(id),
  created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_violations_user    ON violations(user_id);
CREATE INDEX idx_violations_session ON violations(session_id);
CREATE INDEX idx_violations_status  ON violations(violation_status);
CREATE INDEX idx_violations_type    ON violations(violation_type);

-- ─── 13. LOCATION CONSENT ────────────────────────────────────────────────────

CREATE TABLE location_consent (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  consented       BOOLEAN NOT NULL DEFAULT FALSE,
  consented_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  device_id       UUID    REFERENCES devices(id),
  ip_address      INET,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_consent_user ON location_consent(user_id);

-- ─── 14. AUDIT LOGS ──────────────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID         REFERENCES users(id) ON DELETE SET NULL,
  action       audit_action NOT NULL,
  entity_type  VARCHAR(50),
  entity_id    UUID,
  old_data     JSONB,
  new_data     JSONB,
  ip_address   INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user      ON audit_logs(user_id);
CREATE INDEX idx_audit_action    ON audit_logs(action);
CREATE INDEX idx_audit_entity    ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_created   ON audit_logs(created_at DESC);

-- ─── TRIGGERS: updated_at auto-update ────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_devices_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_branches_updated_at
  BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_sessions_updated_at
  BEFORE UPDATE ON work_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
