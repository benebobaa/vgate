/** Read access to a MongoDB database, for asserting the documents a call wrote (or did not write). */
import { MongoClient, type Document, type Filter } from 'mongodb';

export class MongoDocs {
  private constructor(
    private readonly client: MongoClient,
    private readonly database: string,
  ) {}

  /** `mongodb://user:password@host:port/database?authSource=admin`; the database comes from the URL's path. */
  static async connect(url: string): Promise<MongoDocs> {
    const database = new URL(url).pathname.replace(/^\//, '') || 'test';
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    return new MongoDocs(client, database);
  }

  private collection(name: string) {
    return this.client.db(this.database).collection(name);
  }

  find(collection: string, filter: Filter<Document> = {}): Promise<Document[]> {
    return this.collection(collection).find(filter).toArray();
  }

  findOne(collection: string, filter: Filter<Document>): Promise<Document | null> {
    return this.collection(collection).findOne(filter);
  }

  count(collection: string, filter: Filter<Document> = {}): Promise<number> {
    return this.collection(collection).countDocuments(filter);
  }

  /** The first document matching `filter`, waiting up to `timeoutMs` (for writes made after the answer). */
  async expectDocument(collection: string, filter: Filter<Document>, { timeoutMs = 10_000 } = {}): Promise<Document> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await this.findOne(collection, filter);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(`No document in ${collection} matching ${JSON.stringify(filter)} after ${timeoutMs} ms`);
      await new Promise((done) => setTimeout(done, 250));
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
