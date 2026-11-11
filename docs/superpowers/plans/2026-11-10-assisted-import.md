# Assisted Import Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect several owners with an explicit assisted token import flow, without a GitHub App.
**Architecture:** Owner credentials remain in trusted local settings; a routing API client isolates owner caches/retries. Worker-managed session grants authorize a narrowly scoped settings-page content script. Verification precedes every credential write.
**Tech Stack:** Existing TypeScript, Chrome MV3, esbuild, Vitest, Playwright.
**Spec:** ../specs/2026-11-10-assisted-import-design.md

## Constraints and review focus

Preserve Chrome 120+, read-only GitHub API use, local credentials, existing grouping/closure rules, and Material styling. Cover stale drafts overwriting credentials, missing owners, rate limits isolated by connection, imported-token replay, unrelated settings tabs, iframe messages, setup cancellation, and malformed/ambiguous token controls.

## Tasks

- [x] Add regression tests for owner credential actions, legacy settings, API routing/cache/backoff isolation, and import session/token selection.
- [x] Implement settings owner connections and API router; update worker and public state without exposing tokens.
- [x] Implement explicit worker-created setup sessions and restricted import messages; consume sessions only after successful verification.
- [x] Implement isolated import panel, narrowly scoped manifest registration/build output, and settings owner list/connect/check/remove controls.
- [x] Extend native Chromium smoke coverage for actual content scripts, import success/failure/replay/isolation, two owners and existing grouping regressions.
- [x] Run tests, typecheck, build and browser integration; request independent review, resolve findings, update documentation and package release.
