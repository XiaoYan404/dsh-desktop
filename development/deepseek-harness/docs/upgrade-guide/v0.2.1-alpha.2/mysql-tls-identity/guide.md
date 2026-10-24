---
kind: upgrade-guide
description: "MySQL TLS connections to an IP address now require an explicit certificate identity."
---

# Declare the MySQL TLS server identity when dialing an IP

English | [中文](guide.zh.md)

## Change

The optional `@deepseek-ai/dsh-mysql` provider now refuses `tlsCAFile` together with an IP-valued `host` unless `tlsServerName` is set. The driver's previous IP path did not reliably verify that the certificate belonged to the configured endpoint. Refusal happens before credential lookup or connection creation.

`tlsServerName` specifies the expected DNS name or certificate CN, while `host` and `port` retain the physical destination. It requires `tlsCAFile` and cannot itself be an IP address. The provider uses the driver's public stream factory; chain verification, SNI and hostname verification stay enabled. Direct verification against an IP SAN is currently unsupported. DNS TLS connections without the new field, non-TLS connections and stored Session data retain their existing behavior.

## Migration

1. Find the existing MySQL row in your `cordis.yml` or explicit profile patch. Review the server certificate and its issuer with your deployment administrator. Keep the existing endpoint, port, database, credential reference and schema mode.
2. For an IP endpoint with TLS, add the certificate's expected DNS identity and trusted CA path:

   ```yaml
   host: 10.20.30.40
   tlsCAFile: /etc/company/mysql-ca.pem
   tlsServerName: mysql.internal.example
   ```

3. Start that same composition and confirm the provider becomes ready. A wrong CA or identity must fail the TLS handshake. A missing identity with an IP endpoint must fail configuration before connecting. Do not remove `tlsCAFile` or disable verification to restore connectivity. See the [provider configuration and limits](../../../../packages/storage/mysql/README.md).
