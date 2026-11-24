// Minimal in-memory IndexedDB double shared by the Outbox tests.
class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
}

class FakeObjectStore {
  constructor(database, name, transaction = null) {
    this.database = database;
    this.name = name;
    this.transaction = transaction;
  }

  get(key) {
    return this.run(() => structuredClone(this.database.stores.get(this.name).values.get(key)));
  }

  getAll() {
    return this.run(() => {
      const values = this.database.stores.get(this.name).values;
      return Array.from(values.values(), (item) => structuredClone(item));
    });
  }

  add(value) {
    return this.run(() => {
      if (this.database.fake.failNextAdd) {
        const error = this.database.fake.failNextAdd;
        this.database.fake.failNextAdd = null;
        throw error;
      }
      const store = this.database.stores.get(this.name);
      const key = value[store.keyPath];
      if (store.values.has(key)) {
        const error = new Error("Duplicate key");
        error.name = "ConstraintError";
        throw error;
      }
      store.values.set(key, structuredClone(value));
      return key;
    });
  }

  put(value) {
    return this.run(() => {
      const store = this.database.stores.get(this.name);
      const key = value[store.keyPath];
      store.values.set(key, structuredClone(value));
      return key;
    });
  }

  delete(key) {
    return this.run(() => this.database.stores.get(this.name).values.delete(key));
  }

  run(operation) {
    if (this.transaction) {
      return this.transaction.enqueue(operation);
    }
    const request = new FakeRequest();
    request.result = operation();
    return request;
  }
}

class FakeTransaction {
  constructor(database, storeNames, mode) {
    this.database = database;
    this.storeNames = Array.isArray(storeNames) ? storeNames : [storeNames];
    this.mode = mode;
    this.pending = 0;
    this.aborted = false;
    this.completed = false;
    this.completionScheduled = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.snapshots = new Map();
    if (mode === "readwrite") {
      for (const name of this.storeNames) {
        const store = database.stores.get(name);
        this.snapshots.set(name, new Map(Array.from(store.values, ([key, value]) => [key, structuredClone(value)])));
      }
    }
  }

  objectStore(name) {
    if (!this.storeNames.includes(name)) {
      throw new Error("Object store outside transaction scope");
    }
    return new FakeObjectStore(this.database, name, this);
  }

  enqueue(operation) {
    const request = new FakeRequest();
    this.pending += 1;
    queueMicrotask(() => {
      if (this.aborted) {
        this.pending -= 1;
        return;
      }
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        this.error = error;
        request.onerror?.({ target: request });
        if (!this.aborted) {
          this.abort(error);
        }
      }
      this.pending -= 1;
      this.scheduleCompletion();
    });
    return request;
  }

  abort(error = null) {
    if (this.aborted || this.completed) {
      throw new Error("Transaction is no longer active");
    }
    this.aborted = true;
    this.error = error || this.error;
    for (const [name, snapshot] of this.snapshots) {
      this.database.stores.get(name).values = new Map(snapshot);
    }
    queueMicrotask(() => this.onabort?.({ target: this }));
  }

  scheduleCompletion() {
    if (this.aborted || this.completed || this.pending !== 0 || this.completionScheduled) {
      return;
    }
    this.completionScheduled = true;
    queueMicrotask(() => {
      this.completionScheduled = false;
      if (this.aborted || this.completed || this.pending !== 0) {
        return;
      }
      this.completed = true;
      this.oncomplete?.({ target: this });
    });
  }
}

class FakeDatabase {
  constructor(fake) {
    this.fake = fake;
    this.stores = new Map();
    this.objectStoreNames = { contains: (name) => this.stores.has(name) };
    this.onversionchange = null;
  }

  createObjectStore(name, { keyPath }) {
    this.stores.set(name, { keyPath, values: new Map() });
    return new FakeObjectStore(this, name);
  }

  transaction(storeNames, mode) {
    return new FakeTransaction(this, storeNames, mode);
  }

  close() {}
}

class FakeIndexedDB {
  constructor() {
    this.database = null;
    this.failNextAdd = null;
  }

  open() {
    const request = new FakeRequest();
    queueMicrotask(() => {
      try {
        const isNew = !this.database;
        if (isNew) {
          this.database = new FakeDatabase(this);
        }
        request.result = this.database;
        if (isNew) {
          request.onupgradeneeded?.({ target: request, oldVersion: 0, newVersion: 1 });
        }
        queueMicrotask(() => request.onsuccess?.({ target: request }));
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
      }
    });
    return request;
  }
}

module.exports = { FakeIndexedDB };
