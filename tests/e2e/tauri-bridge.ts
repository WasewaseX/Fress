// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Browser-side Tauri IPC bridge for E2E tests (Task 1 / Workflow D).
 *
 * Injected by Playwright via `addInitScript` BEFORE any app script runs, so
 * `isTauri()` (presence of `window.__TAURI_INTERNALS__`) is true and the app
 * takes its full in-app path: native downloads, resolver via Rust commands,
 * dialog/opener plugins.
 *
 * The bridge ships as a plain-JS SOURCE STRING (injected with the
 * `{ content }` form of addInitScript). Two reasons:
 *  1. Init-script FUNCTIONS are serialized - they can never close over
 *     module scope, so every option would have to travel through the arg.
 *  2. A TypeScript function body is TRANSPILED before serialization, and
 *     both tsx and esbuild can insert `__name(...)` helper calls that do
 *     not exist in the page. A raw string survives every runner untouched.
 *
 * The mock mirrors the exact contract of @tauri-apps/api 2.x (see
 * node_modules/@tauri-apps/api/{core,event,mocks}.js - modelled on the
 * official `mockIPC` shape):
 *   - `invoke(cmd, args, options)`  -> async result / throw
 *   - `transformCallback(cb, once)` -> numeric id
 *   - `unregisterCallback(id)`      -> removes
 *   - `runCallback(id, data)`       -> delivers an event to a listener
 *   - `plugin:event|listen`         -> returns the handler id (eventId)
 *   - `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId)`
 *
 * The download engine is INTENTIONALLY passive: `start_download` registers
 * the request and returns a sequential id; every progress/completion/
 * failure event is delivered by the test through `window.__fressTest.emit*`
 * (deterministic events beat timers).
 *
 * Control surface (`window.__fressTest`):
 *   calls / downloads / emits        recorded IPC traffic
 *   emitProgress/emitComplete/emitError/emitRetrying
 *   setResolver('ok' | 'rate-limit' | 'empty'); setRelease(repo, releases)
 *   setDialogDir(dir) / setFailDialog(msg)      plugin:dialog|open
 *   setFailStart(msg) / setFailCancel(msg)      engine fault injection
 */

export interface BridgeDownloadRequest {
  id: number;
  url: string;
  filename: string | null;
  directory: string | null;
  expectedSha256: string | null;
  expectedSha512: string | null;
  resume: boolean;
}

export interface BridgeCall {
  cmd: string;
  args: Record<string, unknown> | null;
}

export interface BridgeEmittedEvent {
  event: string;
  payload: Record<string, unknown>;
  at: number;
}

export interface FressTestBridge {
  calls: BridgeCall[];
  downloads: Record<number, BridgeDownloadRequest>;
  emits: BridgeEmittedEvent[];
  /** URLs handed to the opener plugin (Workflow J: the releases page must
   * open instead of a direct download when no usable asset exists). */
  openedUrls: string[];
  nextId: number;
  hostArch: string;
  defaultDir: string;
  dialogDir: string | null;
  setDialogDir(dir: string | null): void;
  failDialog: string | null;
  setFailDialog(msg: string | null): void;
  failStart: string | null;
  setFailStart(msg: string | null): void;
  failCancel: string | null;
  setFailCancel(msg: string | null): void;
  resolverMode: 'ok' | 'rate-limit' | 'empty';
  setResolver(mode: 'ok' | 'rate-limit' | 'empty'): void;
  releases: Record<string, unknown[]>;
  setRelease(repo: string, releases: unknown[]): void;
  emitProgress(id: number, downloaded: number, total: number, speedBps: number, etaSecs: number): void;
  emitComplete(id: number, path: string, bytes: number, sha256: string, verified?: boolean): void;
  emitError(id: number, message: string, kind?: string): void;
  emitRetrying(id: number, attempt: number, message: string): void;
}

export interface BridgeOptions {
  hostArch?: string;
  defaultDir?: string;
  /** Initial release fixtures per repo slug. */
  releases?: Record<string, unknown[]>;
}

declare global {
  interface Window {
    __fressTest?: FressTestBridge;
  }
}

/** The raw page-side script. `__BRIDGE_OPTIONS__` is replaced with the
 * serialized options JSON by bridgeSource() below. */
const BRIDGE_BODY = String.raw`
(function () {
  'use strict';
  var options = __BRIDGE_OPTIONS__;
  var HOST_ARCH = options.hostArch || 'x86_64';
  var DEFAULT_DIR = options.defaultDir || '/home/test/Downloads';
  var INITIAL_RELEASES = options.releases || {};

  var callbacks = {};
  var listeners = {};
  var callbackSeq = 1;

  var bridge = {
    calls: [],
    downloads: {},
    emits: [],
    openedUrls: [],
    nextId: 1001,
    hostArch: HOST_ARCH,
    defaultDir: DEFAULT_DIR,
    dialogDir: null,
    setDialogDir: function (dir) { this.dialogDir = dir; },
    failDialog: null,
    setFailDialog: function (msg) { this.failDialog = msg; },
    failStart: null,
    setFailStart: function (msg) { this.failStart = msg; },
    failCancel: null,
    setFailCancel: function (msg) { this.failCancel = msg; },
    resolverMode: 'ok',
    setResolver: function (mode) { this.resolverMode = mode; },
    releases: INITIAL_RELEASES,
    setRelease: function (repo, releases) { this.releases[repo] = releases; },
    emitProgress: function (id, downloaded, total, speedBps, etaSecs) {
      emit('download-progress', { id: id, downloaded: downloaded, total: total, speed_bps: speedBps, eta_secs: etaSecs });
    },
    emitComplete: function (id, path, bytes, sha256, verified) {
      emit('download-complete', { id: id, path: path, bytes: bytes, sha256: sha256, verified: verified });
    },
    emitError: function (id, message, kind) {
      emit('download-error', { id: id, message: message, kind: kind });
    },
    emitRetrying: function (id, attempt, message) {
      emit('download-retrying', { id: id, attempt: attempt, message: message });
    },
  };

  function emit(event, payload) {
    bridge.emits.push({ event: event, payload: payload, at: Date.now() });
    var ids = listeners[event] || [];
    for (var i = 0; i < ids.length; i++) {
      runCallback(ids[i], { event: event, id: payload.id !== undefined ? payload.id : 0, payload: payload });
    }
  }

  function runCallback(id, data) {
    var cb = callbacks[id];
    if (cb) cb(data);
  }

  function transformCallback(callback, once) {
    var identifier = callbackSeq++;
    callbacks[identifier] = function (data) {
      if (once) delete callbacks[identifier];
      if (callback) callback(data);
    };
    return identifier;
  }

  function handleEventPlugin(cmd, args) {
    if (cmd === 'plugin:event|listen') {
      var event = args.event;
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(args.handler);
      return args.handler;
    }
    if (cmd === 'plugin:event|unlisten') {
      var list = listeners[args.event];
      if (list) {
        var i = list.indexOf(args.eventId);
        if (i !== -1) list.splice(i, 1);
      }
      return null;
    }
    if (cmd === 'plugin:event|emit') {
      emit(args.event, args.payload || {});
      return null;
    }
    return null;
  }

  function lookupReleases(repo) {
    if (bridge.releases[repo]) return bridge.releases[repo];
    var keys = Object.keys(bridge.releases);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === repo.toLowerCase()) return bridge.releases[keys[i]];
    }
    return [];
  }

  function releasePayload(r) {
    return {
      tag: r.tag,
      name: r.name,
      published_at: r.published_at !== undefined ? r.published_at : (r.publishedAt || ''),
      html_url: r.html_url !== undefined ? r.html_url : (r.htmlUrl || ''),
      assets: (r.assets || []).map(function (a) {
        return {
          name: a.name,
          size: a.size,
          download_url: a.download_url !== undefined ? a.download_url : (a.downloadUrl || ''),
        };
      }),
    };
  }

  async function invoke(cmd, args) {
    bridge.calls.push({ cmd: cmd, args: args });
    if (cmd.indexOf('plugin:event|') === 0) return handleEventPlugin(cmd, args || {});

    switch (cmd) {
      case 'host_arch':
        return HOST_ARCH;
      case 'default_download_dir':
        return DEFAULT_DIR;
      case 'fetch_latest_release': {
        var repo1 = String((args && args.repo) || '');
        if (bridge.resolverMode === 'rate-limit') throw 'GitHub rate limit reached';
        var list1 = lookupReleases(repo1);
        if (bridge.resolverMode === 'empty' || list1.length === 0) throw 'No stable release found';
        return releasePayload(list1[0]);
      }
      case 'fetch_recent_releases': {
        var repo2 = String((args && args.repo) || '');
        if (bridge.resolverMode === 'rate-limit') throw 'GitHub rate limit reached';
        var list2 = lookupReleases(repo2);
        if (bridge.resolverMode === 'empty') return [];
        return list2.map(releasePayload);
      }
      case 'fetch_fdroid_package': {
        if (bridge.resolverMode === 'rate-limit') throw 'F-Droid rate limit reached';
        var pkg = String((args && args.pkg) || '');
        return {
          apk_url: 'https://f-droid.org/repo/' + pkg + '_101000.apk',
          page_url: 'https://f-droid.org/packages/' + pkg + '/',
          version: '1.1.0',
          version_code: 101000,
        };
      }
      case 'fetch_text': {
        // Real Rust proxies the HTTP GET through the network policy; here the
        // page's own fetch does it - Playwright's route layer answers it from
        // fixtures, so official-resolver manifests stay deterministic.
        var url = String((args && args.url) || '');
        var resp = await fetch(url);
        var body = await resp.text();
        return {
          status: resp.status,
          final_url: url,
          content_length: body.length,
          body: body,
          truncated: false,
        };
      }
      case 'fetch_self_update_text': {
        // The native self-update text reader (SHA256SUMS.txt, releases.atom):
        // same rails as fetch_text, but the shape the updater expects -
        // { status, body, truncated }. The route layer serves the checksum
        // document, so the fail-closed checksum contract is testable.
        var su = String((args && args.url) || '');
        var suResp = await fetch(su);
        var suBody = await suResp.text();
        return {
          status: suResp.status,
          body: suBody,
          truncated: false,
        };
      }
      case 'start_download': {
        if (bridge.failStart) throw bridge.failStart;
        var a = args || {};
        var id = bridge.nextId++;
        bridge.downloads[id] = {
          id: id,
          url: a.url || '',
          filename: a.filename !== undefined ? a.filename : null,
          directory: a.directory !== undefined ? a.directory : null,
          expectedSha256: a.expectedSha256 !== undefined ? a.expectedSha256 : null,
          expectedSha512: a.expectedSha512 !== undefined ? a.expectedSha512 : null,
          resume: a.resume || false,
        };
        return id;
      }
      case 'cancel_download': {
        if (bridge.failCancel) throw bridge.failCancel;
        var cid = Number(args && args.id);
        // Contract (docs/download-lifecycle.md): cancel emits a terminal
        // download-error whose message is exactly "Cancelled".
        emit('download-error', { id: cid, message: 'Cancelled' });
        return null;
      }
      case 'plugin:dialog|open': {
        if (bridge.failDialog) throw bridge.failDialog;
        return bridge.dialogDir;
      }
      case 'plugin:opener|open_url':
        if (args && typeof args.url === 'string') bridge.openedUrls.push(args.url);
        return null;
      case 'plugin:opener|open_path':
      case 'plugin:opener|reveal_item_in_dir':
        return null;
      default:
        // Unknown command: resolve null (plugins in this app tolerate it).
        return null;
    }
  }

  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {
      invoke: invoke,
      transformCallback: transformCallback,
      unregisterCallback: function (id) { delete callbacks[id]; },
      runCallback: runCallback,
      callbacks: callbacks,
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main', windowLabel: 'main' },
      },
    },
  });
  Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
    value: {
      unregisterListener: function (event, eventId) {
        var list = listeners[event];
        if (list) {
          var i = list.indexOf(eventId);
          if (i !== -1) list.splice(i, 1);
        }
      },
    },
  });

  Object.defineProperty(window, '__fressTest', {
    value: bridge,
  });
})();
`;

/** Returns the final init-script content with the options baked in. */
export function bridgeSource(options: BridgeOptions = {}): string {
  return BRIDGE_BODY.replace(
    '__BRIDGE_OPTIONS__',
    JSON.stringify({
      hostArch: options.hostArch ?? 'x86_64',
      defaultDir: options.defaultDir ?? '/home/test/Downloads',
      releases: options.releases ?? {},
    }).replace(/</g, '\\u003c')
  );
}
