import { createApp } from './app';

export { ConversationRoom } from './durable-objects/conversation-room';
export { UserSocket } from './durable-objects/user-socket';

const app = createApp();

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
