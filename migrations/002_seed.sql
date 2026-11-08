-- ============================================================
-- Seed data — dev/testing only
-- Admin password: Admin@123456
-- Employee password: Employee@123
-- ============================================================

INSERT INTO users (id, username, email, password_hash, role, full_name, phone)
VALUES
  ('00000000-0000-0000-0000-000000000001',
   'admin',
   'admin@company.com',
   '$2a$12$LzMHv0VH3VNV.gOpLfhF4.8hGtbzrDU9OW2pGC.wN8kM3aR5y6B/2', -- Admin@123456
   'admin',
   'Quản trị viên',
   '0901234567'),
  ('00000000-0000-0000-0000-000000000002',
   'nguyen.van.a',
   'nva@company.com',
   '$2a$12$XKgPfh.wMkbJ1Z6X.wQa8O0vkFqXqV2FVeM7fGLlJQY3kUoOexrky', -- Employee@123
   'employee',
   'Nguyễn Văn A',
   '0912345678'),
  ('00000000-0000-0000-0000-000000000003',
   'tran.thi.b',
   'ttb@company.com',
   '$2a$12$XKgPfh.wMkbJ1Z6X.wQa8O0vkFqXqV2FVeM7fGLlJQY3kUoOexrky', -- Employee@123
   'employee',
   'Trần Thị B',
   '0923456789');

INSERT INTO branches (id, name, code, address, latitude, longitude, checkin_radius, active_radius, created_by)
VALUES
  ('00000000-0000-0000-0000-000000000010',
   'Quầy A - Tầng 1',
   'BRANCH-A',
   '123 Đường ABC, Hà Nội',
   21.0285,
   105.8542,
   50,
   400,
   '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000011',
   'Quầy B - Tầng 2',
   'BRANCH-B',
   '123 Đường ABC, Hà Nội',
   21.0290,
   105.8548,
   50,
   400,
   '00000000-0000-0000-0000-000000000001');

INSERT INTO employee_assignments (user_id, branch_id, assigned_by, valid_from)
VALUES
  ('00000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000001',
   CURRENT_DATE),
  ('00000000-0000-0000-0000-000000000003',
   '00000000-0000-0000-0000-000000000011',
   '00000000-0000-0000-0000-000000000001',
   CURRENT_DATE);

INSERT INTO location_consent (user_id, consented, consented_at)
VALUES
  ('00000000-0000-0000-0000-000000000002', TRUE, NOW()),
  ('00000000-0000-0000-0000-000000000003', TRUE, NOW());
