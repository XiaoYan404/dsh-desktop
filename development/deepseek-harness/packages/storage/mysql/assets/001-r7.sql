SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin;
SET time_zone = '+00:00';

CREATE TABLE dsh_schema_migrations (
  schema_version INT UNSIGNED NOT NULL COMMENT '数据库结构版本，与会话格式独立',
  migration_name VARCHAR(191) NOT NULL COMMENT '迁移名称',
  script_sha256 BINARY(32) NOT NULL COMMENT '实际迁移脚本的 SHA256',
  applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '完成时间 UTC',
  PRIMARY KEY (schema_version)
) ENGINE=InnoDB COMMENT='数据库结构迁移记录';

CREATE TABLE dsh_stores (
  store_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '数据空间内部主键',
  store_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '部署分配的稳定命名空间',
  display_name VARCHAR(255) NOT NULL COMMENT '显示名称',
  workspace_domain_version INT UNSIGNED NOT NULL DEFAULT 2 COMMENT '工作区领域版本',
  registry_initialized BOOLEAN NOT NULL DEFAULT FALSE COMMENT '原 global.initialized',
  default_workspace_external_id LONGTEXT NULL COMMENT '首次工作区 ID，删除工作区后仍保留',
  registry_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '工作区全局状态 CAS 版本',
  search_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已发布搜索语料与可见性版本',
  search_analyzer_version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'MySQL 搜索语义配置版本',
  search_config_json JSON NOT NULL COMMENT 'ngram、停用词、提取器等配置指纹',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (store_id),
  UNIQUE KEY uq_store_key (store_key),
  CONSTRAINT ck_store_initialized CHECK (registry_initialized IN (0,1)),
  CONSTRAINT ck_store_search_config CHECK (JSON_TYPE(search_config_json) = 'OBJECT')
) ENGINE=InnoDB COMMENT='Harness 数据空间及工作区全局状态';

CREATE TABLE dsh_session_slots (
  slot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '业务会话 ID 槽位',
  store_id BIGINT UNSIGNED NOT NULL,
  external_session_id LONGTEXT NOT NULL COMMENT '原 SessionId，按 UTF8 字节保留',
  external_id_hash BINARY(32)
    GENERATED ALWAYS AS (UNHEX(SHA2(external_session_id,256))) STORED,
  current_lifecycle_id BINARY(16) NULL COMMENT '当前生命周期，未解析或已删除时为空',
  current_format_version INT UNSIGNED NULL COMMENT '当前已发布日志版本',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (slot_id),
  UNIQUE KEY uq_slot_store_pk (store_id,slot_id),
  UNIQUE KEY uq_slot_external (store_id,external_id_hash),
  CONSTRAINT fk_slot_store FOREIGN KEY (store_id) REFERENCES dsh_stores(store_id),
  CONSTRAINT ck_slot_id CHECK (OCTET_LENGTH(external_session_id) > 0),
  CONSTRAINT ck_slot_pointer CHECK (
    (current_lifecycle_id IS NULL AND current_format_version IS NULL) OR
    (current_lifecycle_id IS NOT NULL AND current_format_version IS NOT NULL)
  )
) ENGINE=InnoDB COMMENT='业务会话 ID 到当前生命周期及代际的映射';

CREATE TABLE dsh_workspaces (
  workspace_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id BIGINT UNSIGNED NOT NULL,
  external_workspace_id LONGTEXT NOT NULL COMMENT '原 WorkspaceId',
  external_id_hash BINARY(32)
    GENERATED ALWAYS AS (UNHEX(SHA2(external_workspace_id,256))) STORED,
  canonical_path LONGTEXT NOT NULL COMMENT '原 fs.realpath 规范路径，不由数据库改变大小写',
  path_hash BINARY(32)
    GENERATED ALWAYS AS (UNHEX(SHA2(canonical_path,256))) STORED,
  title LONGTEXT NOT NULL COMMENT '原显示标题',
  created_at_iso VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '原 ISO8601 文本',
  updated_at_iso VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '原 ISO8601 文本',
  record_revision BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '记录 CAS 版本',
  PRIMARY KEY (workspace_pk),
  UNIQUE KEY uq_workspace_store_pk (store_id,workspace_pk),
  UNIQUE KEY uq_workspace_external (store_id,external_id_hash),
  UNIQUE KEY uq_workspace_path (store_id,path_hash),
  CONSTRAINT fk_workspace_store FOREIGN KEY (store_id) REFERENCES dsh_stores(store_id),
  CONSTRAINT ck_workspace_id CHECK (OCTET_LENGTH(external_workspace_id) > 0),
  CONSTRAINT ck_workspace_path CHECK (OCTET_LENGTH(canonical_path) > 0)
) ENGINE=InnoDB COMMENT='工作区权威记录';

CREATE TABLE dsh_workspace_order (
  store_id BIGINT UNSIGNED NOT NULL,
  workspace_pk BIGINT UNSIGNED NOT NULL,
  position_no BIGINT UNSIGNED NOT NULL COMMENT '原 global.workspaceIds 的零基位置',
  PRIMARY KEY (store_id,workspace_pk),
  UNIQUE KEY uq_workspace_order (store_id,position_no),
  CONSTRAINT fk_workspace_order FOREIGN KEY (store_id,workspace_pk)
    REFERENCES dsh_workspaces(store_id,workspace_pk)
) ENGINE=InnoDB COMMENT='工作区全局顺序';

CREATE TABLE dsh_workspace_sessions (
  store_id BIGINT UNSIGNED NOT NULL,
  workspace_pk BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  position_no BIGINT UNSIGNED NOT NULL COMMENT '原 workspace.sessionIds 的候选位置',
  PRIMARY KEY (store_id,workspace_pk,slot_id),
  UNIQUE KEY uq_session_one_workspace (store_id,slot_id),
  UNIQUE KEY uq_workspace_session_order (store_id,workspace_pk,position_no),
  CONSTRAINT fk_ws_session_workspace FOREIGN KEY (store_id,workspace_pk)
    REFERENCES dsh_workspaces(store_id,workspace_pk),
  CONSTRAINT fk_ws_session_slot FOREIGN KEY (store_id,slot_id)
    REFERENCES dsh_session_slots(store_id,slot_id)
) ENGINE=InnoDB COMMENT='工作区有序会话候选账本';

CREATE TABLE dsh_session_preferences (
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE COMMENT '原全局 archivedSessionIds 集合',
  pin_position BIGINT UNSIGNED NULL COMMENT '原全局 pinnedSessionIds 顺序，空表示未置顶',
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (store_id,slot_id),
  UNIQUE KEY uq_pin_order (store_id,pin_position),
  KEY ix_archived (store_id,is_archived,slot_id),
  CONSTRAINT fk_preferences_slot FOREIGN KEY (store_id,slot_id)
    REFERENCES dsh_session_slots(store_id,slot_id),
  CONSTRAINT ck_archived CHECK (is_archived IN (0,1)),
  CONSTRAINT ck_archive_pin CHECK (is_archived = 0 OR pin_position IS NULL)
) ENGINE=InnoDB COMMENT='会话归档与置顶，独立于工作区顺序';

CREATE TABLE dsh_session_logs (
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  lifecycle_id BINARY(16) NOT NULL,
  format_version INT UNSIGNED NOT NULL COMMENT '当前源码为4，后续版本逐代新增',
  log_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'staging/active/sealed/quarantined',
  header_json JSON NOT NULL COMMENT '完整不可变 SessionHeader',
  session_created_at_ms BIGINT UNSIGNED NOT NULL COMMENT 'header.createdAt',
  initial_cwd LONGTEXT NULL COMMENT 'header.cwd；SQL NULL 表示字段缺省',
  cwd_hash BINARY(32)
    GENERATED ALWAYS AS (UNHEX(SHA2(initial_cwd,256))) STORED,
  parent_slot_id BIGINT UNSIGNED NULL COMMENT 'header.parentSession 对应槽位，不等同于所有 subagent 父级',
  is_seeded BOOLEAN NOT NULL COMMENT 'header.isSeeded',
  inherited_event_count BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '精确 Fork 继承前缀长度，独立于 header',
  origin VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '当前为 subagent 或缺省',
  delegation_depth BIGINT UNSIGNED NULL COMMENT '保留缺省与显式0的区别',
  agent_preset LONGTEXT NULL COMMENT 'header.agentPreset',
  event_count BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已提交事件数量，同时是下一合法 seq',
  log_revision BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '只有日志或代际内容变化才改变',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (store_id,slot_id,lifecycle_id,format_version),
  KEY ix_log_created (store_id,session_created_at_ms,slot_id),
  KEY ix_log_cwd (store_id,cwd_hash,slot_id),
  KEY ix_log_parent (store_id,parent_slot_id,slot_id),
  CONSTRAINT fk_log_slot FOREIGN KEY (store_id,slot_id)
    REFERENCES dsh_session_slots(store_id,slot_id),
  CONSTRAINT fk_log_parent FOREIGN KEY (store_id,parent_slot_id)
    REFERENCES dsh_session_slots(store_id,slot_id),
  CONSTRAINT ck_log_state CHECK (log_state IN ('staging','active','sealed','quarantined')),
  CONSTRAINT ck_log_seed CHECK (is_seeded IN (0,1) AND (is_seeded = 1 OR inherited_event_count = 0)),
  CONSTRAINT ck_log_inherited CHECK (inherited_event_count <= event_count),
  CONSTRAINT ck_log_numbers CHECK (
    session_created_at_ms <= 9007199254740991 AND event_count <= 9007199254740991
    AND (delegation_depth IS NULL OR delegation_depth <= 9007199254740991)
  ),
  CONSTRAINT ck_log_header CHECK (
    JSON_TYPE(header_json) = 'OBJECT'
    AND JSON_CONTAINS_PATH(header_json,'all','$.id','$.version','$.createdAt','$.isSeeded') = 1
    AND JSON_TYPE(JSON_EXTRACT(header_json,'$.id')) = 'STRING'
    AND JSON_TYPE(JSON_EXTRACT(header_json,'$.version')) = 'INTEGER'
    AND JSON_TYPE(JSON_EXTRACT(header_json,'$.createdAt')) = 'INTEGER'
    AND JSON_TYPE(JSON_EXTRACT(header_json,'$.isSeeded')) = 'BOOLEAN'
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(header_json,'$.version')) AS UNSIGNED) = format_version
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(header_json,'$.createdAt')) AS UNSIGNED) = session_created_at_ms
  )
) ENGINE=InnoDB COMMENT='会话生命周期及格式代际';

ALTER TABLE dsh_session_slots
  ADD CONSTRAINT fk_slot_current_log
  FOREIGN KEY (store_id,slot_id,current_lifecycle_id,current_format_version)
  REFERENCES dsh_session_logs(store_id,slot_id,lifecycle_id,format_version);

CREATE TABLE dsh_session_events (
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  lifecycle_id BINARY(16) NOT NULL,
  format_version INT UNSIGNED NOT NULL,
  seq BIGINT UNSIGNED NOT NULL COMMENT '从0连续递增',
  event_type VARCHAR(191) NOT NULL COMMENT '完整事件类型，保留插件扩展',
  event_time_ms BIGINT UNSIGNED NOT NULL COMMENT '原 event.time',
  turn_no BIGINT UNSIGNED NULL COMMENT '仅在原事件有该字段时提取',
  step_no BIGINT UNSIGNED NULL COMMENT '仅在原事件有该字段时提取',
  ignorable BOOLEAN NOT NULL DEFAULT FALSE COMMENT '导出时 false 还原为字段缺省',
  surface_op VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'none',
  replace_start_seq BIGINT UNSIGNED NULL,
  replace_end_seq BIGINT UNSIGNED NULL,
  event_json LONGTEXT NOT NULL COMMENT '完整原事件的适配器序列化文本',
  event_sha256 BINARY(32)
    GENERATED ALWAYS AS (UNHEX(SHA2(event_json,256))) STORED,
  PRIMARY KEY (store_id,slot_id,lifecycle_id,format_version,seq),
  KEY ix_event_type (store_id,slot_id,lifecycle_id,format_version,event_type,seq),
  KEY ix_event_time (store_id,slot_id,lifecycle_id,format_version,event_time_ms,seq),
  KEY ix_event_step (store_id,slot_id,lifecycle_id,format_version,turn_no,step_no,seq),
  CONSTRAINT fk_event_log FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version)
    REFERENCES dsh_session_logs(store_id,slot_id,lifecycle_id,format_version),
  CONSTRAINT ck_event_numbers CHECK (
    seq <= 9007199254740991 AND event_time_ms <= 9007199254740991
    AND (turn_no IS NULL OR turn_no <= 9007199254740991)
    AND (step_no IS NULL OR step_no <= 9007199254740991)
  ),
  CONSTRAINT ck_event_ignorable CHECK (ignorable IN (0,1)),
  CONSTRAINT ck_event_surface CHECK (
    (surface_op IN ('none','append') AND replace_start_seq IS NULL AND replace_end_seq IS NULL)
    OR (surface_op = 'replace' AND replace_start_seq IS NOT NULL AND replace_end_seq IS NOT NULL
        AND replace_start_seq <= replace_end_seq AND replace_end_seq < seq)
  ),
  CONSTRAINT ck_event_json CHECK (
    JSON_VALID(event_json) = 1
    AND JSON_TYPE(event_json) = 'OBJECT'
    AND JSON_CONTAINS_PATH(event_json,'all','$.seq','$.type','$.time','$.data') = 1
    AND JSON_TYPE(JSON_EXTRACT(event_json,'$.seq')) = 'INTEGER'
    AND JSON_TYPE(JSON_EXTRACT(event_json,'$.time')) = 'INTEGER'
    AND JSON_TYPE(JSON_EXTRACT(event_json,'$.type')) = 'STRING'
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.seq')) AS UNSIGNED) = seq
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.time')) AS UNSIGNED) = event_time_ms
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type')) AS BINARY) = CAST(event_type AS BINARY)
  )
) ENGINE=InnoDB COMMENT='仅追加的完整会话事件';

CREATE TABLE dsh_event_sources (
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  lifecycle_id BINARY(16) NOT NULL,
  format_version INT UNSIGNED NOT NULL,
  target_seq BIGINT UNSIGNED NOT NULL COMMENT '引用来源的事件',
  source_seq BIGINT UNSIGNED NOT NULL COMMENT '被引用的早期事件',
  PRIMARY KEY (store_id,slot_id,lifecycle_id,format_version,target_seq,source_seq),
  KEY ix_source_reverse (store_id,slot_id,lifecycle_id,format_version,source_seq,target_seq),
  CONSTRAINT fk_source_target FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version,target_seq)
    REFERENCES dsh_session_events(store_id,slot_id,lifecycle_id,format_version,seq),
  CONSTRAINT fk_source_origin FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version,source_seq)
    REFERENCES dsh_session_events(store_id,slot_id,lifecycle_id,format_version,seq),
  CONSTRAINT ck_source_before CHECK (source_seq < target_seq)
) ENGINE=InnoDB COMMENT='sourceEventSeqs 派生追踪边';

CREATE TABLE dsh_writer_leases (
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  fence_token BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '每次重新取得所有权递增，释放不归零',
  owner_token BINARY(16) NULL COMMENT '当前写句柄随机身份',
  lifecycle_id BINARY(16) NULL COMMENT '写句柄绑定的生命周期',
  expires_at DATETIME(6) NULL COMMENT '以数据库 UTC 时间判定',
  owner_label VARCHAR(191) NULL COMMENT '实例诊断名称',
  PRIMARY KEY (store_id,slot_id),
  CONSTRAINT fk_lease_slot FOREIGN KEY (store_id,slot_id)
    REFERENCES dsh_session_slots(store_id,slot_id),
  CONSTRAINT ck_lease_complete CHECK (
    (owner_token IS NULL AND lifecycle_id IS NULL AND expires_at IS NULL)
    OR (owner_token IS NOT NULL AND lifecycle_id IS NOT NULL AND expires_at IS NOT NULL)
  )
) ENGINE=InnoDB COMMENT='跨 Host 单写者租约';

CREATE TABLE dsh_append_batches (
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  lifecycle_id BINARY(16) NOT NULL,
  format_version INT UNSIGNED NOT NULL,
  batch_id BINARY(16) NOT NULL COMMENT '重试沿用同一个 UUID',
  first_seq BIGINT UNSIGNED NOT NULL,
  batch_event_count BIGINT UNSIGNED NOT NULL,
  payload_sha256 BINARY(32) NOT NULL COMMENT '按协议序列化的完整批次哈希',
  committed_revision BIGINT UNSIGNED NOT NULL,
  writer_fence BIGINT UNSIGNED NOT NULL,
  committed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (store_id,slot_id,lifecycle_id,format_version,batch_id),
  UNIQUE KEY uq_batch_start (store_id,slot_id,lifecycle_id,format_version,first_seq),
  CONSTRAINT fk_batch_log FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version)
    REFERENCES dsh_session_logs(store_id,slot_id,lifecycle_id,format_version),
  CONSTRAINT ck_batch_count CHECK (
    batch_event_count > 0 AND first_seq <= 9007199254740991
    AND batch_event_count <= 9007199254740991 - first_seq
  )
) ENGINE=InnoDB COMMENT='追加事务的幂等回执';

CREATE TABLE dsh_projection_checkpoints (
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  lifecycle_id BINARY(16) NOT NULL,
  format_version INT UNSIGNED NOT NULL,
  cache_record_version INT UNSIGNED NOT NULL COMMENT '当前为7，兼容旧版本由适配器判断',
  identity_json JSON NOT NULL COMMENT '原 checkpoint.identity 的完整值',
  checkpoint_revision BIGINT UNSIGNED NOT NULL COMMENT '整份检查点 CAS 版本',
  observed_log_revision BIGINT UNSIGNED NOT NULL COMMENT '计算检查点时观察到的日志版本',
  observed_event_count BIGINT UNSIGNED NOT NULL COMMENT '不可变输入前缀长度',
  unit_count INT UNSIGNED NOT NULL COMMENT '本次完整检查点 key 数量，可为0',
  written_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (store_id,slot_id,lifecycle_id,format_version),
  CONSTRAINT fk_checkpoint_log FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version)
    REFERENCES dsh_session_logs(store_id,slot_id,lifecycle_id,format_version),
  CONSTRAINT ck_checkpoint_identity CHECK (
    JSON_TYPE(identity_json) = 'OBJECT'
    AND JSON_CONTAINS_PATH(identity_json,'all','$.formatVersion','$.createdAt','$.isSeeded','$.inheritedEventCount') = 1
  ),
  CONSTRAINT ck_checkpoint_count CHECK (observed_event_count <= 9007199254740991)
) ENGINE=InnoDB COMMENT='绑定日志身份的整份投影检查点';

CREATE TABLE dsh_projection_states (
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  lifecycle_id BINARY(16) NOT NULL,
  format_version INT UNSIGNED NOT NULL,
  projection_key VARCHAR(191) NOT NULL COMMENT 'title/model/preset 等动态 key',
  state_version INT UNSIGNED NOT NULL COMMENT '原 row.ver，独立于记录版本',
  last_seq BIGINT NOT NULL COMMENT '原 row.seq，空输入为-1',
  state_json JSON NOT NULL COMMENT '原 row.val：内部状态，可为 JSON null',
  PRIMARY KEY (store_id,slot_id,lifecycle_id,format_version,projection_key),
  CONSTRAINT fk_projection_checkpoint FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version)
    REFERENCES dsh_projection_checkpoints(store_id,slot_id,lifecycle_id,format_version),
  CONSTRAINT ck_projection_seq CHECK (last_seq >= -1 AND last_seq <= 9007199254740991)
) ENGINE=InnoDB COMMENT='完整检查点中的各投影单元状态';

CREATE TABLE dsh_search_builds (
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  lifecycle_id BINARY(16) NOT NULL,
  format_version INT UNSIGNED NOT NULL,
  build_id BINARY(16) NOT NULL,
  source_log_revision BIGINT UNSIGNED NOT NULL,
  source_event_count BIGINT UNSIGNED NOT NULL COMMENT '本次只读取 seq 小于此值的前缀',
  extractor_version INT UNSIGNED NOT NULL COMMENT '语义文本与 surface 提取器版本',
  analyzer_version INT UNSIGNED NOT NULL COMMENT '全文分词语义版本',
  build_state VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'staging/published/retired',
  document_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  published_at DATETIME(6) NULL,
  PRIMARY KEY (store_id,slot_id,lifecycle_id,format_version,build_id),
  KEY ix_build_cleanup (store_id,build_state,created_at),
  CONSTRAINT fk_build_log FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version)
    REFERENCES dsh_session_logs(store_id,slot_id,lifecycle_id,format_version),
  CONSTRAINT ck_build_state CHECK (build_state IN ('staging','published','retired')),
  CONSTRAINT ck_build_count CHECK (source_event_count <= 9007199254740991)
) ENGINE=InnoDB COMMENT='固定日志前缀的语义搜索构建批次';

CREATE TABLE dsh_search_state (
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  lifecycle_id BINARY(16) NOT NULL,
  format_version INT UNSIGNED NOT NULL,
  active_build_id BINARY(16) NULL COMMENT '空表示尚未发布搜索文档',
  indexed_log_revision BIGINT UNSIGNED NULL,
  indexed_event_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  state_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '发布 CAS 版本',
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (store_id,slot_id,lifecycle_id,format_version),
  CONSTRAINT fk_search_state_log FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version)
    REFERENCES dsh_session_logs(store_id,slot_id,lifecycle_id,format_version),
  CONSTRAINT fk_search_state_build FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version,active_build_id)
    REFERENCES dsh_search_builds(store_id,slot_id,lifecycle_id,format_version,build_id),
  CONSTRAINT ck_search_state_pointer CHECK (
    (active_build_id IS NULL AND indexed_log_revision IS NULL AND indexed_event_count = 0)
    OR (active_build_id IS NOT NULL AND indexed_log_revision IS NOT NULL)
  ),
  CONSTRAINT ck_search_state_count CHECK (indexed_event_count <= 9007199254740991)
) ENGINE=InnoDB COMMENT='当前可见的搜索构建及索引水位';

CREATE TABLE dsh_search_documents (
  document_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  lifecycle_id BINARY(16) NOT NULL,
  format_version INT UNSIGNED NOT NULL,
  build_id BINARY(16) NOT NULL,
  event_seq BIGINT UNSIGNED NOT NULL,
  surface_class VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'current/shadowed/log-only',
  body LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  codepoint_length BIGINT UNSIGNED NOT NULL COMMENT 'Unicode code point 数量',
  PRIMARY KEY (document_id),
  UNIQUE KEY uq_document_event (store_id,slot_id,lifecycle_id,format_version,build_id,event_seq),
  KEY ix_document_scope (store_id,slot_id,lifecycle_id,format_version,build_id,surface_class,event_seq),
  FULLTEXT KEY ft_document_body (body) WITH PARSER ngram,
  CONSTRAINT fk_document_build FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version,build_id)
    REFERENCES dsh_search_builds(store_id,slot_id,lifecycle_id,format_version,build_id),
  CONSTRAINT fk_document_event FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version,event_seq)
    REFERENCES dsh_session_events(store_id,slot_id,lifecycle_id,format_version,seq),
  CONSTRAINT ck_document_surface CHECK (surface_class IN ('current','shadowed','log-only')),
  CONSTRAINT ck_document_length CHECK (codepoint_length = CHAR_LENGTH(body))
) ENGINE=InnoDB COMMENT='可重建的全文搜索语义文档';

CREATE TABLE dsh_search_jobs (
  store_id BIGINT UNSIGNED NOT NULL,
  slot_id BIGINT UNSIGNED NOT NULL,
  lifecycle_id BINARY(16) NOT NULL,
  format_version INT UNSIGNED NOT NULL,
  target_log_revision BIGINT UNSIGNED NOT NULL,
  target_event_count BIGINT UNSIGNED NOT NULL,
  job_state VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'pending/running/retry/done',
  available_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  claim_token BINARY(16) NULL,
  claim_expires_at DATETIME(6) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_error_json JSON NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (store_id,slot_id,lifecycle_id,format_version),
  KEY ix_job_ready (job_state,available_at,store_id,slot_id),
  KEY ix_job_expired (job_state,claim_expires_at),
  CONSTRAINT fk_search_job_log FOREIGN KEY (store_id,slot_id,lifecycle_id,format_version)
    REFERENCES dsh_session_logs(store_id,slot_id,lifecycle_id,format_version),
  CONSTRAINT ck_job_state CHECK (job_state IN ('pending','running','retry','done')),
  CONSTRAINT ck_job_claim CHECK (
    (job_state = 'running' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (job_state <> 'running' AND claim_token IS NULL AND claim_expires_at IS NULL)
  ),
  CONSTRAINT ck_job_count CHECK (target_event_count <= 9007199254740991)
) ENGINE=InnoDB COMMENT='与事件提交同事务的索引重建任务';

CREATE TABLE dsh_import_runs (
  import_id BINARY(16) NOT NULL,
  store_id BIGINT UNSIGNED NOT NULL,
  source_root LONGTEXT NOT NULL COMMENT '冻结的原 Harness home 或其备份目录',
  manifest_sha256 BINARY(32) NOT NULL,
  source_metadata_json JSON NOT NULL COMMENT '程序版本、来源和一致性检查点',
  run_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json JSON NULL COMMENT '数量、校验汇总与结果',
  started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at DATETIME(6) NULL,
  PRIMARY KEY (import_id),
  UNIQUE KEY uq_import_store (store_id,import_id),
  KEY ix_import_state (store_id,run_state,started_at),
  CONSTRAINT fk_import_store FOREIGN KEY (store_id) REFERENCES dsh_stores(store_id),
  CONSTRAINT ck_import_state CHECK (run_state IN ('planned','running','validating','completed','failed'))
) ENGINE=InnoDB COMMENT='一次可恢复的数据转储';

CREATE TABLE dsh_import_items (
  import_id BINARY(16) NOT NULL,
  item_no BIGINT UNSIGNED NOT NULL,
  store_id BIGINT UNSIGNED NOT NULL,
  item_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_uri LONGTEXT NOT NULL COMMENT '保留的源文件或归档 URI',
  source_uri_hash BINARY(32)
    GENERATED ALWAYS AS (UNHEX(SHA2(source_uri,256))) STORED,
  source_sha256 BINARY(32) NOT NULL COMMENT '源文件原始字节哈希',
  source_size_bytes BIGINT UNSIGNED NOT NULL,
  source_format_version INT UNSIGNED NULL,
  source_session_id LONGTEXT NULL,
  target_slot_id BIGINT UNSIGNED NULL,
  target_lifecycle_id BINARY(16) NULL,
  target_format_version INT UNSIGNED NULL,
  last_imported_seq BIGINT NOT NULL DEFAULT -1,
  item_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  error_json JSON NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (import_id,item_no),
  UNIQUE KEY uq_import_source (import_id,source_uri_hash),
  KEY ix_import_item_state (import_id,item_state,item_no),
  CONSTRAINT fk_import_item_run FOREIGN KEY (store_id,import_id)
    REFERENCES dsh_import_runs(store_id,import_id),
  CONSTRAINT fk_import_item_slot FOREIGN KEY (store_id,target_slot_id)
    REFERENCES dsh_session_slots(store_id,slot_id),
  CONSTRAINT ck_import_item_kind CHECK (item_kind IN ('workspace','workspace_state','session_log','projection_cache')),
  CONSTRAINT ck_import_item_state CHECK (item_state IN ('pending','importing','done','failed','quarantined')),
  CONSTRAINT ck_import_item_seq CHECK (last_imported_seq >= -1 AND last_imported_seq <= 9007199254740991)
) ENGINE=InnoDB COMMENT='按源文件记录转储进度与校验';
