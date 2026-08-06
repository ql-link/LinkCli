CREATE TABLE mcp_projects (
  id CHAR(36) NOT NULL COMMENT '项目主键 UUID',
  project_key VARCHAR(48) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT '稳定项目标识及工具名前缀',
  display_name VARCHAR(120) NOT NULL COMMENT '项目展示名称',
  description VARCHAR(1000) NOT NULL COMMENT '项目能力说明',
  owner_id VARCHAR(64) NOT NULL COMMENT '项目负责人平台身份',
  status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/active/disabled/retired',
  trusted_review_bypass_enabled BOOLEAN NOT NULL DEFAULT FALSE COMMENT '可信项目免审开关，默认关闭',
  active_version_id CHAR(36) NULL COMMENT '当前生效服务版本',
  health_status VARCHAR(16) NOT NULL DEFAULT 'unknown' COMMENT 'unknown/healthy/unhealthy',
  last_health_checked_at DATETIME(6) NULL COMMENT 'UTC 最近探活完成时间',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT 'UTC 创建时间',
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT 'UTC 更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_mcp_projects_project_key (project_key),
  KEY idx_mcp_projects_status_health (status, health_status),
  CONSTRAINT ck_mcp_projects_status CHECK (status IN ('pending', 'active', 'disabled', 'retired')),
  CONSTRAINT ck_mcp_projects_health CHECK (health_status IN ('unknown', 'healthy', 'unhealthy'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='MCP 接入项目';

CREATE TABLE mcp_service_versions (
  id CHAR(36) NOT NULL COMMENT '服务版本主键 UUID',
  project_id CHAR(36) NOT NULL COMMENT '所属项目',
  version_no BIGINT UNSIGNED NOT NULL COMMENT '项目内递增版本号',
  endpoint VARCHAR(2048) NOT NULL COMMENT '标准 MCP 服务地址',
  protocol_version VARCHAR(32) NOT NULL COMMENT 'MCP 协议版本',
  credential_ciphertext TEXT NULL COMMENT '项目调用凭据密文',
  credential_key_id VARCHAR(64) NULL COMMENT '加密密钥版本标识',
  review_status VARCHAR(24) NOT NULL DEFAULT 'draft' COMMENT 'draft/pending_review/approved/rejected',
  risk_level VARCHAR(16) NOT NULL DEFAULT 'low' COMMENT 'low/medium/high/incompatible',
  definition_hash BINARY(32) NOT NULL COMMENT '连接与工具定义 SHA-256',
  submitted_by VARCHAR(64) NOT NULL COMMENT '提交者平台身份',
  submitted_at DATETIME(6) NULL COMMENT 'UTC 提交审核或免审批准时间，草稿为空',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT 'UTC 创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_mcp_service_versions_id_project (id, project_id),
  UNIQUE KEY uk_mcp_service_versions_project_version (project_id, version_no),
  KEY idx_mcp_service_versions_project_hash (project_id, definition_hash),
  KEY idx_mcp_service_versions_review_submitted (review_status, submitted_at),
  CONSTRAINT ck_mcp_service_versions_review CHECK (review_status IN ('draft', 'pending_review', 'approved', 'rejected')),
  CONSTRAINT ck_mcp_service_versions_risk CHECK (risk_level IN ('low', 'medium', 'high', 'incompatible')),
  CONSTRAINT fk_mcp_service_versions_project FOREIGN KEY (project_id) REFERENCES mcp_projects (id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='MCP 服务不可变版本';

ALTER TABLE mcp_projects
  ADD CONSTRAINT fk_mcp_projects_active_version FOREIGN KEY (active_version_id, id) REFERENCES mcp_service_versions (id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE TABLE mcp_tool_versions (
  id CHAR(36) NOT NULL COMMENT '工具版本主键 UUID',
  service_version_id CHAR(36) NOT NULL COMMENT '所属服务版本',
  original_name VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT '服务原始工具名',
  description TEXT NOT NULL COMMENT '工具说明',
  input_schema JSON NOT NULL COMMENT '原始输入定义',
  output_schema JSON NULL COMMENT '原始输出定义',
  risk_level VARCHAR(16) NOT NULL DEFAULT 'low' COMMENT 'low/medium/high/incompatible',
  PRIMARY KEY (id),
  UNIQUE KEY uk_mcp_tool_versions_service_name (service_version_id, original_name),
  CONSTRAINT ck_mcp_tool_versions_risk CHECK (risk_level IN ('low', 'medium', 'high', 'incompatible')),
  CONSTRAINT fk_mcp_tool_versions_service FOREIGN KEY (service_version_id) REFERENCES mcp_service_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='每个服务版本的 MCP 工具定义';

CREATE TABLE mcp_tool_runtime (
  project_id CHAR(36) NOT NULL COMMENT '所属项目',
  original_name VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT '项目内稳定工具名称',
  status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active/suspended',
  suspended_reason VARCHAR(1000) NULL COMMENT '暂停原因，正常状态为空',
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT 'UTC 更新时间',
  PRIMARY KEY (project_id, original_name),
  CONSTRAINT ck_mcp_tool_runtime_status CHECK (status IN ('active', 'suspended')),
  CONSTRAINT ck_mcp_tool_runtime_reason CHECK (status <> 'suspended' OR (suspended_reason IS NOT NULL AND CHAR_LENGTH(TRIM(suspended_reason)) > 0)),
  CONSTRAINT fk_mcp_tool_runtime_project FOREIGN KEY (project_id) REFERENCES mcp_projects (id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='MCP 工具当前运行状态';

CREATE TABLE mcp_reviews (
  service_version_id CHAR(36) NOT NULL COMMENT '被审核服务版本',
  decision VARCHAR(16) NOT NULL COMMENT 'approved/rejected/bypassed',
  comment VARCHAR(2000) NULL COMMENT '审核意见，驳回时必填',
  reviewer_id VARCHAR(64) NOT NULL COMMENT '审核人平台身份',
  decided_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT 'UTC 决策时间',
  PRIMARY KEY (service_version_id),
  KEY idx_mcp_reviews_reviewer_time (reviewer_id, decided_at),
  CONSTRAINT ck_mcp_reviews_decision CHECK (decision IN ('approved', 'rejected', 'bypassed')),
  CONSTRAINT ck_mcp_reviews_rejected_comment CHECK (decision <> 'rejected' OR (comment IS NOT NULL AND CHAR_LENGTH(TRIM(comment)) > 0)),
  CONSTRAINT fk_mcp_reviews_service FOREIGN KEY (service_version_id) REFERENCES mcp_service_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='MCP 服务版本审核记录';

CREATE TABLE mcp_call_credentials (
  id CHAR(36) NOT NULL COMMENT '调用凭据主键 UUID',
  owner_id VARCHAR(64) NOT NULL COMMENT '凭据所属平台用户',
  credential_name VARCHAR(120) NOT NULL COMMENT '用户可识别的凭据名称',
  token_prefix VARCHAR(16) NOT NULL COMMENT '令牌展示与定位前缀',
  token_digest BINARY(32) NOT NULL COMMENT '令牌 SHA-256 摘要',
  expires_at DATETIME(6) NULL COMMENT 'UTC 过期时间',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT 'UTC 创建时间',
  revoked_at DATETIME(6) NULL COMMENT 'UTC 吊销时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_mcp_call_credentials_digest (token_digest),
  KEY idx_mcp_call_credentials_owner_created (owner_id, created_at),
  CONSTRAINT ck_mcp_call_credentials_expiry CHECK (expires_at IS NULL OR expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='统一网关调用凭据';
