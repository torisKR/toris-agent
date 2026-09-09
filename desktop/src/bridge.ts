// Bridge abstraction between the webview and the toris engine.
//
// In the packaged/desktop app the Rust backend spawns the Node NDJSON sidecar
// (src/desktop/bridge.js); here we talk to it through Tauri: `bridge_write`
// sends a command, and the `bridge-event` Tauri event delivers each NDJSON line
// the sidecar prints. When the frontend runs in a plain browser (e.g. `vite`
// without Tauri, for quick UI work) we fall back to an in-browser MockBridge
// that mimics Demo mode so the UI is still fully explorable.

import { FALLBACK_PRESETS } from './presets-ui';

export type BridgeEvent = Record<string, any> & { type: string };
export type Command = Record<string, any> & { type: string };
type Listener = (evt: BridgeEvent) => void;

export interface Bridge {
  readonly isReal: boolean;
  onEvent(listener: Listener): void;
  send(command: Command): void;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

class TauriBridge implements Bridge {
  readonly isReal = true;
  private listeners: Listener[] = [];

  constructor() {
    void this.init();
  }

  private async init() {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<BridgeEvent>('bridge-event', (e) => {
      for (const l of this.listeners) l(e.payload);
    });
    await listen<string>('bridge-log', (e) => {
      // Surface sidecar diagnostics in the devtools console.
      // eslint-disable-next-line no-console
      console.debug('[bridge]', e.payload);
    });
  }

  onEvent(listener: Listener) {
    this.listeners.push(listener);
  }

  async send(command: Command) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      await invoke('bridge_write', { payload: command });
    } catch (err) {
      for (const l of this.listeners) {
        l({ type: 'error', message: String(err), code: 'E_INVOKE' });
      }
    }
  }
}

// --- Browser fallback -------------------------------------------------------

const AUTO_APPROVE = new Set(['L3', 'L4', 'L5']);

class MockBridge implements Bridge {
  readonly isReal = false;
  private listeners: Listener[] = [];
  private aborted = new Set<string>();
  private pending = new Map<string, (allow: boolean) => void>();
  private overrideKeys: Record<string, boolean> = {
    anthropic: false,
    openai: false,
    grok: false,
  };
  private extraProfiles: any[] = [];

  constructor() {
    setTimeout(() => this.emit(this.readyEvent()), 30);
  }

  private readyEvent(): BridgeEvent {
    return {
      type: 'ready',
      presets: FALLBACK_PRESETS,
      profiles: this.profiles(),
      keys: { api: { ...this.overrideKeys }, cli: { 'claude-cli': false, 'codex-cli': false } },
      defaultAutonomy: 'L3',
      demoProfileId: 'demo',
      mock: true,
    };
  }

  private profiles() {
    return [
      { id: 'demo', provider: 'demo', model: 'demo', usable: true, demo: true },
      ...this.extraProfiles,
    ];
  }

  onEvent(listener: Listener) {
    this.listeners.push(listener);
  }

  private emit(evt: BridgeEvent) {
    for (const l of this.listeners) l(evt);
  }

  send(command: Command) {
    switch (command.type) {
      case 'send':
        void this.runTurn(command);
        break;
      case 'abort':
        this.aborted.add(command.conversationId);
        break;
      case 'approval': {
        const r = this.pending.get(command.callId);
        if (r) {
          this.pending.delete(command.callId);
          r(Boolean(command.allow));
        }
        break;
      }
      case 'set-key':
        this.overrideKeys[command.provider] = Boolean(command.key);
        this.emit({ ...this.readyEvent(), type: 'providers' });
        break;
      case 'add-profile':
        this.extraProfiles = this.extraProfiles.filter((p) => p.id !== command.id);
        this.extraProfiles.push({
          id: command.id,
          provider: command.provider,
          model: command.model || 'auto',
          usable: this.overrideKeys[command.provider] === true,
          demo: false,
        });
        this.emit({ ...this.readyEvent(), type: 'providers' });
        break;
      default:
        break;
    }
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async stream(convId: string, msgId: string, text: string) {
    for (const tok of text.match(/\s+|\S+/g) ?? [text]) {
      if (this.aborted.has(convId)) return false;
      this.emit({ type: 'text', conversationId: convId, messageId: msgId, delta: tok });
      await this.sleep(14);
    }
    return true;
  }

  private async runTurn(cmd: Command) {
    const convId = cmd.conversationId;
    const msgId = cmd.messageId;
    this.aborted.delete(convId);
    const autonomy = cmd.autonomy ?? 'L3';
    const text: string = cmd.text ?? '';
    this.emit({ type: 'session', conversationId: convId, profileId: cmd.profileId, presetId: cmd.presetId, autonomy, provider: 'demo', model: 'demo', demo: true });
    this.emit({ type: 'turn-start', conversationId: convId, messageId: msgId, provider: 'demo', model: 'demo', demo: true });

    const wantsList = /\b(list|files?|directory|folder|project|repo|structure)\b/i.test(text);
    const wantsCmd = /\b(run|command|execute|approve|approval|test|build)\b/i.test(text);
    const withTools = cmd.presetId === 'code' || cmd.presetId === 'general' || cmd.presetId === 'summarize';

    if (withTools && wantsList) {
      await this.stream(convId, msgId, 'Let me take a look using the list_files tool.\n');
      this.emit({ type: 'tool-start', conversationId: convId, messageId: msgId, name: 'list_files', input: { path: '.' } });
      await this.sleep(500);
      this.emit({ type: 'tool-end', conversationId: convId, messageId: msgId, name: 'list_files' });
      const listing = 'README.md\nbin/\ncrates/\ndesktop/\ndocs/\npackage.json\nsrc/\nsrc-tauri/\ntest/';
      await this.stream(
        convId,
        msgId,
        `Here is what I found by running the **list_files** tool:\n\n\`\`\`\n${listing}\n\`\`\`\n\nThat is the real toris tool loop — in Demo mode (browser preview) the listing is illustrative; the packaged app reads your actual directory.`,
      );
      this.finish(convId, msgId);
      return;
    }

    if (withTools && wantsCmd) {
      await this.stream(convId, msgId, 'Sure — let me run a quick command to show the tool loop.\n');
      let allow = true;
      if (!AUTO_APPROVE.has(autonomy)) {
        const callId = `mock_${Date.now()}`;
        this.emit({ type: 'tool-approval-request', conversationId: convId, messageId: msgId, callId, name: 'run_command', input: { command: 'echo "toris demo tool ran ✔"' } });
        allow = await new Promise<boolean>((resolve) => this.pending.set(callId, resolve));
      }
      if (!allow) {
        this.emit({ type: 'tool-denied', conversationId: convId, messageId: msgId, name: 'run_command' });
        await this.stream(convId, msgId, "\nNo problem — I won't run that. Tell me how you'd like to proceed instead.");
        this.finish(convId, msgId);
        return;
      }
      this.emit({ type: 'tool-start', conversationId: convId, messageId: msgId, name: 'run_command', input: { command: 'echo "toris demo tool ran ✔"' } });
      await this.sleep(450);
      this.emit({ type: 'tool-end', conversationId: convId, messageId: msgId, name: 'run_command' });
      await this.stream(convId, msgId, '\nDone — the command returned:\n\n```\ntoris demo tool ran ✔\n```\n\nThat exercised the approval-gated tool path end to end.');
      this.finish(convId, msgId);
      return;
    }

    const short = text.length > 120 ? text.slice(0, 117) + '…' : text || 'your request';
    await this.stream(
      convId,
      msgId,
      `You said: "${short}"\n\nThis is **toris Demo mode** (browser preview). It streams token by token, keeps conversations in the sidebar, and — in the packaged desktop app — drives the real toris agent engine and tools. Open **Settings** to connect a real provider.`,
    );
    this.finish(convId, msgId);
  }

  private finish(convId: string, msgId: string) {
    if (this.aborted.has(convId)) {
      this.emit({ type: 'aborted', conversationId: convId, messageId: msgId, message: 'interrupted' });
      return;
    }
    this.emit({ type: 'turn-end', conversationId: convId, messageId: msgId, usage: { inputTokens: 0, outputTokens: 0, turns: 1 }, provider: 'demo', model: 'demo', demo: true });
  }
}

let singleton: Bridge | null = null;

export function getBridge(): Bridge {
  if (!singleton) singleton = inTauri() ? new TauriBridge() : new MockBridge();
  return singleton;
}
