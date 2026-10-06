/** Translate OpenCode 2's API into the small interface used by OpenCodeProvider. */
import type { OpenCodeClient as V2Client, SessionMessageAssistant, TokenUsageInfo } from '@opencode-ai/client';
import { setTimeout as delay } from 'node:timers/promises';

type Permission = { permission: string; pattern: string; action: 'deny' };
type MessageError = { name: string; data?: { message: string } };
type PromptResult = {
  info?: { error?: MessageError; tokens?: TokenUsageInfo; cost?: number; structured?: unknown };
  parts?: Array<{ type: string; text?: string }>;
};
type Event = { type: string; properties: Record<string, unknown> };
type Options = { signal?: AbortSignal };

/** Internal contract also used by existing provider test doubles. */
export interface OpenCodeClient {
  config: { providers(): Promise<{ data?: { providers?: Array<{ id: string; name: string; models?: Record<string, { name?: string }> }> } }> };
  tool: { ids(input: { directory: string }): Promise<{ data?: string[] }> };
  session: {
    create(input: { title: string; directory: string; permission?: Permission[] }): Promise<{ data?: { id: string } }>;
    prompt(input: { sessionID: string; model: { providerID: string; modelID: string }; parts: Array<{ type: 'text'; text: string }>; format?: { type: 'json_schema'; schema: unknown }; directory: string }, options?: Options): Promise<{ data?: PromptResult }>;
  };
  event: { subscribe(input: { directory: string }, options?: Options): Promise<{ stream: AsyncIterable<Event> }> };
}

const READ_TOOLS = ['read', 'glob', 'grep', 'list'];

function matchesShell(action: string): boolean {
  const pattern = action.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`, process.platform === 'win32' ? 'si' : 's').test('shell');
}

export function adaptOpenCodeClient(client: V2Client): OpenCodeClient {
  const restrictedSessions = new Map<string, string>(); // session ID -> project ID
  return {
    config: {
      providers: async () => {
        // HTTP readiness precedes location plugin activation in OpenCode 2.
        // The guarded policy plugin is last in the built-in activation order;
        // wait for its inventory entry before reading either catalog. An empty
        // catalog after activation still means genuinely unconfigured providers.
        const signal = AbortSignal.timeout(30_000);
        while (true) {
          const plugins = await client.plugin.list({}, { signal });
          if (plugins.data.some(plugin => plugin.id === 'opencode.config.policy')) break;
          await delay(250, undefined, { signal });
        }
        const [providers, models] = await Promise.all([client.provider.list(), client.model.list()]);
        return { data: { providers: providers.data.filter(provider => provider.activation !== 'disabled').map(provider => ({
          id: provider.id,
          name: provider.name,
          models: Object.fromEntries(models.data.filter(model => model.providerID === provider.id && model.enabled)
            .map(model => [model.id, { name: model.name }])),
        })) } };
      },
    },
    // v2 has no tool.ids endpoint. A wildcard deny followed by read-only allows
    // also covers tools added by plugins/MCP without enumerating them.
    tool: { ids: async () => ({ data: ['*', ...READ_TOOLS] }) },
    session: {
      create: async input => {
        const session = await client.session.create({
          title: input.title,
          location: { directory: input.directory },
          ...(input.permission?.length ? { permissions: [
            ...input.permission.map(rule => ({ action: rule.permission, resource: rule.pattern, effect: rule.action })),
            ...READ_TOOLS.map(action => ({ action, resource: '*', effect: 'allow' as const })),
            // Zen rejects pre-denied shell tools. Keep it approval-gated, never
            // allowed: the prompt guard below rejects every shell request.
            { action: 'shell', resource: '*', effect: 'ask' as const },
          ] } : {}),
        });
        if (input.permission?.length) restrictedSessions.set(session.id, session.projectID);
        return { data: session };
      },
      prompt: async (input, options) => {
        const sessionID = input.sessionID;
        const restricted = restrictedSessions.has(sessionID);
        const stopped = new AbortController();
        const execution = new AbortController();
        const signal = options?.signal ? AbortSignal.any([options.signal, execution.signal]) : execution.signal;
        const requestOptions = { signal, headers: { 'x-opencode-directory': encodeURIComponent(input.directory) } };
        let guard: Promise<void> | undefined;
        try {
          if (restricted) {
            // OpenCode appends saved project approvals after session rules, so
            // they can turn `ask` into `allow`. Never delete user approvals;
            // refuse to submit a prompt when one could authorize shell.
            const saved = await client.permission.saved.list({ projectID: restrictedSessions.get(sessionID) }, requestOptions);
            if (saved.some(rule => matchesShell(rule.action))) {
              throw new Error('Cannot enforce read-only OpenCode session: saved shell approvals exist for this project. Remove them in OpenCode or use an isolated project.');
            }
            const guardOptions = { ...requestOptions, signal: AbortSignal.any([signal, stopped.signal]) };
            guard = (async () => {
              try {
                while (true) {
                  const requests = await client.permission.list({ sessionID }, guardOptions);
                  // A rejection also rejects the current batch in OpenCode.
                  // Re-list before replying again to avoid using stale IDs.
                  const request = requests.find(item => item.sessionID === sessionID && item.action === 'shell');
                  if (request) {
                    await client.permission.reply({ sessionID, requestID: request.id, decision: 'reject',
                      message: 'Aghast is read-only. Shell commands are prohibited; use read, glob or grep instead.' }, guardOptions);
                  }
                  await delay(100, undefined, { signal: guardOptions.signal });
                }
              } catch (error) {
                if (!stopped.signal.aborted) throw new Error('Cannot enforce read-only OpenCode shell permissions', { cause: error });
              }
            })();
          }
          const result = (async () => {
            await client.session.switchModel({ sessionID, model: { id: input.model.modelID, providerID: input.model.providerID } }, requestOptions);
            // v2 does not expose the legacy JSON-schema format. Preserve the output
            // contract by requesting JSON in the prompt and using Aghast's parser.
            const schema = input.format ? `\n\nReturn only JSON matching this schema: ${JSON.stringify(input.format.schema)}` : '';
            await client.session.prompt({ sessionID, text: input.parts.map(part => part.text).join('\n') + schema }, requestOptions);
            await client.session.wait({ sessionID }, requestOptions);
            const [session, messages] = await Promise.all([
              client.session.get({ sessionID }, requestOptions),
              client.message.list({ sessionID, type: 'assistant', order: 'desc', limit: 1 }, requestOptions),
            ]);
            const message = messages.data.find((item): item is SessionMessageAssistant => item.type === 'assistant');
            if (session.outcome === 'failed' || session.outcome === 'interrupted') {
              throw new Error(`OpenCode session ${session.outcome}: ${message?.error?.message ?? 'execution did not succeed'}`);
            }
            return { data: {
              info: {
                // Session totals include all tool-loop steps, not just the final message.
                tokens: session.tokens,
                cost: session.cost,
                ...(message?.error ? { error: { name: message.error.type, data: { message: message.error.message } } } : {}),
              },
              parts: message?.content.filter(part => part.type === 'text').map(part => ({ type: 'text', text: part.text })),
            } };
          })();
          // Permission transport failures are fatal to this check, unlike the
          // optional progress SSE stream. A disconnected guard must fail closed.
          return guard ? await Promise.race([result, guard.then(() => { throw new Error('OpenCode permission guard stopped unexpectedly'); })]) : await result;
        } catch (error) {
          execution.abort();
          if (restricted) await client.session.interrupt({ sessionID }, {
            ...requestOptions, signal: AbortSignal.timeout(5_000),
          }).catch(() => {});
          throw error;
        } finally {
          stopped.abort();
          execution.abort();
          await guard?.catch(() => {});
          restrictedSessions.delete(sessionID);
        }
      },
    },
    event: {
      subscribe: async (_input, options) => ({ stream: (async function* () {
        const tools = new Map<string, string>();
        for await (const event of client.event.subscribe(options)) {
          if (!('data' in event)) continue;
          // Individual step failures can be retried by OpenCode. Only the
          // terminal execution event invalidates the check's answer.
          if (event.type === 'session.execution.failed') {
            yield { type: 'session.error', properties: {
              sessionID: event.data.sessionID,
              error: { name: event.data.error.type, data: { message: event.data.error.message } },
            } };
          } else if (event.type === 'session.execution.interrupted') {
            yield { type: 'session.error', properties: {
              sessionID: event.data.sessionID,
              error: { name: 'InterruptedError', data: { message: `Execution interrupted: ${event.data.reason}` } },
            } };
          } else if (event.type === 'session.tool.input.started') {
            tools.set(`${event.data.sessionID}/${event.data.id}`, event.data.name);
          } else if (event.type === 'session.tool.called' || event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
            const key = `${event.data.sessionID}/${event.data.id}`;
            const tool = tools.get(key) ?? 'unknown';
            const state = event.type === 'session.tool.called'
              ? { status: 'running', input: event.data.input }
              : event.type === 'session.tool.success'
                ? { status: 'completed', output: event.data.content.filter(item => item.type === 'text').map(item => item.text).join('\n') }
                : { status: 'error', error: event.data.error.message };
            if (event.type !== 'session.tool.called') tools.delete(key);
            yield { type: 'message.part.updated', properties: {
              sessionID: event.data.sessionID,
              part: { id: event.data.id, type: 'tool', tool, state },
            } };
          }
        }
      })() }),
    },
  };
}
