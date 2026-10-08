import { createApp } from './app';

export { ConversationRoom } from './durable-objects/conversation-room';

const app = createApp();

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
