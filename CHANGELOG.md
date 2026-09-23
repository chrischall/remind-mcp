# Changelog

## [1.1.3](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v1.1.2...remind-mcp-v1.1.3) (2026-09-23)


### Bug Fixes

* harden remind_graphql read-only guard, surface refused sends, keep sessions on field-level Unauthorized ([#65](https://github.com/chrischall/remind-mcp/issues/65)) ([61393ef](https://github.com/chrischall/remind-mcp/commit/61393ef6d8f325632b669cc256b27b717afe8d89))

## [1.1.2](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v1.1.1...remind-mcp-v1.1.2) (2026-09-23)


### Bug Fixes

* **deps:** require zod ^4.6.5 to match @chrischall/mcp-utils 2.4.0 ([#64](https://github.com/chrischall/remind-mcp/issues/64)) ([c456321](https://github.com/chrischall/remind-mcp/commit/c456321d39ad5bfeeafb4fc7408e2170e016186a))
* **deps:** upgrade @chrischall/mcp-utils to 2.4.0 and @fetchproxy/* to 3.2.0 ([#62](https://github.com/chrischall/remind-mcp/issues/62)) ([c69dbae](https://github.com/chrischall/remind-mcp/commit/c69dbae552305cc22def7e700dfb894e95e119d5))

## [1.1.1](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v1.1.0...remind-mcp-v1.1.1) (2026-09-21)


### Bug Fixes

* **tools:** say which writes are destructive ([#60](https://github.com/chrischall/remind-mcp/issues/60)) ([aa761b8](https://github.com/chrischall/remind-mcp/commit/aa761b80774764317b0dfbb82459b2acc7ff7b11))

## [1.1.0](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v1.0.0...remind-mcp-v1.1.0) (2026-09-19)


### Features

* **deps:** take mcp-utils 1.0.0 for the serveStdio boot ([#58](https://github.com/chrischall/remind-mcp/issues/58)) ([5e7a34c](https://github.com/chrischall/remind-mcp/commit/5e7a34c8562d524fd3a7dc00e415f87593eb4cc5))

## [1.0.0](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v0.4.5...remind-mcp-v1.0.0) (2026-09-19)


### ⚠ BREAKING CHANGES

* **mcp:** migrate server to SDK v2 ([#53](https://github.com/chrischall/remind-mcp/issues/53))

### Features

* **mcp:** migrate server to SDK v2 ([#53](https://github.com/chrischall/remind-mcp/issues/53)) ([b049c6c](https://github.com/chrischall/remind-mcp/commit/b049c6cf5bbcfa3fd7463e07320ea15f30a28ca4))

## [0.4.5](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v0.4.4...remind-mcp-v0.4.5) (2026-09-15)


### Bug Fixes

* **deps:** @fetchproxy/server 3.0.1 — capped peer frames, logged load drops, atomic identity writes ([#47](https://github.com/chrischall/remind-mcp/issues/47)) ([9cfa831](https://github.com/chrischall/remind-mcp/commit/9cfa831d96c8f4cc51ecbb70b2fb053e02734b9a))

## [0.4.4](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v0.4.3...remind-mcp-v0.4.4) (2026-09-14)


### Bug Fixes

* **deps:** @fetchproxy/server 2.11.3, so the hosted extension pin persists ([#44](https://github.com/chrischall/remind-mcp/issues/44)) ([0cbaa9c](https://github.com/chrischall/remind-mcp/commit/0cbaa9c96ed09dd063ebf7cce50a67ee7a94d5d1))
* **deps:** @fetchproxy/server 3.0.0 — protocol v4 (forward secrecy, AAD over the frame) ([#46](https://github.com/chrischall/remind-mcp/issues/46)) ([d59c38d](https://github.com/chrischall/remind-mcp/commit/d59c38d8b2eac643d2a32a47ff7c217ad9dad017))

## [0.4.3](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v0.4.2...remind-mcp-v0.4.3) (2026-09-10)


### Bug Fixes

* declare the capture window so the useful error is the one that arrives ([#41](https://github.com/chrischall/remind-mcp/issues/41)) ([4575ed2](https://github.com/chrischall/remind-mcp/commit/4575ed2075b8501a91adb8a71c30533c24e6e4c1))

## [0.4.2](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v0.4.1...remind-mcp-v0.4.2) (2026-09-10)


### Bug Fixes

* **deps:** @fetchproxy/server 2.10.0 and @chrischall/mcp-utils 0.26.1 ([#39](https://github.com/chrischall/remind-mcp/issues/39)) ([61c7233](https://github.com/chrischall/remind-mcp/commit/61c72333951fb2c69b06ccc924de9e4a906e2259))
* **deps:** declare the peer floors mcp-utils 0.26.1 requires ([#40](https://github.com/chrischall/remind-mcp/issues/40)) ([1a66ef7](https://github.com/chrischall/remind-mcp/commit/1a66ef72f1bec45c6013e32fe2eb605da3b5933c))
* **deps:** take @fetchproxy/server 2.9.1 so a pairing prompt survives ([#37](https://github.com/chrischall/remind-mcp/issues/37)) ([ca5db78](https://github.com/chrischall/remind-mcp/commit/ca5db78ae59952917ee316d8da6a442b9285b6d8))

## [0.4.1](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v0.4.0...remind-mcp-v0.4.1) (2026-09-09)


### Bug Fixes

* **deps:** require @fetchproxy/server ^2.7.0, the first that reads FETCHPROXY_IDENTITY_DIR ([#35](https://github.com/chrischall/remind-mcp/issues/35)) ([daa71b2](https://github.com/chrischall/remind-mcp/commit/daa71b2e095139c539b9df4a44589bf9d6407239))

## [0.4.0](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v0.3.0...remind-mcp-v0.4.0) (2026-09-04)


### Features

* **tools:** minify every response ([#28](https://github.com/chrischall/remind-mcp/issues/28)) ([9487a47](https://github.com/chrischall/remind-mcp/commit/9487a47ba4981e2300ad12dd56182431b54717f9))

## [0.3.0](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v0.2.1...remind-mcp-v0.3.0) (2026-08-29)


### Features

* **deps:** take @fetchproxy/server 2.2.0 so the concentrator can bind its sandbox address ([#15](https://github.com/chrischall/remind-mcp/issues/15)) ([2cd3de4](https://github.com/chrischall/remind-mcp/commit/2cd3de46e0fdccb1475a46c3cc8c388a7c0e186d))

## [0.2.1](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v0.2.0...remind-mcp-v0.2.1) (2026-08-28)


### Bug Fixes

* move the node floor under compatibility so mcpb can pack the bundle ([#13](https://github.com/chrischall/remind-mcp/issues/13)) ([2be16cc](https://github.com/chrischall/remind-mcp/commit/2be16cc7ae263a85a28bd440a3498850dca2c5bf))

## [0.2.0](https://github.com/chrischall/remind-mcp/compare/remind-mcp-v0.1.0...remind-mcp-v0.2.0) (2026-08-28)


### Features

* cache the captured session so the browser is needed only once ([#11](https://github.com/chrischall/remind-mcp/issues/11)) ([70815a0](https://github.com/chrischall/remind-mcp/commit/70815a05a7815414b00ed0951df230d69581eb39))

## 0.1.0 (2026-08-28)


### Features

* Remind (remind.com) MCP server and fpx access skill ([0da86db](https://github.com/chrischall/remind-mcp/commit/0da86dbbf22c6a8712f325e10dd4068b7f90b9e1))


### Documentation

* document precedence between the two client injection seams ([#9](https://github.com/chrischall/remind-mcp/issues/9)) ([c677949](https://github.com/chrischall/remind-mcp/commit/c67794947bbd15cf25063a28d6d9d03fa0f75b3c))
