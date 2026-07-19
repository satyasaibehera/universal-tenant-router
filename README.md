# Universal Tenant Router

An autonomous, decoupled infrastructure-agnostic Control Plane and Identity engine for multi-tenant applications using a Database-per-Customer model on Neon PostgreSQL.

## Core Features
* **Identity Engine**: Native, vendor-free auth layer with custom token signing and Resend OTP delivery.
* **Dynamic Router**: High-performance Express middleware intercepting JWT claims to switch connection pools on the fly.
* **Lifecycle Manager**: Automated database container provisioning via the Neon Management API.
* **Telemetry Engine**: Background cron sampling database health, connection limits, and storage metrics.