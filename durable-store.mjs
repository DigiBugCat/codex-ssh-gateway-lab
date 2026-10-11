import { DatabaseSync } from 'node:sqlite';

// Deterministic local state machine. External side effects must NOT be placed
// inside this transaction and described as exactly-once.
export class DurableStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS operations (
        agent_id TEXT NOT NULL, op_id TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('accepted','completed')), result TEXT,
        PRIMARY KEY(agent_id,op_id));
      CREATE TABLE IF NOT EXISTS events (
        agent_id TEXT NOT NULL, revision INTEGER NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY(agent_id,revision));`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  submit({ agentId, operationId, text }, checkpoint = () => {}) {
    for (const value of [agentId, operationId]) if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw Error('Invalid identity');
    if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw Error('Invalid text');
    const payload = JSON.stringify({ text });
    const saved = this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM operations WHERE agent_id=? AND op_id=?').get(agentId, operationId);
      if (old && old.payload !== payload) throw Error('Operation ID conflict');
      if (old) return old;
      this.db.prepare('INSERT OR IGNORE INTO agents(id) VALUES(?)').run(agentId);
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,'accepted',NULL)").run(agentId, operationId, payload);
      return null;
    });
    if (saved?.state === 'completed') return JSON.parse(saved.result);
    checkpoint('accepted');
    return this.transaction(() => {
      // Recheck while holding the write lock: another activation may have
      // completed this operation after the accepted checkpoint.
      const old = this.db.prepare('SELECT * FROM operations WHERE agent_id=? AND op_id=?').get(agentId, operationId);
      if (old.state === 'completed') return JSON.parse(old.result);
      const { revision } = this.db.prepare('UPDATE agents SET revision=revision+1 WHERE id=? RETURNING revision').get(agentId);
      this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(agentId, revision, text);
      const result = { agentId, operationId, revision, text };
      this.db.prepare("UPDATE operations SET state='completed',result=? WHERE agent_id=? AND op_id=?").run(JSON.stringify(result), agentId, operationId);
      checkpoint('beforeCommit');
      return result;
    });
  }
  read(agentId) {
    const agent = this.db.prepare('SELECT * FROM agents WHERE id=?').get(agentId);
    if (!agent) return { agentId, revision: 0, events: [] };
    return { agentId, revision: agent.revision, events: this.db.prepare('SELECT revision,text FROM events WHERE agent_id=? ORDER BY revision').all(agentId) };
  }
  pending() {
    return this.db.prepare("SELECT agent_id,op_id,payload FROM operations WHERE state='accepted' ORDER BY agent_id,op_id").all()
      .map(row => ({ agentId: row.agent_id, operationId: row.op_id, ...JSON.parse(row.payload) }));
  }
  recover() { return this.pending().map(op => this.submit(op)); }
}
