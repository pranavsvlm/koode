import { createApp } from './app';
import { cleanupUnsent } from './media/storage';

export { ConversationRoom } from './durable-objects/conversation-room';
export { UserSocket } from './durable-objects/user-socket';
export { CallTimer } from './durable-objects/call-timer';

const app = createApp();

export default {
  fetch: app.fetch,
  // Hourly (wrangler.jsonc "triggers"): remove uploads that were never sent.
  scheduled: async (_controller, env, ctx) => {
    ctx.waitUntil(
      cleanupUnsent(env).then((n) =>
        console.log(JSON.stringify({ type: 'cleanup', unsentAttachments: n })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
