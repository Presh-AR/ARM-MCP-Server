# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-08-10

### Added

- Seven dedicated nCino CI Jobs tools, two guided nCino prompts, and an nCino API resource.
- Six deployment reporting tools and deployment workflow guidance.
- Structured tool results, complete MCP tool annotations, and output schemas.
- Contract tests for public MCP discovery and HTTP behavior.
- Public package metadata, contribution guidance, support policy, and private security reporting.

### Changed

- Deployment tools use the published `/api/deployments/v1` request paths.
- Read-only requests retry rate limits and transient gateway failures; mutations do not retry automatically.
- Audit ZIP downloads are size-bounded, written with owner-only permissions, and returned as local MCP resource links.
- Remote ARM base URLs require HTTPS unless explicitly allowed for controlled development.
- Node.js 22 is the minimum supported runtime; CI and containers use Node.js 24.

### Security

- The generic API tool is disabled by default and restricted to same-origin `/api/` paths.
- Custom headers cannot override authentication, host, or content-length headers.
