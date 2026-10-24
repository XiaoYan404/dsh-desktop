ALTER TABLE dsh_session_logs
  DROP CHECK ck_log_header,
  ADD CONSTRAINT ck_log_header CHECK (
    JSON_TYPE(header_json) = 'OBJECT'
    AND JSON_CONTAINS_PATH(header_json,'all','$.id','$.version','$.createdAt','$.isSeeded') = 1
    AND JSON_TYPE(JSON_EXTRACT(header_json,'$.id')) = 'STRING'
    AND JSON_TYPE(JSON_EXTRACT(header_json,'$.version')) IN ('INTEGER','UNSIGNED INTEGER')
    AND JSON_TYPE(JSON_EXTRACT(header_json,'$.createdAt')) IN ('INTEGER','UNSIGNED INTEGER')
    AND JSON_TYPE(JSON_EXTRACT(header_json,'$.isSeeded')) = 'BOOLEAN'
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(header_json,'$.version')) AS UNSIGNED) = format_version
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(header_json,'$.createdAt')) AS UNSIGNED) = session_created_at_ms
  );

ALTER TABLE dsh_session_events
  DROP CHECK ck_event_json,
  ADD CONSTRAINT ck_event_json CHECK (
    JSON_VALID(event_json) = 1
    AND JSON_TYPE(event_json) = 'OBJECT'
    AND JSON_CONTAINS_PATH(event_json,'all','$.seq','$.type','$.time','$.data') = 1
    AND JSON_TYPE(JSON_EXTRACT(event_json,'$.seq')) IN ('INTEGER','UNSIGNED INTEGER')
    AND JSON_TYPE(JSON_EXTRACT(event_json,'$.time')) IN ('INTEGER','UNSIGNED INTEGER')
    AND JSON_TYPE(JSON_EXTRACT(event_json,'$.type')) = 'STRING'
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.seq')) AS UNSIGNED) = seq
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.time')) AS UNSIGNED) = event_time_ms
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type')) AS BINARY) = CAST(event_type AS BINARY)
  );
