ALTER TABLE dsh_session_preferences
  ADD COLUMN archive_position BIGINT UNSIGNED NULL,
  ADD UNIQUE KEY uq_archive_order (store_id,archive_position);

ALTER TABLE dsh_stores
  ADD COLUMN workspace_global_written BOOLEAN NULL DEFAULT NULL,
  ADD COLUMN workspace_owner_token BINARY(16) NULL,
  ADD COLUMN workspace_fence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN workspace_lease_expires DATETIME(6) NULL,
  ADD CONSTRAINT ck_workspace_global_written CHECK (workspace_global_written IN (0,1)),
  ADD CONSTRAINT ck_workspace_lease CHECK (
    (workspace_owner_token IS NULL AND workspace_lease_expires IS NULL) OR
    (workspace_owner_token IS NOT NULL AND workspace_lease_expires IS NOT NULL)
  );

ALTER TABLE dsh_session_preferences
  ADD CONSTRAINT ck_archive_position CHECK (
    (is_archived=0 AND archive_position IS NULL) OR
    (is_archived=1 AND archive_position IS NOT NULL AND pin_position IS NULL)
  );

ALTER TABLE dsh_stores
  MODIFY COLUMN workspace_global_written BOOLEAN NOT NULL DEFAULT FALSE;
