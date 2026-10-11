export class Rpc {
  constructor(send) { this.send = send; this.id = 0; this.pending = new Map(); this.events = []; this.waiters = []; }
  receive(raw) {
    const value = JSON.parse(raw);
    if (this.pending.has(value.id)) {
      const { resolve, reject, timer } = this.pending.get(value.id); clearTimeout(timer); this.pending.delete(value.id);
      value.error ? reject(new Error(JSON.stringify(value.error))) : resolve(value.result);
    } else {
      this.events.push(value);
      for (const w of [...this.waiters]) if (w.predicate(value)) { clearTimeout(w.timer); this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(value); }
    }
  }
  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Timeout: ${method}`)); }, 8000);
      this.pending.set(id, { resolve, reject, timer }); this.send(JSON.stringify({ id, method, params }));
    });
  }
  notify(method, params = {}) { this.send(JSON.stringify({ method, params })); }
  wait(predicate) {
    const found = this.events.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(Error('Event timeout')); }, 8000) };
      this.waiters.push(w);
    });
  }
}
