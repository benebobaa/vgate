/**
 * The inbox of a `mailpit` dependency: every message the service sent, read through Mailpit's HTTP API. For asserting
 * that a verification mail went out, to whom, and for following the link in it.
 */
import { frameworkFetch, type DependencyGuard } from '../http/write-guard.ts';

export interface MailSummary {
  id: string;
  subject: string;
  from: string;
  to: string[];
  created: string;
}

export interface MailMessage extends MailSummary {
  text: string;
  html: string;
  /** Every http(s) link in the message, text and HTML, in order, without duplicates. */
  links: string[];
}

interface RawAddress {
  Address?: string;
}
interface RawSummary {
  ID: string;
  Subject?: string;
  From?: RawAddress;
  To?: RawAddress[];
  Created?: string;
}

const summary = (raw: RawSummary): MailSummary => ({
  id: raw.ID,
  subject: raw.Subject ?? '',
  from: raw.From?.Address ?? '',
  to: (raw.To ?? []).map((address) => address.Address ?? ''),
  created: raw.Created ?? '',
});

/** http(s) links in a text or HTML body; HTML entities in href values are decoded. */
export function linksIn(...bodies: string[]): string[] {
  const found: string[] = [];
  for (const body of bodies) {
    for (const match of body.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
      const link = match[0].replace(/&amp;/g, '&').replace(/[.,;:!?]+$/, '');
      if (!found.includes(link)) found.push(link);
    }
  }
  return found;
}

export interface MailQuery {
  /** Recipient address (exact, case-insensitive). */
  to?: string;
  /** Text the subject contains. */
  subject?: string;
}

export class Inbox {
  private readonly api: string;

  /** `guard` runs before `clear` (`<dependency>:delete`); reading the inbox is never guarded. */
  constructor(
    apiUrl: string,
    private readonly guard: DependencyGuard = () => undefined,
  ) {
    this.api = apiUrl.replace(/\/$/, '');
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await frameworkFetch(`${this.api}${path}`, init);
    if (!res.ok) throw new Error(`Mailpit ${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** The newest messages first (up to 200). */
  async messages(): Promise<MailSummary[]> {
    const page = await this.json<{ messages?: RawSummary[] }>('/api/v1/messages?limit=200');
    return (page.messages ?? []).map(summary);
  }

  async read(id: string): Promise<MailMessage> {
    const raw = await this.json<RawSummary & { Text?: string; HTML?: string }>(
      `/api/v1/message/${encodeURIComponent(id)}`,
    );
    const text = raw.Text ?? '';
    const html = raw.HTML ?? '';
    return { ...summary(raw), text, html, links: linksIn(text, html) };
  }

  /** The newest message matching `query`, waiting up to `timeoutMs` for it (the service may send after answering). */
  async expectMessage(query: MailQuery, { timeoutMs = 10_000 } = {}): Promise<MailMessage> {
    const deadline = Date.now() + timeoutMs;
    const to = query.to?.toLowerCase();
    for (;;) {
      const hit = (await this.messages()).find(
        (m) =>
          (!to || m.to.some((address) => address.toLowerCase() === to)) &&
          (!query.subject || m.subject.includes(query.subject)),
      );
      if (hit) return this.read(hit.id);
      if (Date.now() > deadline) throw new Error(`No mail matching ${JSON.stringify(query)} after ${timeoutMs} ms`);
      await new Promise((done) => setTimeout(done, 250));
    }
  }

  /** No message to `to` arrives within `withinMs` (for "a rejected request sends nothing"). */
  async expectNone(query: MailQuery, { withinMs = 2_000 } = {}): Promise<void> {
    await new Promise((done) => setTimeout(done, withinMs));
    const to = query.to?.toLowerCase();
    const hit = (await this.messages()).find(
      (m) =>
        (!to || m.to.some((address) => address.toLowerCase() === to)) &&
        (!query.subject || m.subject.includes(query.subject)),
    );
    if (hit)
      throw new Error(
        `Expected no mail matching ${JSON.stringify(query)}, got "${hit.subject}" to ${hit.to.join(', ')}`,
      );
  }

  /** Deletes every message (disposable environments only: it is the whole inbox, not the test's). */
  async clear(): Promise<void> {
    this.guard('delete');
    const res = await frameworkFetch(`${this.api}/api/v1/messages`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Mailpit DELETE /api/v1/messages: ${res.status}`);
  }
}
