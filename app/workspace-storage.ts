import type { CustomerItem, DocumentItem, PersistedDocument, WorkspaceSnapshot } from "./workspace-types";

const DATABASE_NAME = "ocr-workspace";
const DATABASE_VERSION = 1;
const WORKSPACE_STORE = "workspace";
const SOURCE_STORE = "sources";
const ACTIVE_WORKSPACE_KEY = "active";

type StoredSource = { id: string; blob: Blob };

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onerror = () => reject(request.error || new Error("Unable to open workspace storage"));
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(WORKSPACE_STORE)) database.createObjectStore(WORKSPACE_STORE);
    if (!database.objectStoreNames.contains(SOURCE_STORE)) database.createObjectStore(SOURCE_STORE, { keyPath: "id" });
  };
  request.onsuccess = () => resolve(request.result);
});

const requestValue = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("Workspace storage request failed"));
});

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error || new Error("Workspace storage transaction failed"));
  transaction.onabort = () => reject(transaction.error || new Error("Workspace storage transaction was aborted"));
});

export async function saveWorkspace(customers: CustomerItem[], documents: DocumentItem[], nextCustomerSequence: number) {
  const database = await openDatabase();
  try {
    const readTransaction = database.transaction(SOURCE_STORE, "readonly");
    const existingSourceIds = new Set((await requestValue(readTransaction.objectStore(SOURCE_STORE).getAllKeys())).map(String));
    await transactionDone(readTransaction);
    const transaction = database.transaction([WORKSPACE_STORE, SOURCE_STORE], "readwrite");
    const workspaceStore = transaction.objectStore(WORKSPACE_STORE);
    const sourceStore = transaction.objectStore(SOURCE_STORE);
    const currentSourceIds = new Set<string>();

    for (const document of documents) {
      currentSourceIds.add(document.sourceId);
      if (!existingSourceIds.has(document.sourceId)) {
        sourceStore.put({ id: document.sourceId, blob: document.sourceBlob } satisfies StoredSource);
      }
    }
    for (const sourceId of existingSourceIds) {
      if (!currentSourceIds.has(sourceId)) sourceStore.delete(sourceId);
    }

    const snapshot: WorkspaceSnapshot = {
      version: 1,
      nextCustomerSequence,
      customers,
      documents: documents.map((document) => Object.fromEntries(
        Object.entries(document).filter(([key]) => key !== "src" && key !== "sourceBlob"),
      ) as PersistedDocument),
    };
    workspaceStore.put(snapshot, ACTIVE_WORKSPACE_KEY);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function loadWorkspace() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([WORKSPACE_STORE, SOURCE_STORE], "readonly");
    const snapshotRequest = requestValue(transaction.objectStore(WORKSPACE_STORE).get(ACTIVE_WORKSPACE_KEY)) as Promise<WorkspaceSnapshot | undefined>;
    const sourcesRequest = requestValue(transaction.objectStore(SOURCE_STORE).getAll()) as Promise<StoredSource[]>;
    const [snapshot, sources] = await Promise.all([snapshotRequest, sourcesRequest]);
    if (!snapshot || snapshot.version !== 1) return null;
    await transactionDone(transaction);
    return { snapshot, sources: new Map(sources.map((source) => [source.id, source.blob])) };
  } finally {
    database.close();
  }
}

export async function clearWorkspaceStorage() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([WORKSPACE_STORE, SOURCE_STORE], "readwrite");
    transaction.objectStore(WORKSPACE_STORE).clear();
    transaction.objectStore(SOURCE_STORE).clear();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function requestPersistentWorkspaceStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}

export async function estimateWorkspaceStorage() {
  if (!navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage || 0, quota: estimate.quota || 0 };
}
