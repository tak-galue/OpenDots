import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}
export class CodexClient {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private directory: string;
  private closed = false;
  readonly cwd: string;
  onMessage?: (message: RpcMessage) => void;
  onFailure?: (error: Error) => void;
  constructor(
    binary = 'codex',
    authHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  ) {
    this.directory = mkdtempSync(join(tmpdir(), 'opendots-codex-'));
    const home = join(this.directory, 'home');
    this.cwd = join(this.directory, 'workspace');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(this.cwd, { mode: 0o700 });
    // Codex reads and refreshes its own login. No token is parsed or exposed by OpenDots.
    // A private home avoids importing host MCP servers, plugins and project settings.
    for (const file of ['auth.json', 'models_cache.json']) {
      const source = join(authHome, file);
      if (existsSync(source)) symlinkSync(source, join(home, file));
    }
    const environment = Object.fromEntries(
      [
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'TMPDIR',
        'TEMP',
        'TMP',
        'LANG',
        'LC_ALL',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'CODEX_CA_CERTIFICATE',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
      ].flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]!]],
      ),
    );
    this.child = spawn(
      binary,
      [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'features.shell_tool=false',
        '-c',
        'features.unified_exec=false',
        '-c',
        'features.apps=false',
        '-c',
        'features.browser_use=false',
        '-c',
        'features.computer_use=false',
        '-c',
        'features.view_image=false',
        '-c',
        'features.image_generation=false',
        '-c',
        'features.multi_agent=false',
        '-c',
        'features.skip_host_skill_discovery=true',
        '-c',
        'web_search="disabled"',
      ],
      {
        cwd: this.cwd,
        env: { ...environment, CODEX_HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        const message: RpcMessage = JSON.parse(line);
        if (typeof message.id === 'number' && !message.method) {
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
          }
        } else this.onMessage?.(message);
      } catch {
        this.fail(new Error('Codex returned an invalid protocol message.'));
      }
    });
    // Drain stderr, but never forward credentials, private model inputs, or host paths.
    this.child.stderr.resume();
    this.child.stdin.on('error', () =>
      this.fail(new Error('Codex connection was interrupted.')),
    );
    this.child.on('error', () =>
      this.fail(
        new Error(
          'Codex could not start. Check CODEX_BIN and run codex login.',
        ),
      ),
    );
    this.child.on('exit', () => {
      if (!this.closed)
        this.fail(new Error('Codex disconnected before completing the turn.'));
    });
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onFailure?.(error);
  }
  private write(message: object) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error('Codex connection is closed.'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ id, method, params });
    });
  }
  respond(id: number | string, result: unknown) {
    this.write({ id, result });
  }
  deny(id: number | string) {
    this.write({
      id,
      error: {
        code: -32601,
        message: 'This capability is not enabled in OpenDots.',
      },
    });
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'opendots', title: 'OpenDots', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized' });
    const result = await this.request<{ account: { type: string } | null }>(
      'account/read',
      { refreshToken: false },
    );
    if (!result.account || result.account.type !== 'chatgpt')
      throw new Error('Codex requires a ChatGPT login. Run codex login first.');
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.child.kill('SIGTERM');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex connection closed.'));
    }
    this.pending.clear();
    // Wait for the child to finish using its private home before removing it.
    if (this.child.exitCode !== null)
      rmSync(this.directory, { recursive: true, force: true });
    else
      this.child.once('close', () =>
        rmSync(this.directory, { recursive: true, force: true }),
      );
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    kill.unref();
  }
}
