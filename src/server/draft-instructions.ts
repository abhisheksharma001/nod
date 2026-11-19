import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withdrawnSql } from './turn-chain.ts';
import { captureOwnerInstructions } from './owner-instructions.ts';

type Database = Pick<Pool, 'query'>;
type Origin = {
  source: string;
  messageIds: string[];
  taskId: string | null;
};

export async function captureDraftInstructions(
  database: Database,
  ownerId: string,
  turn: { turnId: string; threadId: string },
  origin: Origin,
  connectionId: string,
  binding: string,
  args: Record<string, unknown>,
) {
  const said =
    origin.source === 'user'
      ? await captureOwnerInstructions(
          database,
          ownerId,
          turn.threadId,
          origin.messageIds,
          origin.taskId,
          new Date(Date.now() - 86_400_000),
          turn.turnId,
        )
      : undefined;
  const id = randomUUID();
  await database.query(
    `INSERT INTO draft_instructions(id,owner_id,thread_id,turn_id,task_id,connection_id,binding,source_ids,draft_id,target)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      ownerId,
      turn.threadId,
      turn.turnId,
      origin.taskId,
      connectionId,
      binding,
      said?.evidence.messages.flatMap((message) => (message.id ? [message.id] : [])) ?? [],
      typeof args.draft_id === 'string' ? args.draft_id : null,
      JSON.stringify(
        Object.fromEntries(
          ['recipient_email', 'to', 'cc', 'bcc', 'extra_recipients', 'subject'].flatMap((key) =>
            args[key] === undefined ? [] : [[key, args[key]]],
          ),
        ),
      ),
    ],
  );
  return id;
}

export async function completeDraftInstructions(
  database: Database,
  ownerId: string,
  id: string,
  result: unknown,
  requestedId?: unknown,
) {
  const value = result as {
    id?: unknown;
    draft?: { id?: unknown };
    data?: { id?: unknown };
  } | null;
  const draftId = value?.id ?? value?.draft?.id ?? value?.data?.id ?? requestedId;
  if (typeof draftId !== 'string' || !draftId.trim()) return;
  await database.query(
    'UPDATE draft_instructions SET draft_id=$3,complete=true WHERE id=$1 AND owner_id=$2',
    [id, ownerId, draftId],
  );
}

export async function retainedDraftInstructions(
  database: Database,
  ownerId: string,
  threadId: string,
  taskId: string | null,
  lock = false,
) {
  const drafts = (
    await database.query<{
      draft_id: string | null;
      source_ids: string[];
      binding: string;
      complete: boolean;
      target: Record<string, unknown>;
      connection_id: string;
    }>(
      `SELECT d.draft_id,d.source_ids,d.complete,d.target,d.connection_id,d.binding
       FROM draft_instructions d
       WHERE d.owner_id=$1 AND d.thread_id=$2
         AND (d.task_id IS NOT DISTINCT FROM $3::uuid OR ($3::uuid IS NOT NULL AND d.task_id IS NULL
           AND d.created_at<=(SELECT created_at FROM tasks WHERE id=$3::uuid AND owner_id=$1)))
       ORDER BY d.created_at,d.id${lock ? ' FOR SHARE OF d' : ''}`,
      [ownerId, threadId, taskId],
    )
  ).rows;
  if (!drafts.length) return [];
  const accounts = (
    await database.query<{ id: string; binding: unknown[] }>(
      `SELECT id,jsonb_build_array(account_id,provider_id,configuration_id,watch_revision) AS binding
       FROM app_connections WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND account_active AND NOT revoked${lock ? ' FOR SHARE' : ''}`,
      [ownerId, [...new Set(drafts.map((draft) => draft.connection_id))]],
    )
  ).rows;
  const ids = [...new Set(drafts.flatMap((draft) => draft.source_ids))];
  const messages = ids.length
    ? (
        await database.query<{ id: string; text: string; created_at: Date }>(
          `SELECT m.id,m.text,m.created_at FROM messages m
           WHERE m.owner_id=$1 AND m.thread_id=$2 AND m.id=ANY($3::uuid[]) AND m.role='user'
             AND m.hidden_at IS NULL AND m.approval_answer IS NULL AND NOT ${withdrawnSql('m')}
             AND (EXISTS (SELECT 1 FROM turns u WHERE u.owner_id=$1 AND (u.id=m.turn_id OR u.message_id=m.id)
               AND to_jsonb(u)->>'task_id'=$4::text) OR (NOT EXISTS (
                 SELECT 1 FROM turns u WHERE u.owner_id=$1 AND (u.id=m.turn_id OR u.message_id=m.id)
                   AND to_jsonb(u)->>'task_id' IS NOT NULL)
               AND ($4::uuid IS NULL OR m.created_at<=(SELECT created_at FROM tasks WHERE id=$4::uuid AND owner_id=$1))))
           ORDER BY m.created_at,m.id${lock ? ' FOR SHARE OF m' : ''}`,
          [ownerId, threadId, ids, taskId],
        )
      ).rows
    : [];
  return drafts.map((draft) => {
    const sources = messages.filter((message) => draft.source_ids.includes(message.id));
    return {
      draftId: draft.draft_id,
      connectionId: draft.connection_id,
      target: draft.target,
      messages: sources.map((message) => ({
        at: message.created_at.toISOString(),
        text: message.text,
        canAuthorize: false as const,
      })),
      unavailable:
        !draft.complete ||
        !draft.draft_id ||
        !accounts.some(
          (account) =>
            account.id === draft.connection_id && JSON.stringify(account.binding) === draft.binding,
        ) ||
        !draft.source_ids.length ||
        sources.length !== new Set(draft.source_ids).size,
    };
  });
}
