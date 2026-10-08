import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Folder, FolderRole, Message, Thread } from "@fluxmail/core";
import type {
  AccountInfo,
  DraftRecipientFields,
  MailThread,
  MailboxView,
  ModifyActionInput,
  ThreadSummary,
} from "../shared/contracts";

interface BodyCipher {
  encrypt(value: string): Buffer | undefined;
  decrypt(value: Buffer): string;
}

interface CachedThreadRow {
  account_id: string;
  thread_id: string;
  account_email: string;
  subject: string;
  sender_name: string;
  sender_email: string;
  snippet: string;
  date: string;
  unread: number;
  starred: number;
  draft: number;
  has_attachments: number;
  message_count: number;
  labels_json: string;
  folder_roles_json: string;
}

interface CachedMessageRow {
  account_id: string;
  message_id: string;
  thread_id: string;
  payload_json: string;
  date: string;
}

interface CachedThreadBodyRow {
  account_id: string;
  thread_id: string;
  encrypted_payload: Buffer;
  hydrated_at: number;
}

interface CachedThreadState {
  accountId: string;
  threadId: string;
  row?: CachedThreadRow;
  messages: CachedMessageRow[];
  body?: CachedThreadBodyRow;
}

export interface ScheduledDraftRef {
  scheduleId: string;
  accountId: string;
  draftId: string;
  sendAt: string;
  pendingSend?: boolean;
}

const CACHE_SCHEMA_VERSION = 6;

export class MailCache {
  readonly hasCachedMail: boolean;
  private readonly db: Database.Database;

  constructor(
    dataDir: string,
    private readonly cipher: BodyCipher,
  ) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "mail-cache.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        date TEXT NOT NULL,
        PRIMARY KEY (account_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(account_id, thread_id);
      CREATE TABLE IF NOT EXISTS threads (
        account_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        account_email TEXT NOT NULL,
        subject TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        snippet TEXT NOT NULL,
        date TEXT NOT NULL,
        unread INTEGER NOT NULL,
        starred INTEGER NOT NULL,
        draft INTEGER NOT NULL,
        has_attachments INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        labels_json TEXT NOT NULL,
        folder_roles_json TEXT NOT NULL,
        PRIMARY KEY (account_id, thread_id)
      );
      CREATE INDEX IF NOT EXISTS threads_date ON threads(date DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS thread_search USING fts5(
        key UNINDEXED, subject, sender_name, sender_email, snippet
      );
      CREATE TABLE IF NOT EXISTS thread_bodies (
        account_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        encrypted_payload BLOB NOT NULL,
        hydrated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS folders (
        account_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (account_id, folder_id)
      );
      CREATE TABLE IF NOT EXISTS page_tokens (
        account_id TEXT NOT NULL,
        view_key TEXT NOT NULL,
        page_token TEXT,
        PRIMARY KEY (account_id, view_key)
      );
      CREATE TABLE IF NOT EXISTS view_results (
        account_id TEXT NOT NULL,
        view_key TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        PRIMARY KEY (account_id, view_key, thread_id)
      );
      CREATE TABLE IF NOT EXISTS notification_seen (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS notification_state (
        account_id TEXT PRIMARY KEY,
        initialized_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS draft_recipient_fields (
        account_id TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        to_raw TEXT NOT NULL,
        cc_raw TEXT NOT NULL,
        bcc_raw TEXT NOT NULL,
        provider_recipients_json TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (account_id, draft_id)
      );
      CREATE TEMP TABLE IF NOT EXISTS thread_mutation_owners (
        account_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        PRIMARY KEY (account_id, thread_id)
      );
    `);
    const draftRecipientColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(draft_recipient_fields)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!draftRecipientColumns.has("provider_recipients_json")) {
      this.db.exec(
        "ALTER TABLE draft_recipient_fields ADD COLUMN provider_recipients_json TEXT NOT NULL DEFAULT ''",
      );
    }
    const notificationStateColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(notification_state)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!notificationStateColumns.has("max_date")) {
      this.db.exec("ALTER TABLE notification_state ADD COLUMN max_date TEXT");
    }
    const storedVersion = Number(
      (
        this.db.prepare("SELECT value FROM cache_meta WHERE key = 'schema_version'").get() as
          | { value: string }
          | undefined
      )?.value ?? 0,
    );
    if (storedVersion < 3) {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM view_results").run();
        this.db.prepare("DROP TABLE IF EXISTS search_results").run();
      })();
    }
    if (storedVersion < 5) this.db.prepare("DELETE FROM page_tokens").run();
    if (storedVersion < 6) this.db.prepare("DELETE FROM thread_bodies").run();
    this.db
      .prepare("INSERT OR REPLACE INTO cache_meta(key, value) VALUES ('schema_version', ?)")
      .run(String(CACHE_SCHEMA_VERSION));
    this.hasCachedMail = Boolean(this.db.prepare("SELECT 1 FROM threads LIMIT 1").get());
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // macOS applies the user directory permissions even if chmod is unavailable.
    }
  }

  close(): void {
    this.db.close();
  }

  hasAnyThreads(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM threads LIMIT 1").get());
  }

  accountIds(): string[] {
    return (
      this.db
        .prepare(
          `SELECT account_id FROM messages
           UNION SELECT account_id FROM threads
           UNION SELECT account_id FROM folders
           UNION SELECT account_id FROM page_tokens
           UNION SELECT account_id FROM view_results
           UNION SELECT account_id FROM notification_seen
           UNION SELECT account_id FROM notification_state
           UNION SELECT account_id FROM draft_recipient_fields`,
        )
        .all() as Array<{ account_id: string }>
    ).map((row) => row.account_id);
  }

  putFolders(accountId: string, folders: Folder[]): void {
    const put = this.db.prepare(
      "INSERT OR REPLACE INTO folders(account_id, folder_id, payload_json) VALUES (?, ?, ?)",
    );
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM folders WHERE account_id = ?").run(accountId);
      for (const folder of folders) put.run(accountId, folder.id, JSON.stringify(folder));
    })();
  }

  recordResultPage(accountId: string, viewKey: string, threadIds: string[], reset: boolean): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO view_results(account_id, view_key, thread_id) VALUES (?, ?, ?)",
    );
    this.db.transaction(() => {
      if (reset)
        this.db
          .prepare("DELETE FROM view_results WHERE account_id = ? AND view_key = ?")
          .run(accountId, viewKey);
      for (const threadId of new Set(threadIds)) insert.run(accountId, viewKey, threadId);
    })();
  }

  listFolders(): Array<Folder & { accountId: string }> {
    return (
      this.db
        .prepare("SELECT account_id, payload_json FROM folders ORDER BY account_id, payload_json")
        .all() as Array<{
        account_id: string;
        payload_json: string;
      }>
    ).map((row) => ({
      ...(JSON.parse(row.payload_json) as Folder),
      accountId: row.account_id,
    }));
  }

  unreadCount(accountIds?: string[]): number {
    const accountFilter = accountIds?.length
      ? ` AND account_id IN (${accountIds.map(() => "?").join(", ")})`
      : "";
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM threads
         WHERE unread = 1 AND folder_roles_json LIKE ?${accountFilter}`,
      )
      .get('%"inbox"%', ...(accountIds ?? [])) as { count: number };
    return row.count;
  }

  draftCount(accountIds?: string[], scheduledDrafts: ScheduledDraftRef[] = []): number {
    return this.countThreads({
      view: "drafts",
      ...(accountIds?.length ? { accountIds } : {}),
      scheduledDrafts,
    });
  }

  listScheduledThreads(schedules: ScheduledDraftRef[], accountIds?: string[]): ThreadSummary[] {
    const includedAccounts = accountIds?.length ? new Set(accountIds) : undefined;
    const findDraft = this.db.prepare(
      `SELECT threads.*, messages.payload_json
       FROM messages
       JOIN threads
         ON threads.account_id = messages.account_id
        AND threads.thread_id = messages.thread_id
       WHERE messages.account_id = ?
         AND json_extract(messages.payload_json, '$.draftId') = ?
       LIMIT 1`,
    );
    return schedules
      .flatMap((schedule) => {
        if (includedAccounts && !includedAccounts.has(schedule.accountId)) return [];
        const row = findDraft.get(schedule.accountId, schedule.draftId) as
          | (CachedThreadRow & { payload_json: string })
          | undefined;
        if (!row) return [];
        const message = JSON.parse(row.payload_json) as Message;
        const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
        return [
          {
            ...toSummary(row),
            scheduleId: schedule.scheduleId,
            draftId: schedule.draftId,
            subject: message.subject,
            senderName:
              recipients
                .map((recipient) => recipient.name || recipient.email)
                .filter(Boolean)
                .join(", ") || "No recipients",
            senderEmail: recipients[0]?.email ?? "",
            snippet: message.snippet ?? "",
            date: schedule.sendAt,
            hasAttachments: Boolean(message.attachments?.length),
          },
        ];
      })
      .sort((left, right) => Date.parse(left.date) - Date.parse(right.date));
  }

  putMessages(
    account: AccountInfo,
    messages: Message[],
    options: { invalidateBodies?: boolean } = {},
  ): void {
    const put = this.db.prepare(`
      INSERT INTO messages(account_id, message_id, thread_id, payload_json, date)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, message_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        payload_json = excluded.payload_json,
        date = excluded.date
    `);
    const existingMessage = this.db.prepare(
      "SELECT thread_id, payload_json, date FROM messages WHERE account_id = ? AND message_id = ?",
    );
    const previousDraftMessages = this.db.prepare(
      `SELECT message_id, thread_id
       FROM messages
       WHERE account_id = ?
         AND json_extract(payload_json, '$.draftId') = ?
         AND message_id != ?`,
    );
    const removeMessage = this.db.prepare(
      "DELETE FROM messages WHERE account_id = ? AND message_id = ?",
    );
    const threadIds = new Set<string>();
    this.db.transaction(() => {
      for (const message of messages) {
        if (message.draftId) {
          const previous = previousDraftMessages.all(
            account.id,
            message.draftId,
            message.id,
          ) as Array<{ message_id: string; thread_id: string }>;
          for (const cached of previous) {
            removeMessage.run(account.id, cached.message_id);
            threadIds.add(cached.thread_id);
          }
        }
        const { body: _body, ...metadata } = message;
        const payload = JSON.stringify(metadata);
        const existing = existingMessage.get(account.id, message.id) as
          | { thread_id: string; payload_json: string; date: string }
          | undefined;
        put.run(account.id, message.id, message.threadId, payload, message.date);
        if (
          options.invalidateBodies ||
          !existing ||
          existing.thread_id !== message.threadId ||
          existing.payload_json !== payload ||
          existing.date !== message.date
        ) {
          if (existing) threadIds.add(existing.thread_id);
          threadIds.add(message.threadId);
        }
      }
      for (const threadId of threadIds) {
        this.invalidateThreadBody(account.id, threadId);
        this.rebuildThread(account, threadId);
      }
    })();
  }

  putOptimisticDraft(account: AccountInfo, draft: Message): void {
    const existing = this.getThread(account.id, draft.threadId);
    this.putMessages(account, [draft], { invalidateBodies: true });
    // Metadata can outlive the hydrated body after a mailbox refresh. Keep a cache miss
    // so the next read fetches the whole conversation instead of showing only the reply.
    if (
      !existing &&
      this.messageIds(account.id, draft.threadId).some((messageId) => messageId !== draft.id)
    )
      return;
    const messages = [
      ...(existing?.messages.filter(
        (message) => message.id !== draft.id && message.draftId !== draft.draftId,
      ) ?? []),
      { ...draft, folderRole: draft.folder?.role },
    ].sort((left, right) => Date.parse(left.date) - Date.parse(right.date));
    const preview: MailThread = {
      id: draft.threadId,
      accountId: account.id,
      accountEmail: account.email,
      subject: existing?.subject ?? draft.subject,
      messages,
    };
    const encrypted = this.cipher.encrypt(JSON.stringify(preview));
    if (!encrypted) return;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO thread_bodies(account_id, thread_id, encrypted_payload, hydrated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(account.id, draft.threadId, encrypted, Date.now());
  }

  putThread(
    account: AccountInfo,
    thread: Thread,
    options: { mutationId?: string } = {},
  ): MailThread {
    const cachedMessageIds = this.messageIds(account.id, thread.id);
    const currentMessageIds = new Set(thread.messages.map((message) => message.id));
    const removeMessage = this.db.prepare(
      "DELETE FROM messages WHERE account_id = ? AND message_id = ?",
    );
    this.db.transaction(() => {
      for (const messageId of cachedMessageIds)
        if (!currentMessageIds.has(messageId)) removeMessage.run(account.id, messageId);
      this.putMessages(account, thread.messages);
      this.rebuildThread(account, thread.id, options.mutationId);
    })();
    const normalized = this.toMailThread(account, thread);
    const encrypted = this.cipher.encrypt(JSON.stringify(normalized));
    if (!encrypted) {
      this.invalidateThreadBody(account.id, thread.id);
      return normalized;
    }
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO thread_bodies(account_id, thread_id, encrypted_payload, hydrated_at)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run(account.id, thread.id, encrypted, Date.now());
    return normalized;
  }

  getThread(accountId: string, threadId: string): MailThread | undefined {
    const row = this.db
      .prepare("SELECT encrypted_payload FROM thread_bodies WHERE account_id = ? AND thread_id = ?")
      .get(accountId, threadId) as { encrypted_payload: Buffer } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(this.cipher.decrypt(row.encrypted_payload)) as MailThread;
    } catch {
      this.db
        .prepare("DELETE FROM thread_bodies WHERE account_id = ? AND thread_id = ?")
        .run(accountId, threadId);
      return undefined;
    }
  }

  hasThreadBody(accountId: string, threadId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM thread_bodies WHERE account_id = ? AND thread_id = ?")
        .get(accountId, threadId),
    );
  }

  listThreads(input: {
    view: MailboxView;
    accountIds?: string[];
    label?: string;
    query?: string;
    resultSetKey?: string;
    scheduledDrafts?: ScheduledDraftRef[];
    offset: number;
    limit: number;
  }): ThreadSummary[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (input.accountIds?.length) {
      conditions.push(`account_id IN (${input.accountIds.map(() => "?").join(", ")})`);
      params.push(...input.accountIds);
    }
    const role = viewFolderRole(input.view);
    if (role) addFolderRoleCondition(conditions, params, role, input.scheduledDrafts);
    if (input.view === "all") {
      conditions.push(`(
        json_array_length(folder_roles_json) = 0 OR EXISTS (
          SELECT 1
          FROM json_each(threads.folder_roles_json) AS folder_role
          WHERE folder_role.value NOT IN ('spam', 'trash')
        )
      )`);
    }
    if (input.view === "starred") conditions.push("starred = 1");
    if (input.view === "drafts") {
      conditions.push("draft = 1");
      addScheduledDraftExclusion(conditions, params, input.scheduledDrafts);
    }
    if (input.view === "label" && input.label) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(threads.labels_json) AS label WHERE label.value = ?)",
      );
      params.push(input.label);
    }
    if (input.resultSetKey) {
      addResultSetCondition(
        conditions,
        params,
        input.resultSetKey,
        input.view,
        input.scheduledDrafts,
      );
    } else if (input.query?.trim()) {
      const keys = this.searchKeys(input.query, input.limit * 3);
      if (!keys.length) return [];
      conditions.push(`(account_id || ':' || thread_id) IN (${keys.map(() => "?").join(", ")})`);
      params.push(...keys);
    }
    params.push(input.limit, input.offset);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM threads ${where} ORDER BY date DESC LIMIT ? OFFSET ?`)
      .all(...params) as CachedThreadRow[];
    const scheduledByDraft = new Map(
      (input.scheduledDrafts ?? []).map((scheduled) => [
        scheduledDraftKey(scheduled.accountId, scheduled.draftId),
        scheduled,
      ]),
    );
    const scheduledDraftKeys = JSON.stringify([...scheduledByDraft.keys()]);
    const latestDraft = scheduledByDraft.size
      ? this.db.prepare(
          `SELECT json_extract(payload_json, '$.draftId') AS draft_id
           FROM messages
           WHERE account_id = ?
             AND thread_id = ?
             AND json_extract(payload_json, '$.flags.draft') = 1
             AND json_extract(payload_json, '$.draftId') IS NOT NULL
             ${
               input.view === "drafts"
                 ? `AND json_array(
                      account_id,
                      json_extract(payload_json, '$.draftId')
                    ) NOT IN (SELECT value FROM json_each(?))`
                 : ""
             }
           ORDER BY date DESC, rowid DESC
           LIMIT 1`,
        )
      : undefined;
    return rows.map((row) => {
      const summary = toSummary(row);
      const draft = (
        input.view === "drafts"
          ? latestDraft?.get(row.account_id, row.thread_id, scheduledDraftKeys)
          : latestDraft?.get(row.account_id, row.thread_id)
      ) as { draft_id: string } | undefined;
      if (input.view === "drafts" && draft) {
        return {
          ...summary,
          draftId: draft.draft_id,
        };
      }
      const scheduled = draft
        ? scheduledByDraft.get(scheduledDraftKey(row.account_id, draft.draft_id))
        : undefined;
      return scheduled
        ? {
            ...summary,
            scheduleId: scheduled.scheduleId,
            draftId: scheduled.draftId,
            ...(scheduled.pendingSend ? { pendingSend: true } : {}),
          }
        : summary;
    });
  }

  countThreads(input: {
    view: MailboxView;
    accountIds?: string[];
    label?: string;
    query?: string;
    resultSetKey?: string;
    scheduledDrafts?: ScheduledDraftRef[];
  }): number {
    if (input.query?.trim() && !input.resultSetKey)
      return this.listThreads({ ...input, offset: 0, limit: 1_000_000 }).length;
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (input.accountIds?.length) {
      conditions.push(`account_id IN (${input.accountIds.map(() => "?").join(", ")})`);
      params.push(...input.accountIds);
    }
    const role = viewFolderRole(input.view);
    if (role) addFolderRoleCondition(conditions, params, role, input.scheduledDrafts);
    if (input.view === "all") {
      conditions.push(`(
        json_array_length(folder_roles_json) = 0 OR EXISTS (
          SELECT 1
          FROM json_each(threads.folder_roles_json) AS folder_role
          WHERE folder_role.value NOT IN ('spam', 'trash')
        )
      )`);
    }
    if (input.view === "starred") conditions.push("starred = 1");
    if (input.view === "drafts") {
      conditions.push("draft = 1");
      addScheduledDraftExclusion(conditions, params, input.scheduledDrafts);
    }
    if (input.view === "label" && input.label) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(threads.labels_json) AS label WHERE label.value = ?)",
      );
      params.push(input.label);
    }
    if (input.resultSetKey)
      addResultSetCondition(
        conditions,
        params,
        input.resultSetKey,
        input.view,
        input.scheduledDrafts,
      );
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM threads ${where}`)
      .get(...params) as {
      count: number;
    };
    return row.count;
  }

  messageIds(accountId: string, threadId: string): string[] {
    return (
      this.db
        .prepare("SELECT message_id FROM messages WHERE account_id = ? AND thread_id = ?")
        .all(accountId, threadId) as Array<{
        message_id: string;
      }>
    ).map((row) => row.message_id);
  }

  snapshotThread(accountId: string, threadId: string): CachedThreadRow | undefined {
    return this.db
      .prepare("SELECT * FROM threads WHERE account_id = ? AND thread_id = ?")
      .get(accountId, threadId) as CachedThreadRow | undefined;
  }

  snapshotThreadState(accountId: string, threadId: string): CachedThreadState {
    return {
      accountId,
      threadId,
      row: this.snapshotThread(accountId, threadId),
      messages: this.db
        .prepare(
          `SELECT account_id, message_id, thread_id, payload_json, date
           FROM messages
           WHERE account_id = ? AND thread_id = ?`,
        )
        .all(accountId, threadId) as CachedMessageRow[],
      body: this.db
        .prepare(
          `SELECT account_id, thread_id, encrypted_payload, hydrated_at
           FROM thread_bodies
           WHERE account_id = ? AND thread_id = ?`,
        )
        .get(accountId, threadId) as CachedThreadBodyRow | undefined,
    };
  }

  claimMutation(mutationId: string, targets: Array<{ accountId: string; threadId: string }>): void {
    const claim = this.db.prepare(
      `INSERT INTO thread_mutation_owners(account_id, thread_id, mutation_id)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id, thread_id) DO UPDATE SET mutation_id = excluded.mutation_id`,
    );
    this.db.transaction(() => {
      for (const target of targets) claim.run(target.accountId, target.threadId, mutationId);
    })();
  }

  ownsMutation(accountId: string, threadId: string, mutationId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM thread_mutation_owners
           WHERE account_id = ? AND thread_id = ? AND mutation_id = ?`,
        )
        .get(accountId, threadId, mutationId),
    );
  }

  releaseMutation(
    mutationId: string,
    targets: Array<{ accountId: string; threadId: string }>,
  ): void {
    const release = this.db.prepare(
      `DELETE FROM thread_mutation_owners
       WHERE account_id = ? AND thread_id = ? AND mutation_id = ?`,
    );
    this.db.transaction(() => {
      for (const target of targets) release.run(target.accountId, target.threadId, mutationId);
    })();
  }

  restoreThread(row: CachedThreadRow): void {
    this.writeThread(row);
  }

  restoreThreadIfOwned(row: CachedThreadRow, mutationId: string): boolean {
    if (!this.ownsMutation(row.account_id, row.thread_id, mutationId)) return false;
    this.writeThread(row);
    return true;
  }

  restoreThreadStateIfOwned(state: CachedThreadState, mutationId: string): boolean {
    if (!this.ownsMutation(state.accountId, state.threadId, mutationId)) return false;
    const putMessage = this.db.prepare(
      `INSERT OR REPLACE INTO messages(account_id, message_id, thread_id, payload_json, date)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM messages WHERE account_id = ? AND thread_id = ?")
        .run(state.accountId, state.threadId);
      for (const message of state.messages)
        putMessage.run(
          message.account_id,
          message.message_id,
          message.thread_id,
          message.payload_json,
          message.date,
        );

      const searchKey = `${state.accountId}:${state.threadId}`;
      if (state.row) {
        this.writeThread(state.row);
      } else {
        this.db
          .prepare("DELETE FROM threads WHERE account_id = ? AND thread_id = ?")
          .run(state.accountId, state.threadId);
        this.db.prepare("DELETE FROM thread_search WHERE key = ?").run(searchKey);
      }

      if (state.body) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO thread_bodies(
               account_id, thread_id, encrypted_payload, hydrated_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            state.body.account_id,
            state.body.thread_id,
            state.body.encrypted_payload,
            state.body.hydrated_at,
          );
      } else {
        this.db
          .prepare("DELETE FROM thread_bodies WHERE account_id = ? AND thread_id = ?")
          .run(state.accountId, state.threadId);
      }
    })();
    return true;
  }

  putThreadIfOwned(
    account: AccountInfo,
    thread: Thread,
    mutationId: string,
  ): MailThread | undefined {
    if (!this.ownsMutation(account.id, thread.id, mutationId)) return undefined;
    return this.putThread(account, thread, { mutationId });
  }

  applyAction(accountId: string, threadId: string, action: ModifyActionInput): void {
    if (action.type === "markRead")
      this.db
        .prepare("UPDATE threads SET unread = 0 WHERE account_id = ? AND thread_id = ?")
        .run(accountId, threadId);
    if (action.type === "markUnread")
      this.db
        .prepare("UPDATE threads SET unread = 1 WHERE account_id = ? AND thread_id = ?")
        .run(accountId, threadId);
    if (action.type === "star")
      this.db
        .prepare("UPDATE threads SET starred = 1 WHERE account_id = ? AND thread_id = ?")
        .run(accountId, threadId);
    if (action.type === "unstar")
      this.db
        .prepare("UPDATE threads SET starred = 0 WHERE account_id = ? AND thread_id = ?")
        .run(accountId, threadId);
    if (action.type === "archive") this.removeRole(accountId, threadId, "inbox");
    if (action.type === "trash") this.replaceRoles(accountId, threadId, ["trash"]);
    if (action.type === "untrash") this.replaceRoles(accountId, threadId, ["inbox"]);
    if (action.type === "move") this.replaceRoles(accountId, threadId, [action.folder]);
    if (action.type === "addLabels") this.updateLabels(accountId, threadId, action.labels, []);
    if (action.type === "removeLabels") this.updateLabels(accountId, threadId, [], action.labels);
    if (action.type === "delete") this.hideThread(accountId, threadId);
  }

  applyActionIfOwned(
    accountId: string,
    threadId: string,
    action: ModifyActionInput,
    mutationId: string,
  ): boolean {
    if (!this.ownsMutation(accountId, threadId, mutationId)) return false;
    this.applyAction(accountId, threadId, action);
    return true;
  }

  finalizeDelete(accountId: string, threadId: string): void {
    this.deleteThread(accountId, threadId);
  }

  finalizeDeleteIfOwned(accountId: string, threadId: string, mutationId: string): boolean {
    if (!this.ownsMutation(accountId, threadId, mutationId)) return false;
    this.deleteThread(accountId, threadId);
    return true;
  }

  deleteDraft(account: AccountInfo, draftId: string): void {
    this.deleteDraftRecipientFields(account.id, draftId);
    const rows = this.db
      .prepare(
        `SELECT message_id, thread_id
         FROM messages
         WHERE account_id = ? AND json_extract(payload_json, '$.draftId') = ?`,
      )
      .all(account.id, draftId) as Array<{
      message_id: string;
      thread_id: string;
    }>;
    if (!rows.length) return;
    const remove = this.db.prepare("DELETE FROM messages WHERE account_id = ? AND message_id = ?");
    const threadIds = new Set(rows.map((row) => row.thread_id));
    this.db.transaction(() => {
      for (const row of rows) remove.run(account.id, row.message_id);
      for (const threadId of threadIds) {
        this.invalidateThreadBody(account.id, threadId);
        this.rebuildThread(account, threadId);
      }
    })();
  }

  hasDraft(accountId: string, draftId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM messages
           WHERE account_id = ? AND json_extract(payload_json, '$.draftId') = ?
           LIMIT 1`,
        )
        .get(accountId, draftId),
    );
  }

  putDraftRecipientFields(
    accountId: string,
    draftId: string,
    fields: DraftRecipientFields,
    draft: Pick<Message, "to" | "cc" | "bcc">,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO draft_recipient_fields(
          account_id, draft_id, to_raw, cc_raw, bcc_raw, provider_recipients_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(accountId, draftId, fields.to, fields.cc, fields.bcc, draftRecipientSignature(draft));
  }

  getDraftRecipientFields(accountId: string, draftId: string): DraftRecipientFields | undefined {
    const row = this.db
      .prepare(
        `SELECT to_raw, cc_raw, bcc_raw, provider_recipients_json
         FROM draft_recipient_fields
         WHERE account_id = ? AND draft_id = ?`,
      )
      .get(accountId, draftId) as
      | {
          to_raw: string;
          cc_raw: string;
          bcc_raw: string;
          provider_recipients_json: string;
        }
      | undefined;
    if (!row) return undefined;
    const message = this.db
      .prepare(
        `SELECT payload_json
         FROM messages
         WHERE account_id = ? AND json_extract(payload_json, '$.draftId') = ?
         ORDER BY date DESC, rowid DESC
         LIMIT 1`,
      )
      .get(accountId, draftId) as { payload_json: string } | undefined;
    if (
      !message ||
      row.provider_recipients_json !==
        draftRecipientSignature(JSON.parse(message.payload_json) as Message)
    ) {
      this.deleteDraftRecipientFields(accountId, draftId);
      return undefined;
    }
    return row ? { to: row.to_raw, cc: row.cc_raw, bcc: row.bcc_raw } : undefined;
  }

  deleteDraftRecipientFields(accountId: string, draftId: string): void {
    this.db
      .prepare("DELETE FROM draft_recipient_fields WHERE account_id = ? AND draft_id = ?")
      .run(accountId, draftId);
  }

  reconcileFolderPage(
    account: AccountInfo,
    role: FolderRole,
    messages: Message[],
    complete: boolean,
  ): number {
    const returnedIds = new Set(messages.map((message) => message.id));
    const oldestDate = messages.reduce<string | undefined>(
      (oldest, message) => (!oldest || message.date < oldest ? message.date : oldest),
      undefined,
    );
    if (!complete && !oldestDate) return 0;
    const rows = this.db
      .prepare(
        `SELECT message_id, thread_id, payload_json
         FROM messages
         WHERE account_id = ?
           AND json_extract(payload_json, '$.folder.role') = ?
           ${complete ? "" : "AND date >= ?"}`,
      )
      .all(...(complete ? [account.id, role] : [account.id, role, oldestDate])) as Array<{
      message_id: string;
      thread_id: string;
      payload_json: string;
    }>;
    const stale = rows.filter((row) => !returnedIds.has(row.message_id));
    if (!stale.length) return 0;
    const update = this.db.prepare(
      "UPDATE messages SET payload_json = ? WHERE account_id = ? AND message_id = ?",
    );
    const threadIds = new Set<string>();
    this.db.transaction(() => {
      for (const row of stale) {
        const message = JSON.parse(row.payload_json) as Message;
        delete message.folder;
        update.run(JSON.stringify(message), account.id, row.message_id);
        threadIds.add(row.thread_id);
      }
      for (const threadId of threadIds) {
        this.invalidateThreadBody(account.id, threadId);
        this.rebuildThread(account, threadId);
      }
    })();
    return stale.length;
  }

  reconcileCompleteView(account: AccountInfo, viewKey: string, role: FolderRole): number {
    const rows = this.db
      .prepare(
        `SELECT message_id, thread_id, payload_json
         FROM messages
         WHERE account_id = ?
           AND json_extract(payload_json, '$.folder.role') = ?
           AND NOT EXISTS (
             SELECT 1 FROM view_results
             WHERE view_results.account_id = messages.account_id
               AND view_results.view_key = ?
               AND view_results.thread_id = messages.thread_id
           )`,
      )
      .all(account.id, role, viewKey) as Array<{
      message_id: string;
      thread_id: string;
      payload_json: string;
    }>;
    if (!rows.length) return 0;
    const update = this.db.prepare(
      "UPDATE messages SET payload_json = ? WHERE account_id = ? AND message_id = ?",
    );
    const threadIds = new Set<string>();
    this.db.transaction(() => {
      for (const row of rows) {
        const message = JSON.parse(row.payload_json) as Message;
        delete message.folder;
        update.run(JSON.stringify(message), account.id, row.message_id);
        threadIds.add(row.thread_id);
      }
      for (const threadId of threadIds) {
        this.invalidateThreadBody(account.id, threadId);
        this.rebuildThread(account, threadId);
      }
    })();
    return rows.length;
  }

  deleteAccount(accountId: string): void {
    this.db.transaction(() => {
      for (const table of [
        "messages",
        "threads",
        "thread_bodies",
        "folders",
        "page_tokens",
        "view_results",
        "notification_seen",
        "notification_state",
        "draft_recipient_fields",
        "thread_mutation_owners",
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
      }
      this.db.prepare("DELETE FROM thread_search WHERE key LIKE ?").run(`${accountId}:%`);
    })();
  }

  getPageState(accountId: string, viewKey: string): { initialized: boolean; nextToken?: string } {
    const row = this.db
      .prepare("SELECT page_token FROM page_tokens WHERE account_id = ? AND view_key = ?")
      .get(accountId, viewKey) as { page_token: string | null } | undefined;
    if (!row) return { initialized: false };
    return {
      initialized: true,
      ...(row.page_token ? { nextToken: row.page_token } : {}),
    };
  }

  setPageToken(accountId: string, viewKey: string, token?: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO page_tokens(account_id, view_key, page_token) VALUES (?, ?, ?)",
      )
      .run(accountId, viewKey, token ?? null);
  }

  invalidateThread(accountId: string, threadId: string): void {
    this.invalidateThreadBody(accountId, threadId);
  }

  recordInboxPage(
    accountId: string,
    messages: Message[],
  ): { initialized: boolean; newMessages: Message[] } {
    const state = this.db
      .prepare("SELECT initialized_at, max_date FROM notification_state WHERE account_id = ?")
      .get(accountId) as { initialized_at: number; max_date: string | null } | undefined;
    const initialized = Boolean(state);
    const incoming = messages.filter(
      (message) => message.folder?.role === "inbox" && !message.flags.draft,
    );
    let unseen: Message[] = [];
    let watermarkTime: number | undefined;
    let watermarkDate: string | undefined;
    if (initialized) {
      // Watermark against the newest previously seen message so paged-out
      // mail sliding into the first page (e.g. after archiving) is not
      // treated as new. Without this, archiving the newest N messages pulls
      // older, never-seen IDs into view and fires false notifications.
      watermarkDate = state?.max_date ?? undefined;
      if (watermarkDate) {
        const parsed = Date.parse(watermarkDate);
        if (!Number.isNaN(parsed)) watermarkTime = parsed;
        else watermarkDate = undefined;
      }
      if (watermarkDate === undefined) {
        // Upgrade path for databases created before max_date existed.
        const legacy = this.db
          .prepare(
            `SELECT MAX(date) AS max_date FROM messages
             WHERE account_id = ?
               AND message_id IN (
                 SELECT message_id FROM notification_seen WHERE account_id = ?
               )`,
          )
          .get(accountId, accountId) as { max_date: string | null } | undefined;
        if (legacy?.max_date && !Number.isNaN(Date.parse(legacy.max_date))) {
          watermarkDate = legacy.max_date;
          watermarkTime = Date.parse(legacy.max_date);
        }
      }
      const seen = this.db.prepare(
        "SELECT 1 FROM notification_seen WHERE account_id = ? AND message_id = ?",
      );
      const hasWatermark = watermarkTime !== undefined;
      unseen = incoming.filter((message) => {
        if (seen.get(accountId, message.id)) return false;
        if (!hasWatermark) return true;
        const messageTime = Date.parse(message.date);
        // If either date is unparseable, fall back to notifying rather than
        // silently dropping what may be genuine new mail.
        if (Number.isNaN(messageTime)) return true;
        return messageTime >= (watermarkTime as number);
      });
    }
    let nextWatermarkDate = watermarkDate;
    let nextWatermarkTime = watermarkTime;
    for (const message of incoming) {
      const messageTime = Date.parse(message.date);
      if (Number.isNaN(messageTime)) continue;
      if (nextWatermarkTime === undefined || messageTime > nextWatermarkTime) {
        nextWatermarkTime = messageTime;
        nextWatermarkDate = message.date;
      }
    }
    const insert = this.db.prepare(
      `INSERT INTO notification_seen(account_id, message_id, seen_at)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id, message_id) DO UPDATE SET seen_at = excluded.seen_at`,
    );
    // Compare against the stored value, not the computed watermark: the legacy
    // MAX(date) fallback must be persisted even when no newer mail arrives,
    // otherwise upgraded DBs re-run the fallback every refresh.
    const storedMaxDate = state?.max_date ?? undefined;
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO notification_state(account_id, initialized_at) VALUES (?, ?)",
        )
        .run(accountId, Date.now());
      if (nextWatermarkDate !== storedMaxDate || !initialized) {
        this.db
          .prepare("UPDATE notification_state SET max_date = ? WHERE account_id = ?")
          .run(nextWatermarkDate ?? null, accountId);
      }
      for (const message of incoming) insert.run(accountId, message.id, Date.now());
      this.db
        .prepare("DELETE FROM notification_seen WHERE account_id = ? AND seen_at < ?")
        .run(accountId, Date.now() - 30 * 24 * 60 * 60 * 1000);
    })();
    return { initialized, newMessages: unseen };
  }

  private searchKeys(query: string, limit: number): string[] {
    const cleaned = query
      .trim()
      .split(/\s+/)
      .map((term) => `"${term.replaceAll('"', '""')}"*`)
      .join(" ");
    if (!cleaned) return [];
    try {
      return (
        this.db
          .prepare("SELECT key FROM thread_search WHERE thread_search MATCH ? LIMIT ?")
          .all(cleaned, limit) as Array<{
          key: string;
        }>
      ).map((row) => row.key);
    } catch {
      return [];
    }
  }

  private rebuildThread(account: AccountInfo, threadId: string, mutationId?: string): void {
    const owner = this.db
      .prepare(
        `SELECT mutation_id FROM thread_mutation_owners
         WHERE account_id = ? AND thread_id = ?`,
      )
      .get(account.id, threadId) as { mutation_id: string } | undefined;
    if (owner && owner.mutation_id !== mutationId) return;
    const messages = (
      this.db
        .prepare(
          "SELECT payload_json FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY date ASC",
        )
        .all(account.id, threadId) as Array<{ payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json) as Message);
    if (!messages.length) {
      this.hideThread(account.id, threadId);
      this.invalidateThreadBody(account.id, threadId);
      return;
    }
    const latest = messages.at(-1)!;
    const labels = [...new Set(messages.flatMap((message) => message.labels ?? []))];
    const roles = [
      ...new Set(
        messages
          .map((message) => message.folder?.role)
          .filter((role): role is FolderRole => Boolean(role)),
      ),
    ];
    const row: CachedThreadRow = {
      account_id: account.id,
      thread_id: threadId,
      account_email: account.email,
      subject: latest.subject || "(no subject)",
      sender_name: latest.from?.name || latest.from?.email || "Unknown sender",
      sender_email: latest.from?.email || "",
      snippet: latest.snippet || "",
      date: latest.date,
      unread: messages.some((message) => !message.flags.read) ? 1 : 0,
      starred: messages.some((message) => message.flags.starred) ? 1 : 0,
      draft: messages.some((message) => message.flags.draft) ? 1 : 0,
      has_attachments: messages.some((message) => Boolean(message.attachments?.length)) ? 1 : 0,
      message_count: messages.length,
      labels_json: JSON.stringify(labels),
      folder_roles_json: JSON.stringify(roles),
    };
    this.writeThread(row);
  }

  private writeThread(row: CachedThreadRow): void {
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO threads(
          account_id, thread_id, account_email, subject, sender_name, sender_email, snippet, date,
          unread, starred, draft, has_attachments, message_count, labels_json, folder_roles_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(...Object.values(row));
    const key = `${row.account_id}:${row.thread_id}`;
    this.db.prepare("DELETE FROM thread_search WHERE key = ?").run(key);
    this.db
      .prepare(
        "INSERT INTO thread_search(key, subject, sender_name, sender_email, snippet) VALUES (?, ?, ?, ?, ?)",
      )
      .run(key, row.subject, row.sender_name, row.sender_email, row.snippet);
  }

  private deleteThread(accountId: string, threadId: string): void {
    this.hideThread(accountId, threadId);
    this.db
      .prepare("DELETE FROM messages WHERE account_id = ? AND thread_id = ?")
      .run(accountId, threadId);
    this.db
      .prepare("DELETE FROM thread_bodies WHERE account_id = ? AND thread_id = ?")
      .run(accountId, threadId);
  }

  private invalidateThreadBody(accountId: string, threadId: string): void {
    this.db
      .prepare("DELETE FROM thread_bodies WHERE account_id = ? AND thread_id = ?")
      .run(accountId, threadId);
  }

  private hideThread(accountId: string, threadId: string): void {
    this.db
      .prepare("DELETE FROM threads WHERE account_id = ? AND thread_id = ?")
      .run(accountId, threadId);
    this.db.prepare("DELETE FROM thread_search WHERE key = ?").run(`${accountId}:${threadId}`);
  }

  private removeRole(accountId: string, threadId: string, role: string): void {
    const row = this.snapshotThread(accountId, threadId);
    if (!row) return;
    row.folder_roles_json = JSON.stringify(
      (JSON.parse(row.folder_roles_json) as string[]).filter((item) => item !== role),
    );
    this.writeThread(row);
  }

  private replaceRoles(accountId: string, threadId: string, roles: string[]): void {
    const row = this.snapshotThread(accountId, threadId);
    if (!row) return;
    row.folder_roles_json = JSON.stringify(roles);
    this.writeThread(row);
  }

  private updateLabels(
    accountId: string,
    threadId: string,
    added: string[],
    removed: string[],
  ): void {
    const row = this.snapshotThread(accountId, threadId);
    if (!row) return;
    const labels = new Set(JSON.parse(row.labels_json) as string[]);
    for (const label of added) labels.add(label);
    for (const label of removed) labels.delete(label);
    row.labels_json = JSON.stringify([...labels]);
    this.writeThread(row);
  }

  private toMailThread(account: AccountInfo, thread: Thread): MailThread {
    return {
      id: thread.id,
      accountId: account.id,
      accountEmail: account.email,
      subject: thread.subject,
      messages: thread.messages.map((message) => ({
        ...message,
        folderRole: message.folder?.role,
      })),
    };
  }
}

function toSummary(row: CachedThreadRow): ThreadSummary {
  return {
    id: row.thread_id,
    accountId: row.account_id,
    accountEmail: row.account_email,
    subject: row.subject,
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    snippet: row.snippet,
    date: row.date,
    unread: Boolean(row.unread),
    starred: Boolean(row.starred),
    draft: Boolean(row.draft),
    hasAttachments: Boolean(row.has_attachments),
    messageCount: row.message_count,
    labels: JSON.parse(row.labels_json) as string[],
    folderRoles: JSON.parse(row.folder_roles_json) as string[],
  };
}

function scheduledDraftKey(accountId: string, draftId: string): string {
  return JSON.stringify([accountId, draftId]);
}

function draftRecipientSignature(draft: Pick<Message, "to" | "cc" | "bcc">): string {
  const signature = (addresses: Message["to"] | undefined) =>
    (addresses ?? []).map((address) => [
      address.email.trim().toLowerCase(),
      address.name?.trim() ?? "",
    ]);
  return JSON.stringify({
    to: signature(draft.to),
    cc: signature(draft.cc),
    bcc: signature(draft.bcc),
  });
}

function addScheduledDraftExclusion(
  conditions: string[],
  params: Array<string | number>,
  scheduledDrafts: ScheduledDraftRef[] | undefined,
): void {
  if (!scheduledDrafts?.length) return;
  conditions.push(`EXISTS (
    SELECT 1
    FROM messages AS draft_messages
    WHERE draft_messages.account_id = threads.account_id
      AND draft_messages.thread_id = threads.thread_id
      AND json_extract(draft_messages.payload_json, '$.flags.draft') = 1
      AND json_array(
        draft_messages.account_id,
        json_extract(draft_messages.payload_json, '$.draftId')
      ) NOT IN (SELECT value FROM json_each(?))
  )`);
  params.push(
    JSON.stringify(
      scheduledDrafts.map((draft) => JSON.stringify([draft.accountId, draft.draftId])),
    ),
  );
}

function addFolderRoleCondition(
  conditions: string[],
  params: Array<string | number>,
  role: string,
  scheduledDrafts: ScheduledDraftRef[] | undefined,
): void {
  const pendingSendKeys = pendingScheduledDraftKeys(scheduledDrafts);
  if (role !== "sent" || !pendingSendKeys.length) {
    conditions.push("folder_roles_json LIKE ?");
    params.push(`%"${role}"%`);
    return;
  }
  conditions.push(`(
    folder_roles_json LIKE ? OR ${pendingSendThreadCondition("pending_messages")}
  )`);
  params.push(`%"${role}"%`, JSON.stringify(pendingSendKeys));
}

function addResultSetCondition(
  conditions: string[],
  params: Array<string | number>,
  resultSetKey: string,
  view: MailboxView,
  scheduledDrafts: ScheduledDraftRef[] | undefined,
): void {
  const pendingSendKeys = view === "sent" ? pendingScheduledDraftKeys(scheduledDrafts) : [];
  conditions.push(`(
    EXISTS (
      SELECT 1 FROM view_results
      WHERE view_results.account_id = threads.account_id
        AND view_results.thread_id = threads.thread_id
        AND view_results.view_key = ?
    )${pendingSendKeys.length ? ` OR ${pendingSendThreadCondition("pending_results")}` : ""}
  )`);
  params.push(resultSetKey);
  if (pendingSendKeys.length) params.push(JSON.stringify(pendingSendKeys));
}

function pendingScheduledDraftKeys(scheduledDrafts: ScheduledDraftRef[] | undefined): string[] {
  return (scheduledDrafts ?? [])
    .filter((draft) => draft.pendingSend)
    .map((draft) => scheduledDraftKey(draft.accountId, draft.draftId));
}

function pendingSendThreadCondition(messageAlias: string): string {
  return `EXISTS (
    SELECT 1
    FROM messages AS ${messageAlias}
    WHERE ${messageAlias}.account_id = threads.account_id
      AND ${messageAlias}.thread_id = threads.thread_id
      AND json_array(
        ${messageAlias}.account_id,
        json_extract(${messageAlias}.payload_json, '$.draftId')
      ) IN (SELECT value FROM json_each(?))
  )`;
}

function viewFolderRole(view: MailboxView): string | undefined {
  if (
    view === "all" ||
    view === "starred" ||
    view === "scheduled" ||
    view === "label" ||
    view === "search"
  )
    return undefined;
  return view;
}
