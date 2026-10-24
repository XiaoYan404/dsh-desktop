---
kind: upgrade-guide
description: "MySQL TLS 使用 IP 地址连接时现在必须显式指定证书身份。"
---

# 使用 IP 连接 MySQL TLS 时声明服务器身份

[English](guide.md) | 中文

## 变更

可选的 `@deepseek-ai/dsh-mysql` 提供方现在拒绝同时配置 `tlsCAFile` 和 IP 形式的 `host` 而未设置 `tlsServerName` 的连接。驱动之前的 IP 路径不能可靠核验证书是否属于配置的目标。拒绝发生在查找凭据和建立连接之前。

`tlsServerName` 指定预期的 DNS 名称或证书 CN，`host` 和 `port` 继续指定实际连接目标。它必须与 `tlsCAFile` 一起使用，而且自身不能是 IP 地址。提供方通过驱动公开的 stream factory 分开连接地址与证书身份；证书链校验、SNI 和主机名校验始终启用。当前不支持直接核验 IP SAN。未设置新字段的 DNS TLS 连接、非 TLS 连接和已保存的 Session 数据沿用原有行为。

## 迁移

1. 找到 `cordis.yml` 或显式 profile 补丁中现有的 MySQL 配置行。与部署管理员核对服务器证书及颁发者。保留已有地址、端口、数据库、凭据引用和 schema 模式。
2. 对使用 TLS 的 IP 目标，添加证书预期的 DNS 身份和可信 CA 路径：

   ```yaml
   host: 10.20.30.40
   tlsCAFile: /etc/company/mysql-ca.pem
   tlsServerName: mysql.internal.example
   ```

3. 启动原有组合，确认提供方进入就绪状态。错误的 CA 或身份必须导致 TLS 握手失败；IP 目标缺少身份时必须在连接前因配置错误而拒绝。不要通过删除 `tlsCAFile` 或关闭校验恢复连接。参见[提供方配置及限制](../../../../packages/storage/mysql/README.zh.md)。
