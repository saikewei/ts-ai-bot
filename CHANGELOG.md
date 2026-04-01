# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [3.3.0] — 2026-04-02

### Added
- `docs: rewrite README` — Complete rewrite of README.md in English
  - Replaced Azure TTS with **Doubao TTS** (ByteDance, WebSocket streaming)
  - Updated LLM to **streaming output** mode
  - Added architecture diagram and component descriptions
  - Updated config example and recent commit history
- `59e08de` — Add Apache License 2.0 to the project
- `3626b23` — Add README and config example
- `788f47b` — Initial commit

### Changed
- `e584d9d` — Refactor main program into a class
- `838cdb6` — Update config example
- `8d16588` — Switch from Azure TTS to **Doubao TTS** (ByteDance, WebSocket streaming); remove Azure dependency
- `f22c402` — LLM output changed to **streaming mode**
- `docs: rewrite README` — README rewritten entirely in English

### Fixed
- `3a8c207` — Fix TTS producing no audio
- `f935fda` — Fix logic for waiting after wake before starting recording

### Removed
- `b00c97e` — Remove Docker and bare-metal deployment instructions

### Performance
- `8552ea4` — Add caching to improve response speed
