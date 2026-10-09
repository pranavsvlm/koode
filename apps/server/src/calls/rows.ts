import type { Call, CallState } from '@koode/shared';

export type CallRow = {
  id: string;
  kind: 'voice' | 'video';
  caller_id: string;
  callee_id: string;
  state: CallState;
  created_at: number;
  answered_at: number | null;
  ended_at: number | null;
};

export const COLUMNS = 'id, kind, caller_id, callee_id, state, created_at, answered_at, ended_at';
export const toCall = (r: CallRow): Call => ({
  id: r.id,
  kind: r.kind,
  callerId: r.caller_id,
  calleeId: r.callee_id,
  state: r.state,
  createdAt: r.created_at,
  answeredAt: r.answered_at,
  endedAt: r.ended_at,
});

/** Move a call from one state to another only if it is still in `from` (race-safe). */
export async function transition(
  db: D1Database,
  id: string,
  from: CallState[],
  to: CallState,
  extra: 'answered' | 'ended',
) {
  const now = Date.now();
  const column = extra === 'answered' ? 'answered_at' : 'ended_at';
  const row = await db
    .prepare(
      `UPDATE calls SET state = ?, ${column} = ? WHERE id = ? AND state IN (${from.map(() => '?').join(',')}) RETURNING ${COLUMNS}`,
    )
    .bind(to, now, id, ...from)
    .first<CallRow>();
  return row;
}

export async function displayName(db: D1Database, userId: string) {
  return (
    (
      await db
        .prepare('SELECT display_name FROM users WHERE id = ?')
        .bind(userId)
        .first<{ display_name: string }>()
    )?.display_name ?? 'Koode'
  );
}
